import Foundation
import Testing
@testable import HivemindKit

// The gateway forwards only to a server that passed the instance check
// (docs/remote-access.md#verified-server), resumes reading a kept-alive
// device connection after every answer it sends from an async completion,
// and wants a Content-Length on its own endpoints. All over fakes.

@MainActor
struct GatewayVerifiedServerTests {
  let h = GatewayHarness()

  func get(_ stream: FakeGatewayStream, _ path: String, _ session: DeviceSessionToken) {
    stream.receive(h.request("GET", path, [h.cookie(session)]))
  }

  @Test func checksTheServerWithItsSecretBeforeTheHumanBootstrap() {
    let session = h.signedIn().session
    h.verifier.holding = true
    let stream = h.connect()
    get(stream, "/", session)
    #expect(h.verifier.checked == [GatewayUpstreamServer(port: 7420, secret: h.secret)])
    #expect(h.upstream.streams.isEmpty, "nothing reaches the server before it proved itself")
    #expect(!stream.isReceiving)
    h.verifier.answer(.verified)
    #expect(h.upstreamRequest(0).head.target == "/api/ui/session")
    #expect(h.server.isVerified)
    // Verified once for this server: the next requests go straight out.
    h.answerBootstrap()
    h.upstream.streams[1].receive("HTTP/1.1 204 No Content\r\n\r\n")
    get(stream, "/next", session)
    #expect(h.verifier.checked.count == 1)
    #expect(h.upstreamRequest(2).head.target == "/next")
  }

  @Test func anUnverifiedServerGetsNothingAndDevicesGet503() throws {
    let session = h.signedIn().session
    h.verifier.result = .failed(.wrongProof)
    let stream = h.connect()
    get(stream, "/", session)
    let response = try #require(parseResponses(stream.take()).first)
    #expect(response.status == 503)
    #expect(response.error == .serverUnverified)
    #expect(h.upstream.streams.isEmpty)
    #expect(!stream.closed, "the device connection stays, and is read again")
    #expect(stream.isReceiving)
    #expect(h.logs.contains { $0.contains("could not be verified") && $0.contains("wrong proof") })
    #expect(!h.logs.contains { $0.contains(h.secret!.hex) })

    // Refused without asking again for a while, then checked again.
    get(stream, "/", session)
    #expect(parseResponses(stream.take()).first?.error == .serverUnverified)
    #expect(h.verifier.checked.count == 1)
    h.scheduler.advance(GatewayServer.recheckAfterFailure)
    h.verifier.result = .verified
    get(stream, "/", session)
    #expect(h.verifier.checked.count == 2)
    #expect(h.upstreamRequest(0).head.target == "/api/ui/session")
  }

  @Test func everyFailureKindButUnreachableIsUnverified() {
    for failure: InstanceVerificationFailure in [.noSecret, .notOffered, .wrongProof, .badAnswer(status: 500)] {
      let h = GatewayHarness()
      let session = h.signedIn().session
      h.verifier.result = .failed(failure)
      let stream = h.connect()
      get(stream, "/", session, h)
      #expect(parseResponses(stream.take()).first?.error == .serverUnverified, "\(failure)")
    }
  }

  private func get(_ stream: FakeGatewayStream, _ path: String, _ session: DeviceSessionToken, _ h: GatewayHarness) {
    stream.receive(h.request("GET", path, [h.cookie(session)]))
  }

  @Test func aServerThatDoesNotAnswerIsUnavailableAndCheckedAgainNextTime() {
    let session = h.signedIn().session
    h.verifier.result = .failed(.unreachable("connection refused"))
    let stream = h.connect()
    get(stream, "/", session)
    #expect(parseResponses(stream.take()).first?.error == .serverUnavailable)
    #expect(stream.isReceiving)
    get(stream, "/", session)
    #expect(h.verifier.checked.count == 2)
  }

