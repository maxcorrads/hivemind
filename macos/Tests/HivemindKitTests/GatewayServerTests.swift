import Foundation
import Testing
@testable import HivemindKit

// The whole gateway over fake streams: a device's connection, the loopback
// connections to the Node server and the broker socket are all fakes, so
// nothing here listens, connects or waits.

@MainActor
final class FakeGatewayStream: GatewayStream {
  var handlers: GatewayStreamHandlers?
  var sent = Data()
  var holdCompletions = false
  var held: [@MainActor @Sendable () -> Void] = []
  var receivingChanges: [Bool] = []
  var closed = false

  func start(handlers: GatewayStreamHandlers) { self.handlers = handlers }
  func send(_ data: Data, completion: @escaping @MainActor @Sendable () -> Void) {
    sent.append(data)
    if holdCompletions { held.append(completion) } else { completion() }
  }
  func setReceiving(_ receiving: Bool) { receivingChanges.append(receiving) }
  func close() { closed = true }

  var isReceiving: Bool { receivingChanges.last ?? true }
  var text: String { String(decoding: sent, as: UTF8.self) }

  func receive(_ text: String) { receive(Data(text.utf8)) }
  func receive(_ data: Data) {
    guard !closed else { return }
    handlers?.onData(data)
  }
  func open() { handlers?.onOpen() }
  func drop(_ reason: String? = nil) {
    guard !closed else { return }
    handlers?.onClose(reason)
  }
  func release() {
    let held = self.held
    self.held = []
    for completion in held { completion() }
  }
  func take() -> Data {
    defer { sent = Data() }
    return sent
  }
}

@MainActor
final class FakeUpstream: GatewayUpstreamConnecting {
  var streams: [FakeGatewayStream] = []
  var ports: [Int] = []

  func connect(port: Int) -> any GatewayStream {
    let stream = FakeGatewayStream()
    streams.append(stream)
    ports.append(port)
    return stream
  }
}

/// The instance check (InstanceVerifier) as a fake: it answers at once with
/// `result`, or, while `holding`, keeps the completions for the test.
@MainActor
final class FakeServerVerifier: GatewayServerVerifying {
  var result = InstanceVerification.verified
  var holding = false
  var checked: [GatewayUpstreamServer] = []
  var held: [@MainActor (InstanceVerification) -> Void] = []

  func verify(_ server: GatewayUpstreamServer, completion: @escaping @MainActor (InstanceVerification) -> Void) {
    checked.append(server)
    if holding { held.append(completion) } else { completion(result) }
  }

  func answer(_ result: InstanceVerification) {
    let held = self.held
    self.held = []
    for completion in held { completion(result) }
  }
}

struct ParsedResponse {
  let head: HTTPResponseHead
  let body: Data
  var status: Int { head.status }
  var error: GatewayErrorCode? { try? JSONDecoder().decode(GatewayError.self, from: body).code }
}

/// Every whole response in `data`, in order, decoding the body by its framing.
func parseResponses(_ data: Data, method: String = "GET") -> [ParsedResponse] {
  var rest = data
  var out: [ParsedResponse] = []
  while let (head, length) = try? HTTPHeadParser.response(in: rest) {
    rest.removeFirst(length)
    if head.status == 100 || head.status == 101 {
      out.append(ParsedResponse(head: head, body: Data()))
      if head.status == 101 { break }
      continue
    }
    guard let framing = try? head.bodyFraming(requestMethod: method) else { break }
    var decoder = HTTPBodyDecoder(framing: framing, limit: 1 << 30)
    let body = (try? decoder.decode(&rest))?.reduce(Data(), +) ?? Data()
    out.append(ParsedResponse(head: head, body: body))
    if !decoder.isComplete { break }
  }
  return out
}

@MainActor
final class GatewayHarness {
  static let local = IPAddress("192.168.1.20")!
  static let remote = IPAddress("192.168.1.30")!
  static let host = "192.168.1.20:7443"
  static let origin = "https://192.168.1.20:7443"
  static let upgrade = [
    ("Connection", "Upgrade"), ("Upgrade", "websocket"),
    ("Sec-WebSocket-Version", "13"), ("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ=="),
  ]

  let scheduler = FakeScheduler()
  let upstream = FakeUpstream()
  let broker = FakeBrokerConnector()
  let storage = GatewayDeviceStoreTests.Memory()
  var brokerToken: BrokerToken? = BrokerToken(String(repeating: "ab", count: 32))
  var serverPort: Int? = 7420
  var secret: InstanceSecret? = InstanceSecret(hex: String(repeating: "5a", count: 32))
  let verifier = FakeServerVerifier()
  var logs: [String] = []
  let devices: GatewayDeviceStore
  var server: GatewayServer!

