import Foundation

// One device connection to the gateway: HTTP/1.1 requests one after another
// (keep-alive), each either answered by the gateway itself or proxied to the
// Node server over a fresh loopback connection, until one of them becomes a
// WebSocket (/ws, spliced to the server; /_hivemind/broker, bridged to the
// terminal broker). docs/remote-access.md#proxy has the rules.
//
// Flow control everywhere: the gateway reads from one side only while the
// other still takes what it is sent (GatewayStream.send's completion), so a
// slow device or a slow server holds the other back through TCP instead of
// filling the Mac's memory.

@MainActor
final class GatewayConnection {
  let stream: any GatewayStream
  let local: IPAddress
  let remote: IPAddress
  let remoteKey: String
  private weak var server: GatewayServer?
  /// The device whose session the last authenticated request carried: the
  /// connection closes when that device is revoked.
  private(set) var deviceId: UUID?

  private var state = State.head
  private var buffer = Data()
  private var timer: (any Cancellable)?
  private var timerIsHeadDeadline = false
  private(set) var devicePendingBytes = 0
  private var receiving = true
  private var finished = false
  private var processing = false
  private var processAgain = false

  /// Above this many bytes owed by a peer, the gateway stops reading the
  /// other side; at or below `lowWater` it reads again.
  static let highWater = 1 << 20
  static let lowWater = 256 << 10
  /// A refused request's body is read and dropped (keeping the connection)
  /// only up to this; a larger one closes the connection instead.
  static let maxDrainBytes: Int64 = 1 << 20
  static let continueResponse = Data("HTTP/1.1 100 Continue\r\n\r\n".utf8)

  enum State {
    case head
    case gatewayBody(GatewayBodyRequest)
    /// Waiting for the server's instance check (and, for a proxied request,
    /// the Human capability) before anything goes out. The device is not
    /// read meanwhile; every way out of here resumes reading or closes.
    case waiting
    case proxy(ProxyExchange)
    /// The answer went out before the request body ended: the rest of the
    /// body is read and dropped.
    case drain(HTTPBodyDecoder, keepAlive: Bool)
    case webSocket(ProxyExchange)
    case broker(GatewayBrokerBridge)
    case closed
  }

  struct GatewayBodyRequest {
    let route: GatewayRoute
    let head: HTTPRequestHead
    var decoder: HTTPBodyDecoder
    var body = Data()
  }

  init(stream: any GatewayStream, local: IPAddress, remote: IPAddress, remoteKey: String, server: GatewayServer) {
    self.stream = stream
    self.local = local
    self.remote = remote
    self.remoteKey = remoteKey
    self.server = server
  }

  /// A broker bridge, or a broker upgrade waiting for the server's check:
  /// both count against the per-device limit.
  var isBroker: Bool {
    if case .broker = state { return true }
    return brokerPending
  }
  private var brokerPending = false

  /// Whether this connection carries anything to or from the Node server or
  /// the broker (a proxied request, /ws, terminals): closed when the server
  /// fails its instance check.
  var isForwarding: Bool {
    switch state {
    case .proxy, .webSocket, .broker: true
    case .waiting, .head, .gatewayBody, .drain, .closed: false
    }
  }

  func start() {
    stream.start(handlers: GatewayStreamHandlers(
      onData: { [weak self] data in self?.received(data) },
      onClose: { [weak self] reason in self?.finish(reason) }))
    armTimer(headDeadline: true)
  }

  /// Revocation, remote access turned off, or the app quitting.
  func terminate() { finish("closed by the gateway") }

  /// The server this connection forwards to is no longer `current` (it
  /// exited or stopped being ready): its loopback connection closes now. A
  /// request not answered yet gets server-unavailable, and a kept-alive
  /// connection stays for the next request; one whose answer or `/ws` is
  /// under way closes. True when it was forwarding to that server.
  func serverGone(keeping current: GatewayUpstreamServer?) -> Bool {
    guard !finished else { return false }
    switch state {
    case .proxy(let exchange) where exchange.server != current, .webSocket(let exchange) where exchange.server != current:
      upstreamFailed(exchange, "the server stopped")
      return true
    default:
      return false
    }
  }

  // MARK: Device input

  private func received(_ data: Data) {
    guard !finished else { return }
    buffer.append(data)
    process()
  }

