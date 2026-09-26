import Foundation

// The terminal broker over the remote gateway (docs/remote-access.md#terminal-broker).
//
// A device reaches the broker at wss://<gateway>/_hivemind/broker with its
// device-session cookie. On that WebSocket every message is one broker frame
// (docs/terminal-broker.md#protocol): a text message holding one JSON object,
// with or without its trailing newline. The gateway bridges it to the local
// Unix socket and speaks the same protocol there, with one change: it
// replaces the token of the device's `hello` with the broker token it holds,
// so no device ever sees broker.token.
//
// On the device, WebSocketBrokerConnector makes such a WebSocket look like
// the byte stream BrokerClient already speaks, so the iOS app reuses
// BrokerClient and TerminalBridgeRouter unchanged. The WebSocket itself
// (URLSessionWebSocketTask with certificate pinning and the session cookie)
// sits behind WebSocketChannel, which the tests fake.

/// What a WebSocket tells its user, always on the main actor and in order:
/// `onOpen` once, then `onMessage` any number of times, then `onClose` once
/// (without `onOpen` when the upgrade failed). Nothing arrives after close().
public struct WebSocketChannelHandlers: Sendable {
  public var onOpen: @MainActor @Sendable () -> Void
  /// A text message's UTF-8 bytes. A binary message is a protocol error the
  /// channel reports through onClose instead.
  public var onMessage: @MainActor @Sendable (Data) -> Void
  /// A reason for the log, or nil for an orderly close.
  public var onClose: @MainActor @Sendable (String?) -> Void

  public init(
    onOpen: @escaping @MainActor @Sendable () -> Void,
    onMessage: @escaping @MainActor @Sendable (Data) -> Void,
    onClose: @escaping @MainActor @Sendable (String?) -> Void
  ) {
    self.onOpen = onOpen
    self.onMessage = onMessage
    self.onClose = onClose
  }
}

/// One message-oriented WebSocket (the iOS app's is URLSessionWebSocketTask).
@MainActor
public protocol WebSocketChannel: AnyObject {
  /// Opens the connection. Separate from creation so the owner holds the
  /// channel before any handler can run.
  func start(handlers: WebSocketChannelHandlers)
  /// Sends one text message; `message` is UTF-8.
  func send(_ message: Data)
  /// Stops (false) or resumes (true) receiving. URLSessionWebSocketTask
  /// receives one message per receive() call, so pausing is simply not
  /// asking for the next one; TCP then pushes back to the gateway, and the
  /// gateway's reading of the broker (and the broker's of the PTYs) stops.
  func setReceiving(_ receiving: Bool)
  /// Closes the connection; no handler runs after this.
  func close()
}

/// A BrokerConnecting over WebSocket channels: each connection asks
/// `makeChannel` for a new one.
public struct WebSocketBrokerConnector: BrokerConnecting {
  public let makeChannel: @MainActor () -> any WebSocketChannel

  public init(makeChannel: @escaping @MainActor () -> any WebSocketChannel) {
    self.makeChannel = makeChannel
  }

  public func connection(handlers: BrokerTransportHandlers) -> any BrokerTransportConnection {
    WebSocketBrokerConnection(channel: makeChannel(), handlers: handlers)
  }
}

/// Turns the byte stream BrokerClient writes into one message per frame, and
/// each message it receives back into a newline-terminated line.
@MainActor
public final class WebSocketBrokerConnection: BrokerTransportConnection {
  private let channel: any WebSocketChannel
  private let handlers: BrokerTransportHandlers
  private var outbound = BrokerLineReader(limit: GatewayLimits.maxBrokerMessageInBytes)
  private var finished = false

  public init(channel: any WebSocketChannel, handlers: BrokerTransportHandlers) {
    self.channel = channel
    self.handlers = handlers
  }

  public func start() {
    channel.start(handlers: WebSocketChannelHandlers(
      onOpen: { [weak self] in
        guard let self, !self.finished else { return }
        self.handlers.onOpen()
      },
      onMessage: { [weak self] message in
        guard let self, !self.finished else { return }
        do {
          self.handlers.onData(try BrokerWebSocketFraming.line(fromMessage: message, limit: GatewayLimits.maxBrokerMessageOutBytes))
        } catch {
          self.fail(error.message)
        }
      },
      onClose: { [weak self] reason in
        guard let self, !self.finished else { return }
        self.finished = true
        self.handlers.onClose(reason)
      }))
  }

  public func send(_ data: Data) {
    guard !finished else { return }
    let lines: [Data]
    do { lines = try outbound.append(data) } catch { return fail(error.message) }
    for line in lines { channel.send(line) }
  }

  public func setReading(_ reading: Bool) {
    guard !finished else { return }
    channel.setReceiving(reading)
  }

  public func close() {
    guard !finished else { return }
    finished = true
    channel.close()
  }

  private func fail(_ reason: String) {
    finished = true
    channel.close()
    handlers.onClose(reason)
  }
}

/// The framing rules both ends of /_hivemind/broker share.
public enum BrokerWebSocketFraming {
  /// A received message as a stream line, newline included. One message is
  /// exactly one frame: a trailing "\n" is allowed, any other newline, an
  /// empty message or one over `limit` is a protocol error.
  public static func line(fromMessage message: Data, limit: Int) throws(BrokerProtocolError) -> Data {
    var body = message
    if body.last == UInt8(ascii: "\n") { body.removeLast() }
    guard !body.isEmpty else { throw BrokerProtocolError(.badMessage, "an empty WebSocket message") }
    guard body.count <= limit else { throw BrokerProtocolError(.tooLarge, "a message must be at most \(limit) bytes") }
    guard !body.contains(UInt8(ascii: "\n")) else {
      throw BrokerProtocolError(.badMessage, "a WebSocket message must hold exactly one frame")
    }
    body.append(UInt8(ascii: "\n"))
    return body
  }
}

/// The gateway's handling of the first frame on /_hivemind/broker.
public enum GatewayBrokerHello {
  /// What a device puts in hello.token. It is not a secret and the broker
  /// never sees it: the gateway replaces it. BrokerClient needs some token
  /// to send, and a fixed one keeps the device side unchanged.
  public static let deviceToken = BrokerToken(String(repeating: "0", count: BrokerToken.byteCount * 2))!

  /// The first frame from the device, rewritten for the broker: it must be
  /// a `hello` (anything else ends the connection with `unauthorized`, as
  /// the broker itself would). The token becomes the broker's, and the
  /// client label names the device so the broker's log tells devices apart.
  /// Later frames pass through unchanged.
  public static func rewrite(firstFrame line: Data, brokerToken: BrokerToken, device: DeviceRecord) throws(BrokerProtocolError) -> Data {
    var body = line
    if body.last == UInt8(ascii: "\n") { body.removeLast() }
    let frame = try BrokerRequestFrame.decode(body)
    guard case .hello(let version, _, _) = frame.request else {
      throw BrokerProtocolError(.unauthorized, "say hello first")
    }
    return try BrokerRequestFrame(id: frame.id, .hello(version: version, token: brokerToken.value, client: clientLabel(for: device))).line()
  }

  /// "device:<platform>:<name>", cut to the broker's label limit.
  public static func clientLabel(for device: DeviceRecord) -> String {
    let label = "device:\(device.platform.rawValue):\(device.name)"
    let cleaned = String(label.unicodeScalars.filter { $0.properties.generalCategory != .control }.map(Character.init))
    return String(cleaned.prefix(BrokerLimits.maxClientLabelCharacters))
  }
}

private extension Error {
  var message: String { (self as? BrokerProtocolError)?.message ?? "\(self)" }
}