  init() {
    devices = try! GatewayDeviceStore(storage: storage)
    server = GatewayServer(
      configuration: .init(macName: "Studio Mac", port: 7443, hostNames: ["studio.local"], home: "/Users/anna"),
      devices: devices,
      dependencies: .init(
        scheduler: scheduler, upstream: upstream, broker: broker,
        brokerToken: { [unowned self] in self.brokerToken },
        server: { [unowned self] in self.serverPort.map { GatewayUpstreamServer(port: $0, secret: self.secret) } },
        verifier: verifier,
        log: { [unowned self] in self.logs.append($0) }))
  }

  func connect(remote: IPAddress = remote) -> FakeGatewayStream {
    let stream = FakeGatewayStream()
    server.accept(stream, local: Self.local, remote: remote)
    return stream
  }

  func request(_ method: String, _ target: String, _ headers: [(String, String)] = [], body: String? = nil) -> String {
    var lines = ["\(method) \(target) HTTP/1.1", "Host: \(Self.host)"] + headers.map { "\($0.0): \($0.1)" }
    if let body { lines.append("Content-Length: \(body.utf8.count)") }
    return lines.joined(separator: "\r\n") + "\r\n\r\n" + (body ?? "")
  }

  func pairBody(_ code: PairingCode, name: String = "Anna's iPhone") -> String {
    #"{"code":"\#(code.value)","deviceName":"\#(name)","platform":"ios"}"#
  }

  func postPair(_ stream: FakeGatewayStream, _ code: PairingCode, name: String = "Anna's iPhone") -> ParsedResponse {
    stream.receive(request("POST", GatewayPath.pair, [("Content-Type", "application/json")], body: pairBody(code, name: name)))
    return parseResponses(stream.take()).last!
  }

  /// Pairs a device the whole way, as the app does after scanning.
  func pair(name: String = "Anna's iPhone") -> (token: DeviceToken, id: UUID) {
    let window = server.openPairing()
    let response = postPair(connect(), window.code, name: name)
    let pair = try! JSONDecoder().decode(PairResponse.self, from: response.body)
    return (DeviceToken(pair.token)!, UUID(uuidString: pair.deviceId)!)
  }

  func postSession(_ stream: FakeGatewayStream, _ authorization: String) -> ParsedResponse {
    stream.receive(request("POST", GatewayPath.session, [("Authorization", authorization), ("Content-Length", "0")]))
    return parseResponses(stream.take()).last!
  }

  func session(_ token: DeviceToken) -> DeviceSessionToken {
    let response = postSession(connect(), "Bearer \(token.value)")
    return DeviceSessionToken(try! JSONDecoder().decode(SessionResponse.self, from: response.body).cookieValue)!
  }

  func cookie(_ session: DeviceSessionToken) -> (String, String) { ("Cookie", "__Host-hivemind-device=\(session.value)") }

  func signedIn(name: String = "Anna's iPhone") -> (session: DeviceSessionToken, id: UUID) {
    let (token, id) = pair(name: name)
    return (session(token), id)
  }

  /// The Node server answers the Human bootstrap on upstream stream `index`.
  func answerBootstrap(_ index: Int = 0, capability: HumanCapability = testCapability) {
    upstream.streams[index].receive(
      "HTTP/1.1 200 OK\r\nSet-Cookie: hivemind_human_7420=\(capability.value); HttpOnly; SameSite=Strict; Path=/\r\n"
        + "Content-Type: application/json\r\nContent-Length: 11\r\n\r\n{\"ok\":true}")
  }

  /// The upstream request the gateway wrote on stream `index`, parsed.
  func upstreamRequest(_ index: Int) -> (head: HTTPRequestHead, body: Data) {
    let sent = upstream.streams[index].sent
    let (head, length) = try! HTTPHeadParser.request(in: sent)!
    return (head, Data(sent.dropFirst(length)))
  }
}

// MARK: - Connections

@MainActor
struct GatewayAcceptTests {
  let h = GatewayHarness()

  @Test func onlyPrivateOnBothEnds() {
    for (local, remote) in [("192.168.1.20", "8.8.8.8"), ("8.8.8.8", "192.168.1.30"), ("192.168.1.20", "127.0.0.1"),
                            ("127.0.0.1", "127.0.0.1"), ("192.168.1.20", "::1"), ("192.168.1.20", "fc00::1")] {
      let stream = FakeGatewayStream()
      #expect(!h.server.accept(stream, local: IPAddress(local)!, remote: IPAddress(remote)!), "\(local) ← \(remote)")
      #expect(stream.closed)
      #expect(stream.handlers == nil)
    }
    for (local, remote) in [("100.64.0.1", "100.100.1.2"), ("fd7a::1", "fd7a::2"), ("fe80::1%en0", "fe80::2%en0"),
                            ("10.0.0.1", "::ffff:10.0.0.2")] {
      #expect(h.server.accept(FakeGatewayStream(), local: IPAddress(local)!, remote: IPAddress(remote)!), "\(local) ← \(remote)")
    }
  }

  @Test func connectionLimits() {
    for _ in 0..<GatewayLimits.maxConnectionsPerAddress { _ = h.connect() }
    let extra = h.connect()
    #expect(extra.closed)
    #expect(!h.connect(remote: IPAddress("192.168.1.31")!).closed)
    #expect(h.server.connectionCount == GatewayLimits.maxConnectionsPerAddress + 1)
  }