  @Test func aCheckThatTakesTooLongIsUnavailable() {
    let session = h.signedIn().session
    h.verifier.holding = true
    let stream = h.connect()
    get(stream, "/", session)
    h.scheduler.advance(GatewayServer.verificationTimeout)
    #expect(parseResponses(stream.take()).first?.status == 502)
    #expect(stream.isReceiving)
    h.verifier.answer(.verified)
    #expect(h.upstream.streams.isEmpty, "a late answer serves nobody")
  }

  @Test func concurrentRequestsShareOneCheck() {
    let session = h.signedIn().session
    h.verifier.holding = true
    let a = h.connect(), b = h.connect()
    get(a, "/a", session)
    get(b, "/b", session)
    #expect(h.verifier.checked.count == 1)
    h.verifier.answer(.verified)
    #expect(h.upstream.streams.count == 1, "one bootstrap for both")
  }

  @Test func aRestartedServerIsCheckedAgain() {
    let session = h.signedIn().session
    let stream = h.connect()
    get(stream, "/", session)
    h.answerBootstrap()
    h.upstream.streams[1].receive("HTTP/1.1 204 No Content\r\n\r\n")
    // Hivemind Server.app restarted its server: a new secret.
    h.secret = InstanceSecret(hex: String(repeating: "6b", count: 32))
    get(stream, "/", session)
    #expect(h.verifier.checked.map(\.secret) == [InstanceSecret(hex: String(repeating: "5a", count: 32)), h.secret])
    #expect(h.upstreamRequest(2).head.target == "/api/ui/session", "and bootstrapped again: the capability was the old process's")
  }

  @Test func aStaleCapabilityOrALostConnectionMeansCheckingAgain() {
    let session = h.signedIn().session
    let stream = h.connect()
    get(stream, "/", session)
    h.answerBootstrap()
    h.upstream.streams[1].receive("HTTP/1.1 401 Unauthorized\r\nX-Hivemind-Session-Required: 1\r\nContent-Length: 2\r\n\r\n{}")
    _ = stream.take()
    get(stream, "/", session)
    #expect(h.verifier.checked.count == 2, "the server said it restarted: whoever answers now proves itself first")
    h.answerBootstrap(2)
    h.upstream.streams[3].drop("refused")
    #expect(parseResponses(stream.take()).first?.error == .serverUnavailable)
    get(stream, "/", session)
    #expect(h.verifier.checked.count == 3)
  }

  @Test func everyWebSocketChecksAgain() {
    let session = h.signedIn().session
    let first = h.connect()
    get(first, "/", session)
    h.answerBootstrap()
    let ws = h.connect()
    ws.receive(h.request("GET", "/ws", GatewayHarness.upgrade + [h.cookie(session), ("Origin", GatewayHarness.origin)]))
    #expect(h.verifier.checked.count == 2)
    #expect(h.upstreamRequest(2).head.headers["Upgrade"] == "websocket")
  }

  @Test func terminalsNeedAVerifiedServerToo() throws {
    let session = h.signedIn().session
    h.verifier.result = .failed(.notOffered)
    let refused = h.connect()
    refused.receive(h.request("GET", GatewayPath.broker, GatewayHarness.upgrade + [h.cookie(session)]))
    #expect(parseResponses(refused.take()).first?.error == .serverUnverified)
    #expect(h.broker.connections.isEmpty)

    h.scheduler.advance(GatewayServer.recheckAfterFailure)
    h.verifier.result = .verified
    h.verifier.holding = true
    let stream = h.connect()
    stream.receive(h.request("GET", GatewayPath.broker, GatewayHarness.upgrade + [h.cookie(session)]))
    #expect(stream.sent.isEmpty, "no 101 before the check")
    h.verifier.answer(.verified)
    #expect(parseResponses(stream.take()).first?.status == 101)
    #expect(h.broker.connections.count == 1)
    #expect(stream.isReceiving)

    h.serverPort = nil
    let stopped = h.connect()
    stopped.receive(h.request("GET", GatewayPath.broker, GatewayHarness.upgrade + [h.cookie(session)]))
    #expect(parseResponses(stopped.take()).first?.error == .serverUnavailable)
  }