  private func process() {
    guard !processing else {
      processAgain = true
      return
    }
    processing = true
    repeat {
      processAgain = false
      while !finished, step() {}
    } while processAgain && !finished
    processing = false
    if !finished { updateReceiving() }
  }

  /// One step of the current state; true when the state changed and the
  /// next one may have work too.
  private func step() -> Bool {
    switch state {
    case .head:
      guard !buffer.isEmpty else { return false }
      if !timerIsHeadDeadline { armTimer(headDeadline: true) }
      let parsed: (head: HTTPRequestHead, length: Int)?
      do {
        parsed = try HTTPHeadParser.request(in: buffer)
      } catch {
        reply(.error(error), closing: true)
        return false
      }
      guard let parsed else { return false }
      buffer.removeFirst(parsed.length)
      begin(parsed.head)
      return true

    case .gatewayBody(var request):
      do {
        for piece in try request.decoder.decode(&buffer) { request.body.append(piece) }
      } catch {
        reply(.error(error), closing: true)
        return false
      }
      guard request.decoder.isComplete else {
        state = .gatewayBody(request)
        return false
      }
      guard let server else {
        finish(nil)
        return false
      }
      let answer = request.route == .pair
        ? server.pair(request.head, body: request.body, remote: remote)
        : server.session(request.head, remote: remote)
      reply(answer, closing: !request.head.keepsAlive)
      return true

    case .waiting, .closed:
      return false

    case .proxy(let exchange):
      guard !exchange.requestDone, !buffer.isEmpty, exchange.upstreamPending < Self.highWater else { return false }
      let pieces: [Data]
      do {
        pieces = try exchange.requestBody.decode(&buffer)
      } catch {
        // Part of the body is already with the server: nothing to answer.
        finish("request body: \(error.gatewayMessage)")
        return false
      }
      for piece in pieces { sendUpstream(exchange, HTTPBodyEncoder.encode(piece, framing: exchange.upstreamFraming)) }
      if exchange.requestBody.isComplete {
        exchange.requestDone = true
        let end = HTTPBodyEncoder.end(framing: exchange.upstreamFraming)
        if !end.isEmpty { sendUpstream(exchange, end) }
      }
      return false

    case .drain(var decoder, let keepAlive):
      guard !buffer.isEmpty else { return false }
      do {
        _ = try decoder.decode(&buffer)
      } catch {
        finish(nil)
        return false
      }
      guard decoder.isComplete else {
        state = .drain(decoder, keepAlive: keepAlive)
        return false
      }
      if keepAlive {
        enterHead()
        return true
      }
      finish(nil)
      return false

    case .webSocket(let exchange):
      guard !buffer.isEmpty else { return false }
      let data = buffer
      buffer = Data()
      sendUpstream(exchange, data)
      return false

    case .broker(let bridge):
      guard !buffer.isEmpty else { return false }
      let data = buffer
      buffer = Data()
      bridge.receive(data)
      return false
    }
  }

  private func updateReceiving() {
    let wanted: Bool = switch state {
    case .head, .gatewayBody, .drain: true
    case .waiting, .closed: false
    case .proxy(let exchange): !exchange.requestDone && exchange.upstreamPending < Self.highWater
    case .webSocket(let exchange): exchange.upstreamPending < Self.highWater
    case .broker: true
    }
    guard wanted != receiving else { return }
    receiving = wanted
    stream.setReceiving(wanted)
  }

  // MARK: Requests

