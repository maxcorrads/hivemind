import Foundation
import Testing
@testable import HivemindKit

// RemoteSessionKeeper with a fake clock and a scripted fetch.

/// Lets queued main-actor work (the keeper's timer task) run.
@MainActor
func rcSettle() async {
  for _ in 0..<20 { await Task.yield() }
}

@MainActor
final class RCSessionSource {
  var results: [Result<RemoteDeviceSession, RemoteClientError>] = []
  var fetches = 0
  /// While set, a fetch waits for release().
  var gate: CheckedContinuation<Void, Never>?
  var holding = false
  let scheduler: FakeScheduler

  init(scheduler: FakeScheduler) { self.scheduler = scheduler }

  func session(expiresIn: TimeInterval = 3600) -> RemoteDeviceSession {
    RemoteDeviceSession(endpoint: GatewayEndpoint(host: "192.168.1.20", port: 7443)!, token: DeviceSessionToken.generate(),
                        expiresAt: scheduler.now().addingTimeInterval(expiresIn))
  }

  func fetch() async throws(RemoteClientError) -> RemoteDeviceSession {
    fetches += 1
    if holding { await withCheckedContinuation { gate = $0 } }
    let result = results.isEmpty ? .success(session()) : results.removeFirst()
    return try result.get()
  }

  func release() {
    holding = false
    gate?.resume()
    gate = nil
  }
}

@MainActor
struct RemoteSessionKeeperTests {
  let scheduler = FakeScheduler()
  let source: RCSessionSource
  let keeper: RemoteSessionKeeper

  init() {
    source = RCSessionSource(scheduler: scheduler)
    let source = source
    keeper = RemoteSessionKeeper(scheduler: scheduler) { () async throws(RemoteClientError) -> RemoteDeviceSession in try await source.fetch() }
  }

  @Test func keepsASessionUntilItNeedsRenewal() async throws {
    var changes: [RemoteDeviceSession] = []
    keeper.onChange = { changes.append($0) }
    let first = try await keeper.current()
    #expect(try await keeper.current() == first)
    #expect(source.fetches == 1)
    #expect(changes == [first])
    scheduler.clock = scheduler.clock.addingTimeInterval(1801)
    let second = try await keeper.current()
    #expect(second != first)
    #expect(source.fetches == 2)
    #expect(changes == [first, second])
  }

  @Test func concurrentAskersShareOneFetch() async throws {
    source.holding = true
    async let a = keeper.current()
    async let b = keeper.current()
    await rcSettle()
    source.release()
    let (first, second) = try await (a, b)
    #expect(first == second)
    #expect(source.fetches == 1)
  }

  @Test func renewsOnATimerAheadOfExpiry() async throws {
    var changes = 0
    keeper.onChange = { _ in changes += 1 }
    _ = try await keeper.current()
    #expect(scheduler.pending.map { $0.due.timeIntervalSince(scheduler.clock) } == [1800])
    scheduler.advance(1800)
    await rcSettle()
    #expect(source.fetches == 2)
    #expect(changes == 2)
  }

  @Test func keepsTheOldSessionWhenRenewalFailsAndRetries() async throws {
    let first = try await keeper.current()
    scheduler.clock = scheduler.clock.addingTimeInterval(2000)
    source.results = [.failure(.unreachable("asleep"))]
    #expect(try await keeper.current() == first)
    #expect(scheduler.pending.map { $0.due.timeIntervalSince(scheduler.clock) } == [RemoteSessionKeeper.retryAfterFailure])
    // Once it has expired, the failure is the answer.
    scheduler.clock = scheduler.clock.addingTimeInterval(1600)
    source.results = [.failure(.unreachable("asleep"))]
    await #expect(throws: RemoteClientError.unreachable("asleep")) { try await keeper.current() }
  }

  @Test func revocationStopsEverything() async throws {
    var revoked = 0
    keeper.onRevoked = { revoked += 1 }
    _ = try await keeper.current()
    keeper.invalidate()
    source.results = [.failure(.gateway(GatewayError(.unauthorized, "Unknown device.")))]
    await #expect(throws: RemoteClientError.self) { try await keeper.current() }
    #expect(revoked == 1)
    #expect(keeper.session == nil)
    #expect(scheduler.pending.isEmpty)
  }

  @Test func sceneActivationRenewsAllButABrandNewSession() async throws {
    let first = try await keeper.current()
    #expect(try await keeper.sceneDidBecomeActive() == first)
    scheduler.clock = scheduler.clock.addingTimeInterval(RemoteSessionKeeper.activationRenewAfter + 1)
    #expect(try await keeper.sceneDidBecomeActive() != first)
    #expect(source.fetches == 2)
  }

  @Test func invalidateForcesANewSession() async throws {
    let first = try await keeper.current()
    keeper.invalidate()
    #expect(try await keeper.current() != first)
  }

  @Test func stopForgetsAndCancelsTheTimer() async throws {
    _ = try await keeper.current()
    keeper.stop()
    #expect(keeper.session == nil)
    #expect(scheduler.pending.isEmpty)
  }
}

// MARK: - Saved Macs

@MainActor
final class RCTokenStore: DeviceTokenStoring {
  var tokens: [UUID: DeviceToken] = [:]
  var failSave = false

  func token(for id: UUID) -> DeviceToken? { tokens[id] }
  func save(_ token: DeviceToken, for id: UUID) throws {
    if failSave { throw RemoteClientError.invalid("keychain") }
    tokens[id] = token
  }
  func delete(for id: UUID) { tokens[id] = nil }
}

