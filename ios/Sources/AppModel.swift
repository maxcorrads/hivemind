import HivemindKit
import Observation
import SwiftUI
import UIKit
import WebKit

/// What all scenes share: the saved Macs (metadata in UserDefaults, tokens
/// in the Keychain), one device-session keeper per Mac, one web data store
/// per Mac, Bonjour discovery, notifications and the icon badge.
///
/// Each Mac's web views use a persistent WKWebsiteDataStore of their own,
/// keyed by the Mac's id: its device-session cookie and the page's local
/// storage never mix with another Mac's, all scenes of one Mac share one
/// cookie, and removing the Mac deletes the store.
@MainActor
@Observable
final class AppModel {
  private(set) var macs: [PairedMac] = []
  let discovery = DiscoveryBrowser()

  @ObservationIgnored let notifier = Notifier()
  @ObservationIgnored private let store: PairedMacStore
  @ObservationIgnored private let client = RemoteGatewayClient(transport: PinnedHTTPTransport())
  @ObservationIgnored private var keepers: [UUID: RemoteSessionKeeper] = [:]
  @ObservationIgnored private var dataStores: [UUID: WKWebsiteDataStore] = [:]
  @ObservationIgnored private var badge = RemoteBadgeAggregator()
  @ObservationIgnored private var scenes: [String: WeakScene] = [:]

  private static let lastMacKey = "lastMacID"

  init() {
    store = PairedMacStore(defaults: .standard, tokens: KeychainTokenStore())
    refresh()
    notifier.install()
    notifier.onOpen = { [weak self] target, windowID in self?.open(notice: target, windowID: windowID) }
  }

  // MARK: Macs

  func mac(_ id: UUID?) -> PairedMac? { id.flatMap { store.list.mac($0) } }

  /// The Mac a new scene shows: the one used last, else the first.
  var defaultMacID: UUID? {
    let last = UserDefaults.standard.string(forKey: Self.lastMacKey).flatMap(UUID.init(uuidString:))
    return mac(last)?.id ?? macs.first?.id
  }

  func didUse(_ id: UUID) {
    UserDefaults.standard.set(id.uuidString, forKey: Self.lastMacKey)
  }

  func pair(_ payload: PairingPayload, deviceName: String) async throws(RemoteClientError) -> PairedMac {
    let pairing = try await client.pair(payload, deviceName: deviceName, platform: .current)
    do {
      try store.add(pairing)
    } catch {
      throw .invalid(error.localizedDescription)
    }
    // Pairing the same Mac again replaced its entry: the old device id, its
    // session and its web data are void. Scenes showing it move to the new one.
    let replaced = macs.filter { $0.fingerprint == pairing.mac.fingerprint && $0.id != pairing.mac.id }.map(\.id)
    refresh()
    for old in replaced {
      let showing = scenes(showing: old)
      for scene in showing { scene.macWasRemoved() }
      keepers.removeValue(forKey: old)?.stop()
      dataStores[old] = nil
      badge.remove(mac: old)
      Task { try? await WKWebsiteDataStore.remove(forIdentifier: old) }
      for scene in showing { scene.connect(to: pairing.mac.id) }
    }
    didUse(pairing.mac.id)
    return pairing.mac
  }

  func rename(_ id: UUID, to name: String) -> Bool {
    let renamed = store.rename(id, to: name) != nil
    refresh()
    return renamed
  }

  /// Forgets a Mac on this device: its token, its session, its web data.
  /// The Mac still lists this device until it is revoked there.
  func remove(_ id: UUID) {
    for scene in scenes(showing: id) { scene.macWasRemoved() }
    keepers.removeValue(forKey: id)?.stop()
    store.remove(id)
    badge.remove(mac: id)
    notifier.setBadge(badge.count)
    dataStores[id] = nil
    refresh()
    // After the scenes let go of their web views: a store in use cannot go.
    Task { try? await WKWebsiteDataStore.remove(forIdentifier: id) }
  }