  private func begin(_ head: HTTPRequestHead) {
    guard let server else { return finish(nil) }
    // Framing first: when it cannot be read, neither can the next request.
    let framing: HTTPBodyFraming
    do {
      framing = try head.bodyFraming()
    } catch {
      return reply(.error(error), closing: true)
    }
    var expectsContinue = false
    if head.headers.contains("Expect") {
      // The body may or may not follow a refusal: the connection cannot be kept.
      guard head.headers.values("Expect").map({ $0.lowercased() }) == ["100-continue"] else {
        return reply(.error(GatewayError(.badRequest, "Expect: only 100-continue")), closing: true)
      }
      expectsContinue = true
    }
    let deny = { (error: GatewayError) in self.refuse(error, head: head, framing: framing, canDrain: !expectsContinue) }

    let route: GatewayRoute, endpoint: GatewayEndpoint
    do {
      let allowed = GatewayPolicy.allowedEndpoints(local: local, port: server.configuration.port, names: server.configuration.hostNames)
      (route, endpoint) = try GatewayPolicy.route(head, allowed: allowed)
    } catch {
      return deny(error)
    }

    switch route {
    case .pair, .session:
      switch framing {
      // An empty body needs its Content-Length: 0 too (framing reads it as none).
      case .none where head.headers.contains("Content-Length"): break
      case .length(let length) where length <= Int64(GatewayLimits.maxGatewayBodyBytes): break
      case .length: return reply(.error(GatewayError(.tooLarge, "the body is too large")), closing: true)
      case .none, .chunked, .untilClose:
        // Chunked, or no length at all: the body cannot be bounded before it
        // is read, so the connection is not kept either.
        return reply(.error(GatewayError(.lengthRequired, "\(head.path) needs a Content-Length")), closing: true)
      }
      if expectsContinue { sendToDevice(Self.continueResponse) }
      state = .gatewayBody(GatewayBodyRequest(
        route: route, head: head, decoder: HTTPBodyDecoder(framing: framing, limit: Int64(GatewayLimits.maxGatewayBodyBytes))))

    case .broker(let key):
      guard framing == .none else { return deny(GatewayError(.badRequest, "a WebSocket upgrade has no body")) }
      guard let device = identify(head) else { return deny(Self.noSession) }
      guard device.permissions.contains(.terminals) else {
        return deny(GatewayError(.unauthorized, "This device may not use terminals."))
      }
      guard server.brokerConnections(of: device.id) < GatewayLimits.maxBrokerConnectionsPerDevice else {
        return deny(GatewayError(.rateLimited, "Too many terminal connections from this device."))
      }
      // Terminals only beside a verified server, as Hivemind.app gives a
      // page terminals only from one (TerminalTrustGate).
      guard let target = server.deps.server() else { return deny(Self.serverNotRunning) }
      cancelTimer()
      state = .waiting
      brokerPending = true
      server.withVerifiedServer(target, fresh: true) { [weak self] verdict in
        guard let self, !self.finished, case .waiting = self.state, let server = self.server else { return }
        self.brokerPending = false
        switch verdict {
        case .unavailable: return deny(Self.serverDidNotAnswer)
        case .unverified: return deny(Self.serverUnverified)
        case .verified: break
        }
        guard let token = server.deps.brokerToken() else {
          return deny(GatewayError(.serverUnavailable, "Terminals are not running in Hivemind Server."))
        }
        self.sendToDevice(WebSocketHandshake.response(forKey: key).serialized)
        let bridge = GatewayBrokerBridge(device: device, token: token, connection: self)
        self.state = .broker(bridge)
        bridge.start(connector: server.deps.broker)
        self.process()
      }

    case .proxy, .proxyWebSocket:
      guard identify(head) != nil else { return deny(Self.noSession) }
      guard let target = server.deps.server() else { return deny(Self.serverNotRunning) }
      if case .length(let length) = framing, length > GatewayLimits.maxProxiedRequestBodyBytes {
        return reply(.error(GatewayError(.tooLarge, "the body is too large")), closing: true)
      }
      cancelTimer()
      state = .waiting
      // A WebSocket is the page (re)connecting: the server is checked again.
      server.withCapability(target, fresh: route == .proxyWebSocket) { [weak self] access in
        guard let self, !self.finished, case .waiting = self.state, let server = self.server else { return }
        switch access {
        case .unavailable:
          self.refuse(Self.serverDidNotAnswer, head: head, framing: framing, canDrain: !expectsContinue)
        case .unverified:
          self.refuse(Self.serverUnverified, head: head, framing: framing, canDrain: !expectsContinue)
        case .capability(let capability):
          self.startProxy(ProxyExchange(
            request: head, endpoint: endpoint, server: target, capability: capability, framing: framing,
            webSocket: route == .proxyWebSocket, upstream: server.deps.upstream.connect(port: target.port)),
            expectsContinue: expectsContinue)
        }
      }
    }
  }