  @Test func malformedHeadIsAnsweredAndClosed() {
    let stream = h.connect()
    stream.receive("GET / HTTP/1.1\nHost: x\n\n")
    #expect(parseResponses(stream.sent).first?.status == 400)
    #expect(stream.closed)
    #expect(h.server.connectionCount == 0)
  }

  @Test func theHeadMustArriveInTime() {
    let stream = h.connect()
    stream.receive("GET / HTT")
    h.scheduler.advance(GatewayLimits.requestHeadTimeout - 1)
    #expect(!stream.closed)
    h.scheduler.advance(1)
    #expect(stream.closed)
  }

  @Test func idleKeepAliveCloses() {
    let stream = h.connect()
    let response = h.postSession(stream, "Bearer nope")
    #expect(response.status == 401)
    h.scheduler.advance(GatewayLimits.idleTimeout - 1)
    #expect(!stream.closed)
    h.scheduler.advance(1)
    #expect(stream.closed)
  }

  @Test func hostAndOriginAreChecked() {
    let session = h.signedIn().session
    let evil = h.connect()
    evil.receive("GET / HTTP/1.1\r\nHost: evil.example:7443\r\n\(h.cookie(session).0): \(h.cookie(session).1)\r\n\r\n")
    #expect(parseResponses(evil.take()).first?.error == .forbiddenOrigin)
    let cross = h.connect()
    cross.receive(h.request("POST", "/api/ui/channels", [h.cookie(session), ("Origin", "https://evil.example"), ("Content-Type", "application/json")], body: "{}"))
    #expect(parseResponses(cross.take()).first?.error == .forbiddenOrigin)
    // Refused before the Node server hears anything.
    #expect(h.upstream.streams.isEmpty)
    // Both connections are kept: the body was read and dropped.
    #expect(!cross.closed)
  }

  @Test func stopClosesEverything() {
    let a = h.connect(), b = h.connect()
    h.server.stop()
    #expect(a.closed && b.closed)
    #expect(h.server.connectionCount == 0)
    #expect(!h.server.accept(FakeGatewayStream(), local: GatewayHarness.local, remote: GatewayHarness.remote))
  }
}

// MARK: - Pairing and sessions

@MainActor
struct GatewayPairingEndpointTests {
  let h = GatewayHarness()

  @Test func pairs() throws {
    let window = h.server.openPairing()
    let stream = h.connect()
    let response = h.postPair(stream, window.code)
    #expect(response.status == 200)
    #expect(response.head.headers["Cache-Control"] == "no-store")
    let pair = try JSONDecoder().decode(PairResponse.self, from: response.body)
    #expect(pair.v == 1)
    #expect(pair.name == "Studio Mac")
    let token = try #require(DeviceToken(pair.token))
    let device = try #require(h.devices.devices.first)
    #expect(device.id.uuidString.lowercased() == pair.deviceId)
    #expect(device.name == "Anna's iPhone")
    #expect(device.platform == .ios)
    #expect(device.permissions == .all)
    #expect(device.tokenHash == token.hash)
    // Only the hash is written.
    #expect(!String(decoding: h.storage.data!, as: UTF8.self).contains(token.value))
    #expect(h.server.pairing.window?.state == .paired(deviceName: "Anna's iPhone"))
    // The code is used up.
    #expect(h.postPair(h.connect(), window.code).error == .invalidCode)
    #expect(h.devices.devices.count == 1)
  }

  @Test func refusals() {
    let stream = h.connect()
    #expect(h.postPair(stream, .generate()).error == .pairingClosed)
    let window = h.server.openPairing()
    stream.receive(h.request("POST", GatewayPath.pair, [("Content-Type", "text/plain")], body: h.pairBody(window.code)))
    #expect(parseResponses(stream.take()).last?.error == .badRequest)
    stream.receive(h.request("POST", GatewayPath.pair, [("Content-Type", "application/json")], body: "{\"code\":1}"))
    #expect(parseResponses(stream.take()).last?.error == .badRequest)
    stream.receive(h.request("POST", GatewayPath.pair, [("Content-Type", "application/json")], body: h.pairBody(window.code, name: " ")))
    #expect(parseResponses(stream.take()).last?.error == .badRequest)
    stream.receive(h.request("POST", GatewayPath.pair, [("Content-Type", "application/json"), ("Origin", GatewayHarness.origin)], body: h.pairBody(window.code)))
    #expect(parseResponses(stream.take()).last?.error == .forbiddenOrigin)
    #expect(h.devices.devices.isEmpty)
    #expect(!stream.closed)
  }

