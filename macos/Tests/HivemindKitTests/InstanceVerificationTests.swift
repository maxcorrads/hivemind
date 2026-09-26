import Darwin
import Foundation
import Testing
@testable import HivemindKit

// Proof of instance (docs/macos.md#verifying-the-server): the HMAC, the
// challenge, the private discovery file, the decision tables and the
// terminal gate. No socket: HTTP answers come from fakes keyed by port.

private let secretHex = "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"
private let fixedSecret = InstanceSecret(hex: secretHex)!
private let nonce = InstanceNonce(hex: String(repeating: "a", count: 64))!
/// The same vector src/server/instance-proof.test.ts checks.
private let knownProof = "6745245fe21c96869cf150eb4974181180e20990e4ca0bc5275c81324a55808a"

private func endpoint(_ port: Int) -> ServerEndpoint { ServerEndpoint(port: ServerPort(port)!) }

struct InstanceProofTests {
  @Test func matchesTheServersHMAC() {
    #expect(InstanceProof.context == "hivemind-instance-v1")
    #expect(InstanceProof.environmentKey == "HIVEMIND_INSTANCE_SECRET")
    #expect(String(decoding: InstanceProof.message(nonce: nonce, port: .default), as: UTF8.self)
      == "hivemind-instance-v1\n\(nonce.hex)\n7420")
    #expect(InstanceProof.proof(secret: fixedSecret, nonce: nonce, port: .default) == knownProof)
  }

  @Test func verifiesOnlyTheExactProof() {
    #expect(InstanceProof.verify(knownProof, secret: fixedSecret, nonce: nonce, port: .default))
    #expect(!InstanceProof.verify(knownProof, secret: fixedSecret, nonce: nonce, port: ServerPort(7421)!), "another port")
    #expect(!InstanceProof.verify(knownProof, secret: fixedSecret, nonce: InstanceNonce(hex: String(repeating: "b", count: 64))!, port: .default))
    #expect(!InstanceProof.verify(knownProof, secret: InstanceSecret.generate(), nonce: nonce, port: .default))
    for bad in [knownProof.uppercased(), String(knownProof.dropLast()), knownProof + "0", "", String(repeating: "z", count: 64)] {
      #expect(!InstanceProof.verify(bad, secret: fixedSecret, nonce: nonce, port: .default), "\(bad)")
    }
  }

  @Test func secretsAndNoncesAre32RandomBytesInLowercaseHex() throws {
    for bad in ["", String(secretHex.dropLast()), secretHex + "0", secretHex.uppercased(), String(repeating: "g", count: 64)] {
      #expect(InstanceSecret(hex: bad) == nil)
      #expect(InstanceNonce(hex: bad) == nil)
    }
    let a = InstanceSecret.generate(), b = InstanceSecret.generate()
    #expect(a != b)
    #expect(InstanceSecret(hex: a.hex) == a)
    #expect(InstanceNonce.generate() != InstanceNonce.generate())
    #expect(InstanceNonce(hex: InstanceNonce.generate().hex) != nil)
    #expect("\(a)" == "InstanceSecret(…)", "never printed")
    #expect(!String(describing: ServerDiscovery(port: .default, pid: 1, home: "/h", startedAt: Date(), version: "1", instanceSecret: a)).contains(a.hex))
  }

  @Test func theChallengeURLCarriesTheNonce() {
    #expect(endpoint(7421).instanceURL(nonce: nonce).absoluteString == "http://127.0.0.1:7421/api/health/instance?nonce=\(nonce.hex)")
  }
}

/// Answers /api/health and /api/health/instance per port, like a real
/// server would, or like a squatter that only mimics /api/health.
private final class ServerTable: HTTPGetting, @unchecked Sendable {
  enum Server { case hivemind(InstanceSecret?), mimic, other, refused, fixedProof(String) }
  let servers: [Int: Server]
  private let lock = NSLock()
  private var _requests: [URL] = []
  var requests: [URL] { lock.withLock { _requests } }

  init(_ servers: [Int: Server]) { self.servers = servers }