struct PairedMacListTests {
  @Test func pairingTheSameMacAgainReplacesIt() {
    var list = PairedMacList()
    let old = RCFixture.mac(id: UUID())
    let none = list.add(old)
    #expect(none.isEmpty)
    let other = RCFixture.mac(id: UUID(), fingerprint: CertificateFingerprint(certificateDER: Data("other".utf8)))
    list.add(other)
    let again = RCFixture.mac(id: UUID())
    let stale = list.add(again)
    #expect(stale == [old.id])
    #expect(list.macs.map(\.id) == [again.id, other.id])
  }

  @Test func renamesOnlyToAValidName() {
    var list = PairedMacList([RCFixture.mac()])
    let renamed = list.rename(RCFixture.deviceID, to: "  Office ")
    #expect(renamed == "Office")
    #expect(list.macs[0].name == "Office")
    for (id, name) in [(RCFixture.deviceID, ""), (RCFixture.deviceID, "bad\u{202E}"), (UUID(), "Nope")] {
      let result = list.rename(id, to: name)
      #expect(result == nil)
    }
    #expect(list.macs[0].name == "Office")
  }

  @Test func remembersAndFindsByFingerprint() {
    var list = PairedMacList([RCFixture.mac()])
    list.remember(GatewayEndpoint(host: "10.0.0.9", port: 7443)!, for: RCFixture.deviceID)
    #expect(list.macs[0].hosts.first == "10.0.0.9")
    // Another port is not this Mac's gateway.
    list.remember(GatewayEndpoint(host: "10.0.0.8", port: 9999)!, for: RCFixture.deviceID)
    #expect(list.macs[0].hosts.first == "10.0.0.9")
    let advert = GatewayAdvertisement(fingerprint: RCFixture.fingerprint, name: "Somebody else's name")
    #expect(list.macs(advertisedBy: advert).map(\.id) == [RCFixture.deviceID])
    #expect(list.macs(advertisedBy: GatewayAdvertisement(fingerprint: CertificateFingerprint(certificateDER: Data()), name: "Studio Mac")).isEmpty)
    let removed = list.remove(RCFixture.deviceID)
    let again = list.remove(RCFixture.deviceID)
    #expect(removed && !again)
  }
}

@MainActor
struct PairedMacStoreTests {
  let defaults: UserDefaults
  let tokens = RCTokenStore()

  init() {
    let suite = "hivemindkit-tests-\(UUID().uuidString)"
    defaults = UserDefaults(suiteName: suite)!
    defaults.removePersistentDomain(forName: suite)
  }

  @Test func savesMetadataAndTokenApart() throws {
    let store = PairedMacStore(defaults: defaults, tokens: tokens)
    try store.add(RemotePairing(mac: RCFixture.mac(), token: RCFixture.token))
    #expect(tokens.tokens[RCFixture.deviceID] == RCFixture.token)
    let stored = String(decoding: defaults.data(forKey: PairedMacStore.defaultsKey)!, as: UTF8.self)
    #expect(!stored.contains(RCFixture.token.value))
    #expect(stored.contains(RCFixture.fingerprint.hex))

    let reopened = PairedMacStore(defaults: defaults, tokens: tokens)
    #expect(reopened.macs == [RCFixture.mac()])
    #expect(reopened.token(for: RCFixture.deviceID) == RCFixture.token)
  }

  @Test func replacingAMacDeletesTheStaleToken() throws {
    let store = PairedMacStore(defaults: defaults, tokens: tokens)
    let oldID = UUID()
    try store.add(RemotePairing(mac: RCFixture.mac(id: oldID), token: DeviceToken.generate()))
    try store.add(RemotePairing(mac: RCFixture.mac(), token: RCFixture.token))
    #expect(store.macs.map(\.id) == [RCFixture.deviceID])
    #expect(tokens.tokens.keys.sorted { $0.uuidString < $1.uuidString } == [RCFixture.deviceID])
  }

  @Test func aFailedKeychainWriteSavesNothing() {
    tokens.failSave = true
    let store = PairedMacStore(defaults: defaults, tokens: tokens)
    #expect(throws: (any Error).self) { try store.add(RemotePairing(mac: RCFixture.mac(), token: RCFixture.token)) }
    #expect(store.macs.isEmpty)
  }

  @Test func dropsAMacWhoseTokenIsGone() throws {
    let store = PairedMacStore(defaults: defaults, tokens: tokens)
    try store.add(RemotePairing(mac: RCFixture.mac(), token: RCFixture.token))
    tokens.tokens = [:]
    #expect(PairedMacStore(defaults: defaults, tokens: tokens).macs.isEmpty)
    #expect(PairedMacStore(defaults: defaults, tokens: RCTokenStore()).macs.isEmpty)
  }

  @Test func removeRenameRemember() throws {
    let store = PairedMacStore(defaults: defaults, tokens: tokens)
    try store.add(RemotePairing(mac: RCFixture.mac(), token: RCFixture.token))
    #expect(store.rename(RCFixture.deviceID, to: "Office") == "Office")
    store.remember(GatewayEndpoint(host: "10.0.0.9", port: 7443)!, for: RCFixture.deviceID)
    let reopened = PairedMacStore(defaults: defaults, tokens: tokens)
    #expect(reopened.macs.first?.name == "Office")
    #expect(reopened.macs.first?.hosts.first == "10.0.0.9")
    reopened.remove(RCFixture.deviceID)
    #expect(tokens.tokens.isEmpty)
    #expect(PairedMacStore(defaults: defaults, tokens: tokens).macs.isEmpty)
  }
}