  static let noSession = GatewayError(.unauthorized, "The device session is missing or has expired.")
  static let serverNotRunning = GatewayError(.serverUnavailable, "Hivemind Server is not running its server.")
  static let serverDidNotAnswer = GatewayError(.serverUnavailable, "Hivemind Server did not answer.")
  static let serverUnverified = GatewayError(
    .serverUnverified, "Hivemind Server could not verify the server on its port, so this Mac forwards nothing to it. Restart the server from Hivemind Server’s menu.")

  private func identify(_ head: HTTPRequestHead) -> DeviceRecord? {
    guard let device = server?.authenticate(head) else { return nil }
    deviceId = device.id
    return device
  }

  /// Answers a request the gateway will not serve. Its body, if any, is read
  /// and dropped when that is cheap and safe, so the connection stays;
  /// otherwise the connection closes after the answer.
  private func refuse(_ error: GatewayError, head: HTTPRequestHead, framing: HTTPBodyFraming, canDrain: Bool) {
    let keepAlive = head.keepsAlive
    switch framing {
    case .none:
      reply(.error(error), closing: !keepAlive)
    case .length(let length) where canDrain && length <= Self.maxDrainBytes:
      sendToDevice(GatewayReply.error(error).serialized(close: !keepAlive))
      state = .drain(HTTPBodyDecoder(framing: framing, limit: length), keepAlive: keepAlive)
      armTimer(headDeadline: true)
      process()
    default:
      reply(.error(error), closing: true)
    }
  }

  private func reply(_ reply: GatewayReply, closing: Bool) {
    sendToDevice(reply.serialized(close: closing))
    if closing { finish(nil) } else { enterHead() }
  }

  /// Ready for the next request. Reading resumes here, whoever got the
  /// connection here: an answer sent from an async completion (the server's
  /// check, the Human bootstrap, a failed upstream) runs outside the
  /// process() loop, and in `.waiting` or a finished `.proxy` the device was
  /// no longer being read. process() re-enables it (and parses whatever
  /// the device already sent); inside the loop it just runs one more round.
  private func enterHead() {
    state = .head
    armTimer(headDeadline: !buffer.isEmpty)
    process()
  }

  // MARK: Proxy

  private func startProxy(_ exchange: ProxyExchange, expectsContinue: Bool) {
    state = .proxy(exchange)
    exchange.upstream.start(handlers: GatewayStreamHandlers(
      onData: { [weak self, weak exchange] data in
        guard let self, let exchange else { return }
        self.upstreamReceived(data, exchange)
      },
      onClose: { [weak self, weak exchange] reason in
        guard let self, let exchange else { return }
        self.upstreamClosed(reason, exchange)
      }))
    let head = GatewayRewrite.upstreamRequest(
      exchange.request, serverPort: exchange.port, capability: exchange.capability,
      framing: exchange.upstreamFraming, webSocket: exchange.webSocket)
    sendUpstream(exchange, head.serialized)
    if exchange.requestBody.isComplete {
      exchange.requestDone = true
    } else if expectsContinue {
      sendToDevice(Self.continueResponse)
    }
    process()
  }

  private func isCurrent(_ exchange: ProxyExchange) -> Bool {
    switch state {
    case .proxy(let current), .webSocket(let current): current === exchange
    default: false
    }
  }