  @Test func brokerUpgradesWaitingForTheCheckCountAgainstTheLimit() {
    let session = h.signedIn().session
    h.verifier.holding = true
    for _ in 0..<GatewayLimits.maxBrokerConnectionsPerDevice {
      h.connect().receive(h.request("GET", GatewayPath.broker, GatewayHarness.upgrade + [h.cookie(session)]))
    }
    let extra = h.connect()
    extra.receive(h.request("GET", GatewayPath.broker, GatewayHarness.upgrade + [h.cookie(session)]))
    #expect(parseResponses(extra.take()).first?.status == 429)
  }

  @Test func failingTheCheckClosesWhatIsForwardedAlready() {
    let session = h.signedIn().session
    let http = h.connect()
    get(http, "/", session)
    h.answerBootstrap()
    let ws = h.connect()
    ws.receive(h.request("GET", "/ws", GatewayHarness.upgrade + [h.cookie(session), ("Origin", GatewayHarness.origin)]))
    h.upstream.streams[2].receive("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n")
    let terminals = h.connect()
    terminals.receive(h.request("GET", GatewayPath.broker, GatewayHarness.upgrade + [h.cookie(session)]))
    let idle = h.connect()

    // Something else took the port: the next /ws check fails.
    h.verifier.result = .failed(.wrongProof)
    let again = h.connect()
    again.receive(h.request("GET", "/ws", GatewayHarness.upgrade + [h.cookie(session), ("Origin", GatewayHarness.origin)]))
    #expect(parseResponses(again.take()).first?.error == .serverUnverified)
    #expect(ws.closed && terminals.closed && http.closed)
    #expect(h.broker.current.closed)
    #expect(!idle.closed)
  }
}

@MainActor
struct GatewayResumesReadingTests {
  let h = GatewayHarness()

  /// Regression: an answer sent from an async completion left a kept-alive
  /// connection with receiving off, so its next request was never read.
  @Test func afterAFailedBootstrap() {
    let session = h.signedIn().session
    let stream = h.connect()
    stream.receive(h.request("GET", "/", [h.cookie(session)]))
    #expect(!stream.isReceiving, "not read while waiting")
    h.upstream.streams[0].drop("refused")
    #expect(parseResponses(stream.take()).first?.status == 502)
    #expect(stream.isReceiving)
    #expect(!stream.closed)
    stream.receive(h.request("GET", "/again", [h.cookie(session)]))
    #expect(h.upstream.streams.count == 2, "the next request is read and served")
  }

  @Test func afterTheServerClosedWithoutAnswering() {
    let session = h.signedIn().session
    let stream = h.connect()
    stream.receive(h.request("GET", "/", [h.cookie(session)]))
    h.answerBootstrap()
    #expect(!stream.isReceiving, "the request is done: the device is not read until the answer")
    h.upstream.streams[1].drop("reset")
    #expect(parseResponses(stream.take()).first?.status == 502)
    #expect(stream.isReceiving)
    #expect(!stream.closed)
    stream.receive(h.request("GET", "/again", [h.cookie(session)]))
    #expect(h.upstream.streams.count == 3)
    #expect(h.upstreamRequest(2).head.target == "/again")
  }

  @Test func afterAnUnverifiedAnswerWithAPipelinedRequest() {
    let session = h.signedIn().session
    h.verifier.holding = true
    let stream = h.connect()
    // Two requests at once; the second waits in the buffer.
    stream.receive(h.request("GET", "/one", [h.cookie(session)]) + h.request("GET", "/two", [h.cookie(session)]))
    h.verifier.answer(.failed(.wrongProof))
    let answers = parseResponses(stream.take())
    #expect(answers.map(\.status) == [503, 503], "the pipelined request is parsed once reading resumes")
    #expect(stream.isReceiving)
  }

