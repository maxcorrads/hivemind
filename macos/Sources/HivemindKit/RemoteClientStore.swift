import Foundation

// The Macs the iOS app has paired with. Their metadata (PairedMac: name,
// hosts, port, fingerprint) is plain JSON in the app's UserDefaults; each
// device token lives only in the Keychain, behind DeviceTokenStoring, which
// the app implements with Security and the tests fake.

/// Where device tokens are kept, keyed by PairedMac.id. The app's store is
/// the Keychain, readable after first unlock, on this device only, never
/// synced.
@MainActor
public protocol DeviceTokenStoring: AnyObject {
  func token(for id: UUID) -> DeviceToken?
  func save(_ token: DeviceToken, for id: UUID) throws
  func delete(for id: UUID)
}

/// The saved Macs, in the order the person sees them.
public struct PairedMacList: Equatable, Sendable, Codable {
  public private(set) var macs: [PairedMac]

  public init(_ macs: [PairedMac] = []) {
    self.macs = macs
  }

  public func mac(_ id: UUID) -> PairedMac? { macs.first { $0.id == id } }

  /// Adds a newly paired Mac at the top. A Mac with the same certificate
  /// (the same Hivemind Server paired again) replaces the old entry, whose
  /// device id the Mac has now superseded: its ids are returned so their
  /// tokens can be deleted.
  @discardableResult
  public mutating func add(_ mac: PairedMac) -> [UUID] {
    let replaced = macs.filter { $0.id == mac.id || $0.fingerprint == mac.fingerprint }.map(\.id)
    macs.removeAll { replaced.contains($0.id) }
    macs.insert(mac, at: 0)
    return replaced.filter { $0 != mac.id }
  }

  @discardableResult
  public mutating func remove(_ id: UUID) -> Bool {
    let count = macs.count
    macs.removeAll { $0.id == id }
    return macs.count != count
  }

  /// Renames a Mac on this device only. Nil when the name is not one a Mac
  /// may have (DeviceName); the stored name otherwise.
  @discardableResult
  public mutating func rename(_ id: UUID, to name: String) -> String? {
    guard let valid = DeviceName.validate(name, limit: GatewayLimits.maxMacNameCharacters),
          let index = macs.firstIndex(where: { $0.id == id }) else { return nil }
    macs[index].name = valid
    return valid
  }

  /// A host of this Mac just worked: try it first next time.
  public mutating func remember(_ endpoint: GatewayEndpoint, for id: UUID) {
    guard let index = macs.firstIndex(where: { $0.id == id }) else { return }
    macs[index].remember(endpoint)
  }

  /// The saved Macs a Bonjour advertisement belongs to: only its
  /// fingerprint counts (PairedMac.isAdvertised(by:)).
  public func macs(advertisedBy advertisement: GatewayAdvertisement) -> [PairedMac] {
    macs.filter { $0.isAdvertised(by: advertisement) }
  }
}

/// The saved Macs and their tokens together, so a Mac is never listed
/// without its token or the other way round.
@MainActor
public final class PairedMacStore {
  public static let defaultsKey = "pairedMacs"

  public private(set) var list: PairedMacList
  private let defaults: UserDefaults
  private let tokens: any DeviceTokenStoring

  public init(defaults: UserDefaults, tokens: any DeviceTokenStoring) {
    self.defaults = defaults
    self.tokens = tokens
    let decoded = defaults.data(forKey: Self.defaultsKey).flatMap { try? JSONDecoder().decode(PairedMacList.self, from: $0) }
    // A Mac whose token is gone (the Keychain was reset, or the app was
    // restored onto another device, where ThisDeviceOnly items do not
    // follow) cannot connect: drop it rather than show a dead entry.
    list = PairedMacList((decoded?.macs ?? []).filter { tokens.token(for: $0.id) != nil })
    if list != decoded { persist() }
  }

  public var macs: [PairedMac] { list.macs }

  public func token(for id: UUID) -> DeviceToken? { tokens.token(for: id) }

  /// Saves a pairing: the token first, so a crash in between leaves at
  /// worst an orphan token, never a Mac without one.
  public func add(_ pairing: RemotePairing) throws {
    try tokens.save(pairing.token, for: pairing.mac.id)
    for stale in list.add(pairing.mac) { tokens.delete(for: stale) }
    persist()
  }

  public func remove(_ id: UUID) {
    list.remove(id)
    tokens.delete(for: id)
    persist()
  }

  @discardableResult
  public func rename(_ id: UUID, to name: String) -> String? {
    let result = list.rename(id, to: name)
    if result != nil { persist() }
    return result
  }

  public func remember(_ endpoint: GatewayEndpoint, for id: UUID) {
    let before = list
    list.remember(endpoint, for: id)
    if list != before { persist() }
  }

  private func persist() {
    guard let data = try? JSONEncoder().encode(list) else { return }
    defaults.set(data, forKey: Self.defaultsKey)
  }
}