  private func upstreamReceived(_ data: Data, _ exchange: ProxyExchange) {
    guard !finished, isCurrent(exchange) else { return }
    if case .webSocket = state {
      sendToDevice(data)
      throttle(exchange)
      return
    }
    guard exchange.response == nil else {
      var rest = data
      forwardResponseBody(&rest, exchange)
      return
    }
    exchange.responseBuffer.append(data)
    while exchange.response == nil {
      let parsed: (head: HTTPResponseHead, length: Int)?
      do {
        parsed = try HTTPHeadParser.response(in: exchange.responseBuffer)
      } catch {
        return upstreamFailed(exchange, "a malformed response: \(error.gatewayMessage)")
      }
      guard let (head, length) = parsed else { return }
      exchange.responseBuffer.removeFirst(length)
      if head.status == 101 {
        guard exchange.webSocket else { return upstreamFailed(exchange, "an unasked-for upgrade") }
        return beginWebSocket(exchange, head)
      }
      // 100 Continue and friends: the gateway answered Expect itself.
      if head.isInformational { continue }
      let upstreamFraming: HTTPBodyFraming
      do {
        upstreamFraming = try head.bodyFraming(requestMethod: exchange.request.method)
      } catch {
        return upstreamFailed(exchange, error.gatewayMessage)
      }
      if GatewayRewrite.requiresNewCapability(head) { server?.invalidate(exchange.capability) }
      exchange.downstreamFraming = GatewayRewrite.downstreamFraming(upstreamFraming, deviceVersion: exchange.request.version)
      if exchange.webSocket || exchange.downstreamFraming == .untilClose { exchange.keepAlive = false }
      exchange.response = head
      exchange.responseBody = HTTPBodyDecoder(framing: upstreamFraming, limit: GatewayLimits.maxProxiedResponseBodyBytes)
      sendToDevice(GatewayRewrite.downstreamResponse(
        head, serverPort: exchange.port, gatewayOrigin: exchange.endpoint.origin,
        framing: exchange.downstreamFraming, close: !exchange.keepAlive, webSocket: false).serialized)
    }
    var rest = exchange.responseBuffer
    exchange.responseBuffer = Data()
    forwardResponseBody(&rest, exchange)
  }

  private func forwardResponseBody(_ data: inout Data, _ exchange: ProxyExchange) {
    guard !exchange.responseDone, var decoder = exchange.responseBody else { return }
    let pieces: [Data]
    do {
      pieces = try decoder.decode(&data)
    } catch {
      return finish("response body: \(error.gatewayMessage)")
    }
    exchange.responseBody = decoder
    for piece in pieces { sendToDevice(HTTPBodyEncoder.encode(piece, framing: exchange.downstreamFraming)) }
    throttle(exchange)
    if decoder.isComplete { responseFinished(exchange) }
  }

  private func responseFinished(_ exchange: ProxyExchange) {
    exchange.responseDone = true
    let end = HTTPBodyEncoder.end(framing: exchange.downstreamFraming)
    if !end.isEmpty { sendToDevice(end) }
    exchange.upstream.close()
    if exchange.requestDone {
      if exchange.keepAlive { enterHead() } else { finish(nil) }
    } else if exchange.keepAlive, case .length(let total) = exchange.requestBody.framing,
              total - exchange.requestBody.received <= Self.maxDrainBytes {
      // The server answered before the body ended (a refusal, say).
      state = .drain(exchange.requestBody, keepAlive: true)
      armTimer(headDeadline: true)
    } else {
      finish(nil)
    }
    process()
  }

  private func upstreamClosed(_ reason: String?, _ exchange: ProxyExchange) {
    guard !finished, isCurrent(exchange) else { return }
    if case .webSocket = state { return finish(reason) }
    guard exchange.response != nil else { return upstreamFailed(exchange, reason ?? "closed before answering") }
    guard !exchange.responseDone else { return }
    if var decoder = exchange.responseBody, decoder.finishAtClose() {
      exchange.responseBody = decoder
      responseFinished(exchange)
    } else {
      finish("the server closed in the middle of a response")
    }
  }

  private func upstreamFailed(_ exchange: ProxyExchange, _ why: String) {
    server?.deps.log("[gateway] \(exchange.request.method) \(exchange.request.path): \(why)")
    exchange.upstream.close()
    guard exchange.response == nil else { return finish(why) }
    // Whatever answers on the port next is checked before it gets anything.
    server?.upstreamLost()
    reply(.error(Self.serverDidNotAnswer), closing: !(exchange.requestDone && exchange.keepAlive))
  }

  private func beginWebSocket(_ exchange: ProxyExchange, _ head: HTTPResponseHead) {
    exchange.response = head
    exchange.responseDone = true
    sendToDevice(GatewayRewrite.downstreamResponse(
      head, serverPort: exchange.port, gatewayOrigin: exchange.endpoint.origin,
      framing: .none, close: false, webSocket: true).serialized)
    state = .webSocket(exchange)
    cancelTimer()
    let early = exchange.responseBuffer
    exchange.responseBuffer = Data()
    if !early.isEmpty { sendToDevice(early) }
    process()
  }

  // MARK: Sending