  @Test func afterAnAsyncBrokerRefusal() {
    let session = h.signedIn().session
    h.verifier.holding = true
    let stream = h.connect()
    stream.receive(h.request("GET", GatewayPath.broker, GatewayHarness.upgrade + [h.cookie(session)]))
    h.verifier.answer(.failed(.unreachable("down")))
    #expect(parseResponses(stream.take()).first?.status == 502)
    #expect(stream.isReceiving)
  }
}

@MainActor
struct GatewayEndpointLengthTests {
  let h = GatewayHarness()

  @Test func aChunkedPairIsLengthRequiredAndCloses() throws {
    let stream = h.connect()
    stream.receive("POST /_hivemind/pair HTTP/1.1\r\nHost: \(GatewayHarness.host)\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}\r\n0\r\n\r\n")
    let response = try #require(parseResponses(stream.sent).first)
    #expect(response.status == 411)
    #expect(response.error == .lengthRequired)
    #expect(response.head.headers["Connection"] == "close")
    #expect(stream.closed)
  }

  @Test func aSessionWithoutAnyLengthIsLengthRequiredAndCloses() {
    let (token, _) = h.pair()
    let stream = h.connect()
    stream.receive(h.request("POST", GatewayPath.session, [("Authorization", "Bearer \(token.value)")]))
    #expect(parseResponses(stream.sent).first?.error == .lengthRequired)
    #expect(stream.closed)
  }

  @Test func anEmptyOrSmallSessionBodyIsFine() {
    let (token, _) = h.pair()
    let stream = h.connect()
    #expect(h.postSession(stream, "Bearer \(token.value)").status == 200)
    stream.receive(h.request("POST", GatewayPath.session, [("Authorization", "Bearer \(token.value)"), ("Content-Type", "application/json")], body: "{}"))
    #expect(parseResponses(stream.take()).last?.status == 200)
    #expect(!stream.closed)
  }
}

/// The supervisor saw the server exit or leave `.running`: the gateway stops
/// forwarding to it at once, event-driven through
/// GatewayServer.serverChanged (docs/remote-access.md#verified-server).
@MainActor
struct GatewayServerGoneTests {
  let h = GatewayHarness()
  static let accept = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n\r\n"

  func get(_ stream: FakeGatewayStream, _ path: String, _ session: DeviceSessionToken) {
    stream.receive(h.request("GET", path, [h.cookie(session)]))
  }

  func webSocket(_ session: DeviceSessionToken) -> FakeGatewayStream {
    let ws = h.connect()
    ws.receive(h.request("GET", "/ws", GatewayHarness.upgrade + [h.cookie(session), ("Origin", GatewayHarness.origin)]))
    return ws
  }

  @Test func anExitedServerLosesItsTrustCapabilityAndForwardedConnectionsAtOnce() throws {
    let session = h.signedIn().session
    let http = h.connect()
    get(http, "/slow", session)
    h.answerBootstrap()
    let pending = h.upstream.streams[1]
    let ws = webSocket(session)
    h.upstream.streams[2].receive(Self.accept)
    let terminals = h.connect()
    terminals.receive(h.request("GET", GatewayPath.broker, GatewayHarness.upgrade + [h.cookie(session)]))
    #expect(parseResponses(terminals.take()).first?.status == 101)
    let idle = h.connect()
    _ = http.take()
    _ = ws.take()
    #expect(h.server.isVerified)
    let checks = h.verifier.checked.count

    // The Node process exited: the supervisor leaves .running.
    h.serverPort = nil
    h.server.serverChanged()

    #expect(!h.server.isVerified)
    #expect(h.server.trust == .unchecked)
    let answer = try #require(parseResponses(http.take()).first)
    #expect(answer.status == 502 && answer.error == .serverUnavailable, "the request in flight is answered, not left hanging")
    #expect(pending.closed, "its loopback connection closes now")
    #expect(!http.closed && http.isReceiving, "a kept-alive device connection stays for the next request")
    #expect(ws.closed && h.upstream.streams[2].closed, "/ws to the old process closes")
    #expect(!terminals.closed && !h.broker.current.closed, "the broker is this app's own: terminals stay")
    #expect(!idle.closed)
    #expect(h.logs.contains { $0.contains("the server stopped") })

    // New requests are refused, and nothing is checked or bootstrapped.
    let streams = h.upstream.streams.count
    get(http, "/again", session)
    #expect(parseResponses(http.take()).first?.error == .serverUnavailable)
    #expect(h.upstream.streams.count == streams)
    #expect(h.verifier.checked.count == checks)

    // The restarted server is ready: it proves itself, and a new Human
    // capability is bootstrapped for it before anything is forwarded.
    h.serverPort = 7420
    h.secret = InstanceSecret(hex: String(repeating: "6b", count: 32))
    h.server.serverChanged()
    get(http, "/again", session)
    #expect(h.verifier.checked.count == checks + 1)
    #expect(h.verifier.checked.last?.secret == h.secret)
    #expect(h.upstreamRequest(streams).head.target == "/api/ui/session")
  }