  func get(_ url: URL, timeout: TimeInterval) async throws -> (status: Int, body: Data) {
    lock.withLock { _requests.append(url) }
    let port = url.port ?? 80
    let health = (200, Data(#"{"ok":true,"name":"hivemind"}"#.utf8))
    let isChallenge = url.path == "/api/health/instance"
    switch servers[port] ?? .refused {
    case .refused: throw URLError(.cannotConnectToHost)
    case .other: return (200, Data("<html>".utf8))
    case .mimic: return isChallenge ? (404, Data("Not Found".utf8)) : health
    case .fixedProof(let proof): return isChallenge ? (200, Data(#"{"proof":"\#(proof)"}"#.utf8)) : health
    case .hivemind(let fixedSecret):
      guard isChallenge else { return health }
      guard let fixedSecret else { return (404, Data(#"{"error":"No instance secret"}"#.utf8)) }
      let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
      guard let raw = query.first(where: { $0.name == "nonce" })?.value, let nonce = InstanceNonce(hex: raw) else {
        return (400, Data(#"{"error":"bad nonce"}"#.utf8))
      }
      let proof = InstanceProof.proof(secret: fixedSecret, nonce: nonce, port: ServerPort(port)!)
      return (200, Data(#"{"proof":"\#(proof)"}"#.utf8))
    }
  }
}

struct InstanceVerifierTests {
  fileprivate func verify(_ server: ServerTable.Server, secret known: InstanceSecret? = fixedSecret, port: Int = 7420) async -> (InstanceVerification, ServerTable) {
    let table = ServerTable([port: server])
    return (await InstanceVerifier(http: table).verify(endpoint(port), secret: known), table)
  }

  @Test func verifiesTheServerHoldingTheSecret() async {
    let (result, table) = await verify(.hivemind(fixedSecret))
    #expect(result == .verified)
    #expect(table.requests.count == 1)
    #expect(table.requests.first?.path == "/api/health/instance")
  }

  @Test func sendsAFreshNonceEveryTime() async {
    let table = ServerTable([7420: .hivemind(fixedSecret)])
    let verifier = InstanceVerifier(http: table)
    _ = await verifier.verify(endpoint(7420), secret: fixedSecret)
    _ = await verifier.verify(endpoint(7420), secret: fixedSecret)
    #expect(table.requests.count == 2)
    #expect(table.requests[0] != table.requests[1])
  }

  @Test func failsEverySquatter() async {
    #expect(await verify(.hivemind(InstanceSecret.generate())).0 == .failed(.wrongProof), "another server's secret")
    #expect(await verify(.hivemind(nil)).0 == .failed(.notOffered), "a hivemind serve without a secret")
    #expect(await verify(.mimic).0 == .failed(.notOffered))
    #expect(await verify(.fixedProof(knownProof)).0 == .failed(.wrongProof), "a replayed proof")
    #expect(await verify(.fixedProof("nope")).0 == .failed(.wrongProof))
    #expect(await verify(.other).0 == .failed(.badAnswer(status: 200)))
    if case .failed(.unreachable) = await verify(.refused).0 {} else { Issue.record("expected unreachable") }
  }

  @Test func aDiscoveryWithoutSecretNeverAsks() async {
    let (result, table) = await verify(.hivemind(fixedSecret), secret: nil)
    #expect(result == .failed(.noSecret))
    #expect(table.requests.isEmpty)
  }

  @Test func theProofIsBoundToThePort() {
    // A proof computed for 7421 relayed by whatever answers on 7420.
    let relayed = InstanceProof.proof(secret: fixedSecret, nonce: nonce, port: ServerPort(7421)!)
    let body = Data(#"{"proof":"\#(relayed)"}"#.utf8)
    #expect(InstanceVerifier.interpret(status: 200, body: body, secret: fixedSecret, nonce: nonce, port: .default) == .failed(.wrongProof))
    #expect(InstanceVerifier.interpret(status: 500, body: body, secret: fixedSecret, nonce: nonce, port: .default) == .failed(.badAnswer(status: 500)))
  }
}

struct PrivateDiscoveryFileTests {
  func store() throws -> DiscoveryStore { DiscoveryStore(paths: HivemindPaths(home: try temporaryHome())) }
  let discovery = ServerDiscovery(port: .default, pid: 7, home: "/h", startedAt: Date(timeIntervalSince1970: 1_790_000_000),
                                  version: "1", instanceSecret: fixedSecret)

  @Test func roundTripsTheSecretInA0600FileInA0700Folder() throws {
    let store = try store()
    try store.write(discovery)
    #expect(store.read() == discovery)
    let json = try String(contentsOf: store.file, encoding: .utf8)
    #expect(json.contains(#""instanceSecret":"\#(secretHex)""#))
    let fm = FileManager.default
    #expect(try fm.attributesOfItem(atPath: store.file.path)[.posixPermissions] as? Int == 0o600)
    #expect(try fm.attributesOfItem(atPath: store.file.deletingLastPathComponent().path)[.posixPermissions] as? Int == 0o700)
  }

  @Test func tightensAnExistingFolder() throws {
    let store = try store()
    let folder = store.file.deletingLastPathComponent()
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o755])
    try store.write(discovery)
    #expect(try FileManager.default.attributesOfItem(atPath: folder.path)[.posixPermissions] as? Int == 0o700)
  }

  @Test func refusesAFileOthersCouldReadOrWrite() throws {
    let store = try store()
    try store.write(discovery)
    for mode in [0o644, 0o640, 0o604, 0o666, 0o400, 0o700] as [mode_t] {
      #expect(chmod(store.file.path, mode) == 0)
      #expect(store.read() == nil, "mode \(String(mode, radix: 8))")
      #expect(PrivateFile.read(store.file, maxBytes: 1024) == .failure(.wrongMode(mode)))
    }
    #expect(chmod(store.file.path, 0o600) == 0)
    #expect(store.read() == discovery)
  }

  @Test func refusesASymlinkEvenToAPrivateFile() throws {
    let store = try store()
    let elsewhere = try temporaryHome().appendingPathComponent("real.json")
    try DiscoveryStore(file: elsewhere).write(discovery)
    try FileManager.default.createDirectory(at: store.file.deletingLastPathComponent(), withIntermediateDirectories: true)
    try FileManager.default.createSymbolicLink(at: store.file, withDestinationURL: elsewhere)
    #expect(DiscoveryStore(file: elsewhere).read() == discovery)
    #expect(store.read() == nil)
    #expect(PrivateFile.read(store.file, maxBytes: 1024) == .failure(.symlink))
  }

  @Test func refusesAFolderOrAnOversizedFile() throws {
    let store = try store()
    try FileManager.default.createDirectory(at: store.file, withIntermediateDirectories: true)
    #expect(store.read() == nil)
    #expect(PrivateFile.read(store.file, maxBytes: 1024) == .failure(.notRegular))
    let big = try temporaryHome().appendingPathComponent("big")
    try BrokerFiles.writePrivately(Data(repeating: 0x20, count: 2048), to: big)
    #expect(PrivateFile.read(big, maxBytes: 1024) == .failure(.tooLarge))
    #expect(PrivateFile.read(big, maxBytes: 2048).map(\.count) == .success(2048))
    #expect(PrivateFile.read(big.appendingPathExtension("gone"), maxBytes: 1024) == .failure(.missing))
  }

  @Test func anOlderFileWithoutSecretStillReads() throws {
    let store = try store()
    var old = discovery
    old.instanceSecret = nil
    try store.write(old)
    #expect(try !String(contentsOf: store.file, encoding: .utf8).contains("instanceSecret"))
    #expect(store.read()?.instanceSecret == nil)
    #expect(store.read()?.instance.secret == nil)
  }

  @Test func theInstanceChangesWithEveryStart() {
    var next = discovery
    next.instanceSecret = InstanceSecret.generate()
    #expect(next.instance != discovery.instance, "same pid and port, new secret")
    next = discovery
    next.pid = 8
    #expect(next.instance != discovery.instance)
    #expect(discovery.instance == discovery.instance)
  }
}

@MainActor
struct DiscoveryPublisherSecretTests {
  @Test func publishesTheRunningChildsSecret() throws {
    let store = DiscoveryStore(paths: HivemindPaths(home: try temporaryHome()))
    let settings = ServerLaunchSettings(port: .default, dataHome: URL(fileURLWithPath: "/data"))
    var current = InstanceSecret.generate()
    let publisher = DiscoveryPublisher(store: store, version: "1", settings: { settings }, secret: { current })
    publisher.update(for: .running(pid: 10, since: Date()))
    #expect(store.read()?.instanceSecret == current)
    current = InstanceSecret.generate()
    publisher.update(for: .running(pid: 11, since: Date()))
    #expect(store.read()?.instanceSecret == current)
  }
}

struct UIVerificationTests {
  let instance = ServerInstance(port: .default, pid: 42, startedAt: Date(timeIntervalSince1970: 1_790_000_000), secret: fixedSecret)

  fileprivate func locator(discoveryPort: Int?, secret known: InstanceSecret? = fixedSecret, alive: Bool = true,
               servers: [Int: ServerTable.Server]) throws -> (UIServerLocator, ServerTable) {
    let store = DiscoveryStore(paths: HivemindPaths(home: try temporaryHome()))
    if let discoveryPort {
      try store.write(ServerDiscovery(port: ServerPort(discoveryPort)!, pid: 42, home: "/h",
                                      startedAt: Date(timeIntervalSince1970: 1_790_000_000), version: "1", instanceSecret: known))
    }
    let table = ServerTable(servers)
    return (UIServerLocator(discovery: store, health: HealthChecker(http: table), verifier: InstanceVerifier(http: table),
                            isAlive: { _ in alive }), table)
  }

  @Test func theDecisionTable() {
    let discovery = ServerDiscovery(port: .default, pid: 42, home: "/h", startedAt: instance.startedAt, version: "1", instanceSecret: fixedSecret)
    typealias O = UICandidateOutcome
    #expect(O.decide(health: .healthy, discovery: discovery, verification: .verified) == .verified(instance))
    #expect(O.decide(health: .healthy, discovery: discovery, verification: .failed(.wrongProof)) == .unverified(.failed(.wrongProof)))
    #expect(O.decide(health: .healthy, discovery: discovery, verification: nil) == .unverified(.failed(.noSecret)))
    // Only the configured or default port: never verified, whatever it says.
    #expect(O.decide(health: .healthy, discovery: nil, verification: .verified) == .unverified(.notStartedByServerApp))
    #expect(O.decide(health: .healthy, discovery: nil, verification: nil) == .unverified(.notStartedByServerApp))
    #expect(O.decide(health: .foreign, discovery: discovery, verification: .verified) == .foreign)
    #expect(O.decide(health: .unreachable("x"), discovery: nil, verification: nil) == .unreachable("x"))
  }

  @Test func connectsOnlyToTheVerifiedDiscoveryServer() async throws {
    let (found, _) = try locator(discoveryPort: 7421, servers: [7421: .hivemind(fixedSecret), 7420: .hivemind(nil)])
    let expected = ServerInstance(port: ServerPort(7421)!, pid: 42, startedAt: instance.startedAt, secret: fixedSecret)
    #expect(await found.resolve(configuredPort: nil) == .connected(endpoint(7421), .verified(expected)))
    #expect(found.liveInstance() == expected)
  }

  @Test func aSquatterOnTheDiscoveryPortIsNotVerified() async throws {
    // Hivemind is restarting; something else took its port and mimics /api/health.
    let (squatted, _) = try locator(discoveryPort: 7420, servers: [7420: .mimic])
    #expect(await squatted.resolve(configuredPort: nil) == .unverified(endpoint(7420), .failed(.notOffered)))
    let (other, _) = try locator(discoveryPort: 7420, servers: [7420: .hivemind(InstanceSecret.generate())])
    #expect(await other.resolve(configuredPort: nil) == .unverified(endpoint(7420), .failed(.wrongProof)))
    let (older, _) = try locator(discoveryPort: 7420, secret: nil, servers: [7420: .hivemind(fixedSecret)])
    #expect(await older.resolve(configuredPort: nil) == .unverified(endpoint(7420), .failed(.noSecret)))
  }

  @Test func withoutADiscoveryFileNothingIsVerified() async throws {
    // A `hivemind serve` by hand, or a squatter while Hivemind Server is stopped.
    let (manual, table) = try locator(discoveryPort: nil, servers: [7420: .hivemind(nil)])
    #expect(await manual.resolve(configuredPort: nil) == .unverified(endpoint(7420), .notStartedByServerApp))
    #expect(table.requests.allSatisfy { $0.path == "/api/health" }, "no challenge without a secret to check it with")
    // A dead server's discovery file does not count either.
    let (stale, _) = try locator(discoveryPort: 7420, alive: false, servers: [7420: .hivemind(fixedSecret)])
    #expect(await stale.resolve(configuredPort: nil) == .unverified(endpoint(7420), .notStartedByServerApp))
  }

  @Test func anUnverifiedServerOutranksOneThatIsDown() async throws {
    let (l, _) = try locator(discoveryPort: nil, servers: [7420: .mimic])
    #expect(await l.resolve(configuredPort: ServerPort(7500)) == .unverified(endpoint(7420), .notStartedByServerApp))
  }

  @Test func candidatesKeepTheirDiscovery() throws {
    let (l, _) = try locator(discoveryPort: 7421, servers: [:])
    let candidates = l.candidates(configuredPort: ServerPort(7500))
    #expect(candidates.map(\.endpoint) == [endpoint(7421), endpoint(7500), endpoint(7420)])
    #expect(candidates.map { $0.discovery != nil } == [true, false, false])
  }

  @Test func whatAWindowDoesWithAFreshResolve() {
    let e = endpoint(7420), f = endpoint(7421)
    let other = ServerInstance(port: .default, pid: 43, startedAt: instance.startedAt, secret: InstanceSecret.generate())
    let verified = UIConnectionState.connected(e, .verified(instance))
    let open = UIConnectionState.connected(e, .unverified)
    typealias A = UITrustAction
    // The same process: nothing to do. A new one: a new document.
    #expect(A.decide(current: verified, result: verified, acceptedUnverified: nil) == .keep)
    #expect(A.decide(current: verified, result: .connected(e, .verified(other)), acceptedUnverified: nil) == .load(e, .verified(other)))
    #expect(A.decide(current: verified, result: .connected(f, .verified(other)), acceptedUnverified: nil) == .load(f, .verified(other)))
    // Opened without terminals, and now verified: upgraded.
    #expect(A.decide(current: open, result: verified, acceptedUnverified: e) == .load(e, .verified(instance)))
    // Not verified any more: the connect screen, unless the user already chose to open it without terminals.
    let unverified = UIConnectionState.unverified(e, .failed(.wrongProof))
    #expect(A.decide(current: verified, result: unverified, acceptedUnverified: nil) == .connectScreen(unverified))
    #expect(A.decide(current: verified, result: unverified, acceptedUnverified: e) == .load(e, .unverified))
    #expect(A.decide(current: open, result: unverified, acceptedUnverified: e) == .keep)
    #expect(A.decide(current: open, result: .unverified(f, .notStartedByServerApp), acceptedUnverified: e)
      == .connectScreen(.unverified(f, .notStartedByServerApp)))
    // Down: the page reconnects by itself; a verified one holds its terminals meanwhile.
    #expect(A.decide(current: verified, result: .unreachable(e, reason: "x"), acceptedUnverified: nil) == .hold)
    #expect(A.decide(current: verified, result: .foreign(e), acceptedUnverified: nil) == .hold)
    #expect(A.decide(current: open, result: .unreachable(e, reason: "x"), acceptedUnverified: e) == .keep)
  }

  @Test func theWatchNoticesStopsRestartsAndReplacements() {
    var watch = ServerTrustWatch()
    watch.decided(on: instance)
    let verified = ServerTrust.verified(instance)
    #expect(watch.observe(instance, trust: verified) == .none)
    #expect(watch.observe(nil, trust: verified) == .lapse, "stopped: nothing proves who answers now")
    #expect(watch.observe(nil, trust: verified) == .none, "once")
    let restarted = ServerInstance(port: .default, pid: 43, startedAt: instance.startedAt, secret: InstanceSecret.generate())
    #expect(watch.observe(restarted, trust: verified) == .reverify)
    #expect(watch.observe(restarted, trust: verified) == .none)
    // Opened without terminals: a server appearing is worth a look, one going away is not.
    var open = ServerTrustWatch(basis: nil)
    #expect(open.observe(nil, trust: .unverified) == .none)
    #expect(open.observe(instance, trust: .unverified) == .reverify)
    #expect(open.observe(instance, trust: .unverified) == .none, "a failing one is not retried until it changes")
    #expect(open.observe(nil, trust: .unverified) == .none)
  }

  @Test func theConnectScreenOffersToOpenWithoutTerminals() {
    let state = UIConnectionState.unverified(endpoint(7420), .notStartedByServerApp)
    let content = ConnectScreenContent(state: state, serverAppInstalled: true)
    #expect(content.title == "This server couldn't be verified")
    #expect(content.offersOpenWithoutTerminals)
    #expect(content.offersServerApp)
    #expect(content.detail.contains("127.0.0.1:7420"))
    #expect(content.detail.contains("Open without terminals"))
    #expect(!ConnectScreenContent(state: .unreachable(endpoint(7420), reason: "x"), serverAppInstalled: true).offersOpenWithoutTerminals)
    #expect(!ConnectScreenContent(state: .foreign(endpoint(7420)), serverAppInstalled: true).offersOpenWithoutTerminals)
    for reason in [UnverifiedReason.notStartedByServerApp, .failed(.noSecret), .failed(.notOffered), .failed(.wrongProof),
                   .failed(.badAnswer(status: 500)), .failed(.unreachable("reset"))] {
      #expect(!reason.explanation.isEmpty)
    }
  }

  @Test func onlyAVerifiedPageMayUseTerminals() {
    #expect(ServerTrust.verified(instance).allowsTerminals)
    #expect(!ServerTrust.unverified.allowsTerminals)
    #expect(ServerTrust.verified(instance).instance == instance)
    #expect(ServerTrust.unverified.instance == nil)
  }
}

struct TerminalTrustGateTests {
  let launch = BridgeMessage.terminalLaunch(id: "r1", launches: [], openInTerminal: false)
  let refused = BridgeTerminalEvent.error(id: "r1", code: .unauthorized, message: TerminalTrustGate.unverifiedMessage, stream: nil)

  @Test func aClosedGateAnswersForTheBroker() {
    var gate = TerminalTrustGate()
    #expect(gate.mode == .closed)
    #expect(gate.route(.sessionsSubscribe) == [.answer(.status(tmux: .unknown, broker: .unverified))])
    #expect(gate.route(launch) == [.answer(refused)])
    #expect(gate.route(.terminalOpen(session: SessionName("hm-acme-atlas")!))
      == [.answer(.error(id: nil, code: .unauthorized, message: TerminalTrustGate.unverifiedMessage, stream: nil))])
    #expect(gate.route(.terminalKill(id: "k", session: SessionName("hm-acme-atlas")!))
      == [.answer(.error(id: "k", code: .unauthorized, message: TerminalTrustGate.unverifiedMessage, stream: nil))])
    #expect(gate.route(.terminalAttach(id: "a", session: SessionName("hm-acme-atlas")!, size: TerminalSize(columns: 80, rows: 24)!))
      == [.answer(.error(id: "a", code: .unauthorized, message: TerminalTrustGate.unverifiedMessage, stream: nil))])
    for quiet in [BridgeMessage.terminalInput(stream: 1, data: Data("x".utf8)), .terminalResize(stream: 1, size: TerminalSize(columns: 80, rows: 24)!),
                  .terminalDetach(stream: 1), .terminalAck(stream: 1, bytes: 1), .sessionsUnsubscribe] {
      #expect(gate.route(quiet) == [.drop])
    }
  }

  @Test func anOpenGateRelays() {
    var gate = TerminalTrustGate(mode: .open)
    #expect(gate.route(launch) == [.relay(launch)])
  }

  @Test func aHeldGateKeepsMessagesUntilTheCheckEnds() {
    var gate = TerminalTrustGate(mode: .open)
    gate.hold()
    #expect(gate.route(.sessionsSubscribe) == [])
    #expect(gate.route(launch) == [])
    #expect(gate.open() == [.sessionsSubscribe, launch])
    #expect(gate.route(launch) == [.relay(launch)])

    gate.hold()
    _ = gate.route(.sessionsSubscribe)
    _ = gate.route(launch)
    _ = gate.route(.terminalAck(stream: 1, bytes: 1))
    #expect(gate.close() == [.status(tmux: .unknown, broker: .unverified), refused])
    #expect(gate.mode == .closed)
    #expect(gate.held.isEmpty)
  }

  @Test func heldMessagesAreBoundedAndForgottenWithThePage() {
    var gate = TerminalTrustGate()
    gate.hold()
    for _ in 0..<TerminalTrustGate.capacity { #expect(gate.route(.sessionsSubscribe) == []) }
    #expect(gate.route(launch) == [.answer(.status(tmux: .unknown, broker: .unverified))], "the oldest is refused")
    #expect(gate.held.count == TerminalTrustGate.capacity)
    gate.pageDidChange()
    #expect(gate.held.isEmpty)
    #expect(gate.mode == .held)
  }

  @Test func theUnverifiedStatusReachesThePage() {
    let event = BridgeTerminalEvent.status(tmux: .unknown, broker: .unverified)
    #expect(event.detail["broker"] as? String == "unverified")
    #expect(event.javaScript.contains(#""broker":"unverified""#))
  }
}