  func sendToDevice(_ data: Data) {
    guard !finished, !data.isEmpty else { return }
    let count = data.count
    devicePendingBytes += count
    stream.send(data) { [weak self] in
      guard let self else { return }
      self.devicePendingBytes -= count
      if self.devicePendingBytes <= Self.lowWater { self.deviceDrained() }
    }
  }

  private func sendUpstream(_ exchange: ProxyExchange, _ data: Data) {
    let count = data.count
    exchange.upstreamPending += count
    exchange.upstream.send(data) { [weak self, weak exchange] in
      guard let self, let exchange else { return }
      exchange.upstreamPending -= count
      if exchange.upstreamPending <= Self.lowWater, self.isCurrent(exchange) { self.process() }
    }
  }

  /// A slow device: stop reading the server until it caught up.
  private func throttle(_ exchange: ProxyExchange) {
    guard devicePendingBytes > Self.highWater, exchange.upstreamReading else { return }
    exchange.upstreamReading = false
    exchange.upstream.setReceiving(false)
  }

  private func deviceDrained() {
    guard !finished else { return }
    switch state {
    case .proxy(let exchange), .webSocket(let exchange):
      if !exchange.upstreamReading {
        exchange.upstreamReading = true
        exchange.upstream.setReceiving(true)
      }
    case .broker(let bridge):
      bridge.deviceDrained()
    default:
      break
    }
  }

  // MARK: Timers and closing

  /// The head deadline runs while a request head (or a small body) is on
  /// its way; the idle timeout while a kept-alive connection waits for one.
  private func armTimer(headDeadline: Bool) {
    timer?.cancel()
    timerIsHeadDeadline = headDeadline
    guard let server else { return }
    let delay = headDeadline ? GatewayLimits.requestHeadTimeout : GatewayLimits.idleTimeout
    timer = server.deps.scheduler.schedule(after: delay) { [weak self] in
      self?.finish(headDeadline ? "the request did not arrive in time" : nil)
    }
  }

  private func cancelTimer() {
    timer?.cancel()
    timer = nil
    timerIsHeadDeadline = false
  }

  /// Ends the connection: queued bytes still go out, then the stream
  /// closes, and with it whatever it was connected to.
  func finish(_ reason: String?) {
    guard !finished else { return }
    finished = true
    cancelTimer()
    switch state {
    case .proxy(let exchange), .webSocket(let exchange): exchange.upstream.close()
    case .broker(let bridge): bridge.close()
    default: break
    }
    state = .closed
    stream.close()
    server?.removed(self)
  }
}

/// One proxied request and its response.
@MainActor
final class ProxyExchange {
  let request: HTTPRequestHead
  let endpoint: GatewayEndpoint
  /// The server process it goes to: when that one exits, so does this.
  let server: GatewayUpstreamServer
  var port: Int { server.port }
  let capability: HumanCapability
  let webSocket: Bool
  let upstream: any GatewayStream
  /// The device's framing, forwarded as is (framed again by the gateway).
  let upstreamFraming: HTTPBodyFraming
  var requestBody: HTTPBodyDecoder
  var requestDone = false
  var keepAlive: Bool
  var upstreamPending = 0
  var upstreamReading = true

  var responseBuffer = Data()
  var response: HTTPResponseHead?
  var responseBody: HTTPBodyDecoder?
  var downstreamFraming = HTTPBodyFraming.none
  var responseDone = false

  init(request: HTTPRequestHead, endpoint: GatewayEndpoint, server: GatewayUpstreamServer, capability: HumanCapability,
       framing: HTTPBodyFraming, webSocket: Bool, upstream: any GatewayStream) {
    self.request = request
    self.endpoint = endpoint
    self.server = server
    self.capability = capability
    self.webSocket = webSocket
    self.upstream = upstream
    upstreamFraming = framing
    requestBody = HTTPBodyDecoder(framing: framing, limit: GatewayLimits.maxProxiedRequestBodyBytes)
    keepAlive = request.keepsAlive && !webSocket
  }
}

extension Error {
  /// A GatewayError's, BrokerProtocolError's or WebSocketProtocolError's own
  /// message, for the log and the close reason.
  var gatewayMessage: String {
    switch self {
    case let error as GatewayError: error.message
    case let error as BrokerProtocolError: error.message
    case let error as WebSocketProtocolError: error.message
    default: "\(self)"
    }
  }
}