  private func refresh() {
    macs = store.macs
    discovery.wanted = Set(macs.map(\.fingerprint))
  }

  // MARK: Sessions

  func keeper(for id: UUID) -> RemoteSessionKeeper {
    if let keeper = keepers[id] { return keeper }
    let keeper = RemoteSessionKeeper(scheduler: MainQueueScheduler()) { [weak self] () async throws(RemoteClientError) -> RemoteDeviceSession in
      guard let self else { throw .unreachable("the app is closing") }
      return try await self.fetchSession(for: id)
    }
    keeper.onChange = { [weak self] session in
      Task { await self?.install(session, for: id) }
    }
    keeper.onRevoked = { [weak self] in
      guard let self else { return }
      for scene in self.scenes(showing: id) { scene.show(.revoked) }
    }
    keepers[id] = keeper
    return keeper
  }

  private func fetchSession(for id: UUID) async throws(RemoteClientError) -> RemoteDeviceSession {
    guard let mac = store.list.mac(id), let token = store.token(for: id) else {
      throw .gateway(GatewayError(.unauthorized, "This device is not paired with that Mac any more."))
    }
    // The host the current session came from first: the cookie is bound to
    // that origin, and the pages showing it stay on it. Then what Bonjour
    // found, then the saved hosts.
    let current = keepers[id]?.session.map { [$0.endpoint] } ?? []
    let session = try await client.session(mac, token: token, nearby: current + discovery.endpoints(for: mac.fingerprint))
    store.remember(session.endpoint, for: id)
    refresh()
    return session
  }

  /// Puts the session cookie where the Mac's web views read it. Setting it
  /// again replaces the previous session's (same name, host and path).
  func install(_ session: RemoteDeviceSession, for id: UUID) async {
    guard let cookie = session.cookie(at: Date()) else { return }
    await dataStore(for: id).httpCookieStore.setCookie(cookie)
  }

  func dataStore(for id: UUID) -> WKWebsiteDataStore {
    if let store = dataStores[id] { return store }
    let store = WKWebsiteDataStore(forIdentifier: id)
    dataStores[id] = store
    return store
  }

  // MARK: Scenes

  func register(_ scene: SceneController) {
    scenes = scenes.filter { $0.value.scene != nil }
    scenes[scene.windowID] = WeakScene(scene: scene)
  }

  func unregister(_ scene: SceneController) {
    scenes[scene.windowID] = nil
    badge.remove(scene: scene.windowID)
    notifier.setBadge(badge.count)
  }

  private func scenes(showing id: UUID) -> [SceneController] {
    scenes.values.compactMap(\.scene).filter { $0.macID == id }
  }

  func setBadge(_ count: Int, scene: String, mac: UUID) {
    badge.set(count, scene: scene, mac: mac)
    notifier.setBadge(badge.count)
  }

  func clearBadge(scene: String) {
    badge.remove(scene: scene)
    notifier.setBadge(badge.count)
  }

  /// A tapped notification: back to the scene that raised it when it is
  /// still there, else any scene.
  private func open(notice target: String?, windowID: String?) {
    let live = scenes.values.compactMap(\.scene)
    guard let scene = live.first(where: { $0.windowID == windowID }) ?? live.first else { return }
    scene.activate()
    if let target { scene.navigate(to: target) }
  }

  /// The whole app moved between foreground and background.
  func appPhaseChanged(_ phase: ScenePhase) {
    switch phase {
    case .active: discovery.start()
    case .background: discovery.stop()
    default: break
    }
  }
}

private struct WeakScene {
  weak var scene: SceneController?
}

extension DevicePlatform {
  /// iPadOS on an iPad, iOS otherwise: what the Mac's Devices… list shows.
  @MainActor static var current: DevicePlatform {
    UIDevice.current.userInterfaceIdiom == .pad ? .ipados : .ios
  }
}