  @Test func locksAfterWrongCodes() {
    let window = h.server.openPairing()
    let stream = h.connect()
    for _ in 1..<GatewayLimits.maxPairingFailures { #expect(h.postPair(stream, .generate()).error == .invalidCode) }
    #expect(h.postPair(stream, .generate()).error == .pairingLocked)
    #expect(h.postPair(stream, window.code).error == .pairingLocked)
    #expect(h.devices.devices.isEmpty)
  }

  @Test func rateLimitedPerAddress() {
    let stream = h.connect()
    for _ in 0..<GatewayLimits.pairingAttemptsPerMinute { #expect(h.postPair(stream, .generate()).error == .pairingClosed) }
    #expect(h.postPair(stream, .generate()).status == 429)
    #expect(h.postPair(h.connect(remote: IPAddress("192.168.1.31")!), .generate()).error == .pairingClosed)
    h.scheduler.advance(60)
    #expect(h.postPair(h.connect(), .generate()).error == .pairingClosed)
  }

  @Test func refusesATooLargeBody() {
    let stream = h.connect()
    stream.receive("POST /_hivemind/pair HTTP/1.1\r\nHost: \(GatewayHarness.host)\r\nContent-Length: 5000\r\n\r\n")
    #expect(parseResponses(stream.sent).first?.status == 413)
    #expect(stream.closed)
  }

  @Test func answersExpectContinue() {
    let window = h.server.openPairing()
    let stream = h.connect()
    let body = h.pairBody(window.code)
    stream.receive("POST /_hivemind/pair HTTP/1.1\r\nHost: \(GatewayHarness.host)\r\nContent-Type: application/json\r\nExpect: 100-continue\r\nContent-Length: \(body.utf8.count)\r\n\r\n")
    #expect(stream.text == "HTTP/1.1 100 Continue\r\n\r\n")
    stream.receive(body)
    #expect(parseResponses(stream.sent).map(\.status) == [100, 200])
  }

  @Test func fullRegistry() {
    for i in 0..<GatewayLimits.maxDevices {
      _ = try! h.devices.add(DeviceRecord(name: "d\(i)", platform: .ios, tokenHash: DeviceToken.generate().hash, createdAt: Date()))
    }
    let window = h.server.openPairing()
    #expect(h.postPair(h.connect(), window.code).error == .tooManyDevices)
  }
}

@MainActor
struct GatewaySessionEndpointTests {
  let h = GatewayHarness()

  @Test func issuesASession() throws {
    let (token, id) = h.pair()
    h.scheduler.advance(10)
    let response = h.postSession(h.connect(), "Bearer \(token.value)")
    #expect(response.status == 200)
    let session = try JSONDecoder().decode(SessionResponse.self, from: response.body)
    #expect(session.cookieName == "__Host-hivemind-device")
    #expect(session.home == "/Users/anna")
    #expect(session.expiry == h.scheduler.now().addingTimeInterval(GatewayLimits.sessionLifetime))
    #expect(response.head.headers["Set-Cookie"] == "__Host-hivemind-device=\(session.cookieValue); Path=/; Max-Age=3600; Secure; HttpOnly; SameSite=Strict")
    #expect(h.devices.registry.device(id: id)?.lastSeenAt == h.scheduler.now())
  }

  @Test func refusesUnknownTokens() {
    let stream = h.connect()
    // device-revoked, not unauthorized: the one answer that makes the app give up and offer to pair again.
    #expect(h.postSession(stream, "Bearer \(DeviceToken.generate().value)").error == .deviceRevoked)
    #expect(h.postSession(stream, "Basic abc").error == .deviceRevoked)
    let (token, id) = h.pair()
    try! h.server.revoke(id)
    let revoked = h.postSession(stream, "Bearer \(token.value)")
    #expect(revoked.error == .deviceRevoked)
    #expect(revoked.status == 401)
  }

  @Test func rateLimited() {
    let stream = h.connect()
    for _ in 0..<GatewayLimits.sessionAttemptsPerMinute { #expect(h.postSession(stream, "Bearer x").status == 401) }
    #expect(h.postSession(stream, "Bearer x").status == 429)
  }
}

// MARK: - Proxy

@MainActor
struct GatewayProxyTests {
  let h = GatewayHarness()

  @Test func proxiesAsANativeHumanClient() throws {
    let session = h.signedIn().session
    let stream = h.connect()
    stream.receive(h.request("GET", "/api/ui/snapshot", [
      h.cookie(session), ("Origin", GatewayHarness.origin), ("Sec-Fetch-Site", "same-origin"), ("X-Hivemind-Human", "forged"),
    ]))
    // First the gateway's own Human bootstrap, on its own connection.
    #expect(h.upstream.ports == [7420])
    let bootstrap = h.upstreamRequest(0)
    #expect(bootstrap.head.target == "/api/ui/session")
    #expect(bootstrap.head.headers["Origin"] == "http://127.0.0.1:7420")
    #expect(!stream.isReceiving)
    h.answerBootstrap()
    #expect(h.upstream.streams[0].closed)

    #expect(h.upstream.ports == [7420, 7420])
    let forwarded = h.upstreamRequest(1).head
    #expect(forwarded.target == "/api/ui/snapshot")
    #expect(forwarded.headers["Host"] == "127.0.0.1:7420")
    #expect(forwarded.headers["Origin"] == "http://127.0.0.1:7420")
    #expect(forwarded.headers.values("X-Hivemind-Human") == [testCapability.value])
    #expect(!forwarded.headers.contains("Cookie"))
    #expect(forwarded.headers["Sec-Fetch-Site"] == "same-origin")

    h.upstream.streams[1].receive("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nSet-Cookie: hivemind_human_7420=\(testCapability.value)\r\nContent-Length: 2\r\n\r\n{}")
    let response = try #require(parseResponses(stream.take()).first)
    #expect(response.status == 200)
    #expect(response.body == Data("{}".utf8))
    #expect(!response.head.headers.contains("Set-Cookie"))
    #expect(!String(decoding: stream.sent, as: UTF8.self).contains(testCapability.value))
    #expect(h.upstream.streams[1].closed)
    #expect(!stream.closed)

    // Kept alive; the capability is reused.
    stream.receive(h.request("GET", "/", [h.cookie(session)]))
    #expect(h.upstream.streams.count == 3)
    #expect(h.upstreamRequest(2).head.headers["X-Hivemind-Human"] == testCapability.value)
  }

  @Test func needsALiveSession() {
    let stream = h.connect()
    stream.receive(h.request("GET", "/"))
    let first = parseResponses(stream.take()).first
    #expect(first?.error == .unauthorized)
    // The page reads this and asks the app for a new device session.
    #expect(first?.head.headers["X-Hivemind-Device-Session"] == "required")
    stream.receive(h.request("GET", "/", [h.cookie(.generate())]))
    #expect(parseResponses(stream.take()).first?.error == .unauthorized)
    let session = h.signedIn().session
    h.scheduler.advance(GatewayLimits.sessionLifetime)
    let late = h.connect()
    late.receive(h.request("GET", "/", [h.cookie(session)]))
    #expect(parseResponses(late.take()).first?.error == .unauthorized)
    #expect(h.upstream.streams.isEmpty)
  }

  @Test func serverNotRunning() {
    let session = h.signedIn().session
    h.serverPort = nil
    let stream = h.connect()
    stream.receive(h.request("GET", "/", [h.cookie(session)]))
    #expect(parseResponses(stream.take()).first?.status == 502)
    #expect(h.upstream.streams.isEmpty)
  }

  @Test func bootstrapFails() {
    let session = h.signedIn().session
    let stream = h.connect()
    stream.receive(h.request("GET", "/", [h.cookie(session)]))
    h.upstream.streams[0].drop("refused")
    #expect(parseResponses(stream.take()).first?.error == .serverUnavailable)
    // The next request tries again.
    stream.receive(h.request("GET", "/", [h.cookie(session)]))
    #expect(h.upstream.streams.count == 2)
    h.answerBootstrap(1)
    #expect(h.upstream.streams.count == 3)
  }

  @Test func bootstrapTimesOut() {
    let session = h.signedIn().session
    let stream = h.connect()
    stream.receive(h.request("GET", "/", [h.cookie(session)]))
    h.scheduler.advance(GatewayServer.bootstrapTimeout)
    #expect(parseResponses(stream.take()).first?.status == 502)
    #expect(h.upstream.streams[0].closed)
  }

  @Test func concurrentRequestsShareOneBootstrap() {
    let session = h.signedIn().session
    let a = h.connect(), b = h.connect()
    a.receive(h.request("GET", "/a", [h.cookie(session)]))
    b.receive(h.request("GET", "/b", [h.cookie(session)]))
    #expect(h.upstream.streams.count == 1)
    h.answerBootstrap()
    #expect(h.upstream.streams.count == 3)
    #expect(Set([h.upstreamRequest(1).head.target, h.upstreamRequest(2).head.target]) == ["/a", "/b"])
  }

  @Test func staleCapabilityIsReplacedAfterTheServerSaysSo() {
    let session = h.signedIn().session
    let stream = h.connect()
    stream.receive(h.request("GET", "/api/ui/snapshot", [h.cookie(session)]))
    h.answerBootstrap()
    h.upstream.streams[1].receive("HTTP/1.1 401 Unauthorized\r\nX-Hivemind-Session-Required: 1\r\nContent-Length: 2\r\n\r\n{}")
    let response = parseResponses(stream.take()).first
    #expect(response?.status == 401)
    #expect(response?.head.headers["X-Hivemind-Session-Required"] == "1")
    // The page bootstraps and replays; the gateway bootstraps first too.
    stream.receive(h.request("GET", "/api/ui/snapshot", [h.cookie(session)]))
    #expect(h.upstreamRequest(2).head.target == "/api/ui/session")
    let fresh = HumanCapability(String(repeating: "n", count: 43))!
    h.answerBootstrap(2, capability: fresh)
    #expect(h.upstreamRequest(3).head.headers["X-Hivemind-Human"] == fresh.value)
  }

  @Test func chunkedUploadAndCloseDelimitedDownload() {
    let session = h.signedIn().session
    let stream = h.connect()
    stream.receive("POST /api/ui/files HTTP/1.1\r\nHost: \(GatewayHarness.host)\r\n\(h.cookie(session).0): \(h.cookie(session).1)\r\n"
                   + "Origin: \(GatewayHarness.origin)\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhel")
    h.answerBootstrap()
    stream.receive("lo\r\n6;x=y\r\n world\r\n0\r\n\r\n")
    let upload = h.upstreamRequest(1)
    #expect(upload.head.headers["Transfer-Encoding"] == "chunked")
    var decoder = HTTPBodyDecoder(framing: .chunked, limit: 100)
    var body = upload.body
    #expect(try! decoder.decode(&body).reduce(Data(), +) == Data("hello world".utf8))
    #expect(decoder.isComplete)

    let node = h.upstream.streams[1]
    node.receive("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nabc")
    node.receive("def")
    #expect(!stream.closed)
    node.drop()
    let response = parseResponses(stream.sent, method: "POST").first
    #expect(response?.head.headers["Transfer-Encoding"] == "chunked")
    #expect(response?.body == Data("abcdef".utf8))
    #expect(!stream.closed)
  }

  @Test func refusesAnOversizedUpload() {
    let session = h.signedIn().session
    let stream = h.connect()
    stream.receive("POST /api/ui/files HTTP/1.1\r\nHost: \(GatewayHarness.host)\r\n\(h.cookie(session).0): \(h.cookie(session).1)\r\n"
                   + "Content-Length: \(GatewayLimits.maxProxiedRequestBodyBytes + 1)\r\n\r\n")
    #expect(parseResponses(stream.sent).first?.status == 413)
    #expect(stream.closed)
    #expect(h.upstream.streams.isEmpty)
  }

  @Test func anEarlyAnswerDrainsTheRestOfTheBody() {
    let session = h.signedIn().session
    let stream = h.connect()
    stream.receive(h.request("POST", "/api/ui/x", [h.cookie(session), ("Content-Type", "application/json"), ("Content-Length", "10")]) + "{\"a\"")
    h.answerBootstrap()
    h.upstream.streams[1].receive("HTTP/1.1 413 Content Too Large\r\nContent-Length: 0\r\n\r\n")
    #expect(parseResponses(stream.take()).first?.status == 413)
    stream.receive(":1234}" + h.request("GET", "/next", [h.cookie(session)]))
    #expect(h.upstream.streams.count == 3)
    #expect(h.upstreamRequest(2).head.target == "/next")
  }

  @Test func headAnswersKeepTheirLength() {
    let session = h.signedIn().session
    let stream = h.connect()
    stream.receive(h.request("HEAD", "/api/ui/files/1", [h.cookie(session)]))
    h.answerBootstrap()
    h.upstream.streams[1].receive("HTTP/1.1 200 OK\r\nContent-Length: 1234\r\n\r\n")
    let response = parseResponses(stream.take(), method: "HEAD").first
    #expect(response?.head.headers["Content-Length"] == "1234")
    #expect(h.upstream.streams[1].closed)
    stream.receive(h.request("GET", "/", [h.cookie(session)]))
    #expect(h.upstream.streams.count == 3)
  }

  @Test func theServerFailingMidResponseClosesTheDevice() {
    let session = h.signedIn().session
    let stream = h.connect()
    stream.receive(h.request("GET", "/big", [h.cookie(session)]))
    h.answerBootstrap()
    h.upstream.streams[1].receive("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\npartial")
    h.upstream.streams[1].drop("reset")
    #expect(stream.closed)
  }

  @Test func aSlowDeviceHoldsTheServerBack() {
    let session = h.signedIn().session
    let stream = h.connect()
    stream.receive(h.request("GET", "/download", [h.cookie(session)]))
    h.answerBootstrap()
    stream.holdCompletions = true
    let node = h.upstream.streams[1]
    node.receive("HTTP/1.1 200 OK\r\nContent-Length: \(3 << 20)\r\n\r\n")
    node.receive(Data(count: 512 << 10))
    #expect(node.isReceiving)
    node.receive(Data(count: 1 << 20))
    #expect(!node.isReceiving)
    stream.release()
    #expect(node.isReceiving)
  }

  @Test func aSlowServerHoldsTheDeviceBack() {
    let session = h.signedIn().session
    let stream = h.connect()
    stream.receive(h.request("POST", "/api/ui/files", [h.cookie(session), ("Content-Length", "\(3 << 20)")]))
    h.answerBootstrap()
    let node = h.upstream.streams[1]
    node.holdCompletions = true
    stream.receive(Data(count: 512 << 10))
    #expect(stream.isReceiving)
    stream.receive(Data(count: 1 << 20))
    #expect(!stream.isReceiving)
    node.release()
    #expect(stream.isReceiving)
  }

  @Test func splicesTheServersWebSocket() {
    let session = h.signedIn().session
    let stream = h.connect()
    stream.receive(h.request("GET", "/ws", GatewayHarness.upgrade + [h.cookie(session), ("Origin", GatewayHarness.origin)]))
    h.answerBootstrap()
    let upgrade = h.upstreamRequest(1).head
    #expect(upgrade.headers["Origin"] == "http://127.0.0.1:7420")
    #expect(upgrade.headers["Upgrade"] == "websocket")
    #expect(upgrade.headers["Sec-WebSocket-Key"] == "dGhlIHNhbXBsZSBub25jZQ==")
    let node = h.upstream.streams[1]
    node.receive("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\nSet-Cookie: x=1\r\n\r\n\u{81}\u{02}hi")
    let sent = stream.take()
    let head = parseResponses(sent).first?.head
    #expect(head?.status == 101)
    #expect(head?.headers["Sec-WebSocket-Accept"] == "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")
    #expect(head?.headers.contains("Set-Cookie") == false)
    #expect(sent.suffix(4) == Data([0x81, 0x02]) + Data("hi".utf8))
    node.sent = Data()
    stream.receive(Data([0x81, 0x80, 1, 2, 3, 4]))
    #expect(node.sent == Data([0x81, 0x80, 1, 2, 3, 4]))
    node.drop()
    #expect(stream.closed)
  }
}

// MARK: - Broker

@MainActor
struct GatewayBrokerEndpointTests {
  let h = GatewayHarness()

  func openBroker(_ session: DeviceSessionToken) -> FakeGatewayStream {
    let stream = h.connect()
    stream.receive(h.request("GET", GatewayPath.broker, GatewayHarness.upgrade + [h.cookie(session)]))
    return stream
  }

  func text(_ json: String) -> Data { clientFrame(.text, Data(json.utf8)) }

  @Test func bridgesTheBrokerWithTheRealToken() throws {
    let session = h.signedIn().session
    let stream = openBroker(session)
    let response = try #require(parseResponses(stream.take()).first)
    #expect(response.status == 101)
    #expect(response.head.headers["Sec-WebSocket-Accept"] == "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")
    let broker = h.broker.current
    #expect(broker.started)

    // BrokerClient's hello, with the placeholder token, before the socket opened.
    let hello = try BrokerRequestFrame(id: nil, .hello(version: 1, token: GatewayBrokerHello.deviceToken.value, client: "Hivemind iOS")).line()
    stream.receive(clientFrame(.text, hello))
    stream.receive(text("{\"type\":\"sessions.subscribe\"}"))
    #expect(broker.sent.isEmpty)
    broker.open()
    let frames = broker.frames
    #expect(frames.count == 2)
    guard case .hello(let version, let token, let client) = frames[0].request else {
      Issue.record("not a hello")
      return
    }
    #expect(version == 1)
    #expect(token == h.brokerToken!.value)
    #expect(client == "device:ios:Anna's iPhone")
    #expect(frames[1].request == .sessionsSubscribe)

    broker.push(.welcome(version: 1, tmuxPath: "/opt/homebrew/bin/tmux"))
    var reader = ServerFrameReader()
    let events = reader.read(stream.take())
    // Compared decoded: JSONEncoder does not keep key order from one encode to the next.
    guard events.count == 1, case .text(let welcome) = events[0] else {
      Issue.record("not one text frame: \(events)")
      return
    }
    #expect(try BrokerEventFrame.decode(welcome).event == .welcome(version: 1, tmuxPath: "/opt/homebrew/bin/tmux"))

    stream.receive(clientFrame(.ping, Data("p".utf8)))
    #expect(reader.read(stream.take()) == [.pong(Data("p".utf8))])

    stream.receive(clientFrame(.binary, Data([1])))
    #expect(reader.read(stream.take()).last == .close(WebSocketCloseCode.unsupportedData.rawValue))
    #expect(stream.closed)
    #expect(broker.closed)
  }

  @Test func theFirstFrameMustBeHello() {
    let stream = openBroker(h.signedIn().session)
    h.broker.current.open()
    _ = stream.take()
    stream.receive(text("{\"type\":\"sessions.list\"}"))
    var reader = ServerFrameReader()
    let frames = reader.read(stream.take())
    guard case .text(let answer) = frames.first, let event = try? BrokerEventFrame.decode(answer) else {
      Issue.record("no broker error first")
      return
    }
    #expect(event.event == .error(code: .unauthorized, message: "say hello first", stream: nil))
    #expect(frames.last == .close(WebSocketCloseCode.policyViolation.rawValue))
    #expect(stream.closed)
    #expect(h.broker.current.sent.isEmpty)
  }

  @Test func refusals() {
    let session = h.signedIn().session
    let noSession = h.connect()
    noSession.receive(h.request("GET", GatewayPath.broker, GatewayHarness.upgrade))
    #expect(parseResponses(noSession.take()).first?.error == .unauthorized)
    let withOrigin = h.connect()
    withOrigin.receive(h.request("GET", GatewayPath.broker, GatewayHarness.upgrade + [h.cookie(session), ("Origin", GatewayHarness.origin)]))
    #expect(parseResponses(withOrigin.take()).first?.error == .forbiddenOrigin)
    h.brokerToken = nil
    let noBroker = openBroker(session)
    #expect(parseResponses(noBroker.take()).first?.error == .serverUnavailable)
    #expect(h.broker.connections.isEmpty)
  }

  @Test func connectionsPerDevice() {
    let session = h.signedIn().session
    for _ in 0..<GatewayLimits.maxBrokerConnectionsPerDevice { #expect(parseResponses(openBroker(session).take()).first?.status == 101) }
    #expect(parseResponses(openBroker(session).take()).first?.status == 429)
  }

  @Test func aSlowDeviceStopsReadingTheBroker() throws {
    let stream = openBroker(h.signedIn().session)
    let broker = h.broker.current
    broker.open()
    stream.holdCompletions = true
    let output = try BrokerEventFrame(id: nil, .output(stream: 1, data: Data(count: 60_000))).line()
    for _ in 0..<15 { broker.handlers.onData(output) }
    #expect(broker.readingChanges.last == false)
    stream.release()
    #expect(broker.readingChanges.last == true)
  }

  @Test func theBrokerGoingAwayClosesTheDevice() {
    let stream = openBroker(h.signedIn().session)
    _ = stream.take()
    h.broker.current.open()
    h.broker.current.drop("gone")
    var reader = ServerFrameReader()
    #expect(reader.read(stream.take()).last == .close(WebSocketCloseCode.goingAway.rawValue))
    #expect(stream.closed)
  }
}

// MARK: - Revocation

@MainActor
struct GatewayRevocationTests {
  let h = GatewayHarness()

  @Test func revokingClosesEveryConnectionOfTheDevice() throws {
    let (session, id) = h.signedIn()
    let other = h.signedIn(name: "iPad").session

    let http = h.connect()
    http.receive(h.request("GET", "/", [h.cookie(session)]))
    h.answerBootstrap()
    h.upstream.streams[1].receive("HTTP/1.1 204 No Content\r\n\r\n")
    let ws = h.connect()
    ws.receive(h.request("GET", "/ws", GatewayHarness.upgrade + [h.cookie(session), ("Origin", GatewayHarness.origin)]))
    let node = h.upstream.streams[2]
    node.receive("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n")
    let terminals = h.connect()
    terminals.receive(h.request("GET", GatewayPath.broker, GatewayHarness.upgrade + [h.cookie(session)]))
    let broker = h.broker.current
    let unrelated = h.connect()
    unrelated.receive(h.request("GET", "/", [h.cookie(other)]))

    try h.server.revoke(id)
    #expect(http.closed && ws.closed && terminals.closed)
    #expect(node.closed && broker.closed)
    #expect(!unrelated.closed)
    #expect(h.devices.registry.device(id: id) == nil)
    #expect(try DeviceRegistry.decode(h.storage.data!).device(id: id) == nil)

    let again = h.connect()
    again.receive(h.request("GET", "/", [h.cookie(session)]))
    #expect(parseResponses(again.take()).first?.error == .unauthorized)
  }

  @Test func revokeAll() throws {
    let a = h.signedIn().session
    let stream = h.connect()
    stream.receive(h.request("GET", "/", [h.cookie(a)]))
    try h.server.revokeAll()
    #expect(stream.closed)
    #expect(h.devices.devices.isEmpty)
  }
}

// MARK: - Helpers

/// Reads the unmasked frames the gateway sends a device.
struct ServerFrameReader {
  enum Frame: Equatable {
    case text(Data)
    case pong(Data)
    case close(UInt16?)
    case other(UInt8)
  }

  private var buffer = Data()

  mutating func read(_ data: Data) -> [Frame] {
    buffer.append(data)
    var frames: [Frame] = []
    while buffer.count >= 2 {
      let bytes = [UInt8](buffer)
      var length = Int(bytes[1] & 0x7F)
      var offset = 2
      if length == 126 {
        guard bytes.count >= 4 else { break }
        length = Int(bytes[2]) << 8 | Int(bytes[3])
        offset = 4
      } else if length == 127 {
        guard bytes.count >= 10 else { break }
        length = (2..<10).reduce(0) { $0 << 8 | Int(bytes[$1]) }
        offset = 10
      }
      guard bytes.count >= offset + length else { break }
      let payload = Data(bytes[offset..<(offset + length)])
      buffer.removeFirst(offset + length)
      switch bytes[0] & 0x0F {
      case 0x1: frames.append(.text(payload))
      case 0xA: frames.append(.pong(payload))
      case 0x8: frames.append(.close(payload.count >= 2 ? UInt16(payload[0]) << 8 | UInt16(payload[1]) : nil))
      case let opcode: frames.append(.other(opcode))
      }
    }
    return frames
  }
}

extension BrokerEventFrame {
  func lineWithoutNewline() throws -> Data {
    var line = try line()
    line.removeLast()
    return line
  }
}