  @Test func aCheckInFlightAnswersUnavailableAndItsLateVerdictServesNobody() {
    let session = h.signedIn().session
    h.verifier.holding = true
    let stream = h.connect()
    get(stream, "/", session)
    h.serverPort = nil
    h.server.serverChanged()
    #expect(parseResponses(stream.take()).first?.status == 502)
    #expect(stream.isReceiving)
    h.verifier.answer(.verified)
    #expect(h.upstream.streams.isEmpty, "a verdict about the old process forwards nothing")
    #expect(!h.server.isVerified)
  }

  @Test func aBootstrapInFlightIsAbandoned() {
    let session = h.signedIn().session
    let stream = h.connect()
    get(stream, "/", session)
    let bootstrap = h.upstream.streams[0]
    h.serverPort = nil
    h.server.serverChanged()
    #expect(bootstrap.closed)
    #expect(parseResponses(stream.take()).first?.error == .serverUnavailable)
    h.answerBootstrap()
    #expect(h.upstream.streams.count == 1, "a late Human session from the old process is not used")
  }

  @Test func aResponseUnderWayClosesTheDeviceConnection() {
    let session = h.signedIn().session
    let stream = h.connect()
    get(stream, "/big", session)
    h.answerBootstrap()
    h.upstream.streams[1].receive("HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\npartial")
    h.serverPort = nil
    h.server.serverChanged()
    #expect(stream.closed, "half a response cannot be finished: the device sees the connection end")
    #expect(h.upstream.streams[1].closed)
  }

  @Test func stoppingOrRestartingCountsAsGoneToo() {
    // The supervisor's .stopping has a pid but is not .running: the harness
    // stands for it the way ServerAppController.gatewayUpstream does, nil.
    let session = h.signedIn().session
    let ws = webSocket(session)
    h.answerBootstrap()
    h.upstream.streams[1].receive(Self.accept)
    h.serverPort = nil
    h.server.serverChanged()
    #expect(ws.closed)
  }

  @Test func theSameServerKeepsEverything() {
    let session = h.signedIn().session
    let stream = h.connect()
    get(stream, "/", session)
    h.answerBootstrap()
    let logs = h.logs.count
    h.server.serverChanged()
    #expect(h.server.isVerified)
    #expect(!h.upstream.streams[1].closed)
    #expect(h.logs.count == logs, "nothing to say when nothing changed")
    h.upstream.streams[1].receive("HTTP/1.1 204 No Content\r\n\r\n")
    get(stream, "/next", session)
    #expect(h.verifier.checked.count == 1, "no new check")
    #expect(h.upstreamRequest(2).head.target == "/next", "and no new bootstrap")
  }

  @Test func aStoppedGatewayIgnoresIt() {
    h.server.stop()
    h.serverPort = nil
    h.server.serverChanged()
    #expect(h.logs.isEmpty)
  }
}
