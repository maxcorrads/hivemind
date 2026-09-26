import Foundation

// /_hivemind/broker after its 101 (docs/remote-access.md#terminal-broker):
// the device's WebSocket on one side, a connection to the local terminal
// broker's Unix socket on the other. One text message is one broker frame
// each way (BrokerWebSocketFraming). The device's first frame must be
// `hello`; the gateway puts the real broker token into it
// (GatewayBrokerHello), so the token never leaves the Mac. Everything after
// passes through unchanged, and the broker checks every frame as it always
// does.

@MainActor
final class GatewayBrokerBridge {
  let device: DeviceRecord
  private let token: BrokerToken
  private weak var connection: GatewayConnection?
  /// A device message may carry its trailing newline too.
  private var reader = WebSocketReader(maxMessageBytes: GatewayLimits.maxBrokerMessageInBytes + 1)
  private var lines = BrokerLineReader(limit: GatewayLimits.maxBrokerMessageOutBytes)
  private var broker: (any BrokerTransportConnection)?
  private var brokerOpen = false
  private var greeted = false
  /// Frames the device sent before the broker socket opened.
  private var queued: [Data] = []
  private var queuedBytes = 0
  private var brokerReading = true
  private var closed = false

  static let maxQueuedFrames = 64

  init(device: DeviceRecord, token: BrokerToken, connection: GatewayConnection) {
    self.device = device
    self.token = token
    self.connection = connection
  }

  func start(connector: any BrokerConnecting) {
    let broker = connector.connection(handlers: BrokerTransportHandlers(
      onOpen: { [weak self] in self?.brokerOpened() },
      onData: { [weak self] data in self?.brokerData(data) },
      onClose: { [weak self] reason in self?.brokerClosed(reason) }))
    self.broker = broker
    broker.start()
  }

  // MARK: Device → broker

  func receive(_ bytes: Data) {
    guard !closed else { return }
    let events: [WebSocketEvent]
    do {
      events = try reader.append(bytes)
    } catch {
      return end(error.code, error.message)
    }
    for event in events {
      guard !closed else { return }
      switch event {
      case .text(let message): forward(message)
      case .binary: return end(.unsupportedData, "binary messages are not supported")
      case .ping(let payload): connection?.sendToDevice(WebSocketFrame.encode(.pong, payload))
      case .pong: break
      case .close: return end(.normal, "")
      }
    }
  }

  private func forward(_ message: Data) {
    let line: Data
    do {
      let framed = try BrokerWebSocketFraming.line(fromMessage: message, limit: GatewayLimits.maxBrokerMessageInBytes)
      if greeted {
        line = framed
      } else {
        line = try GatewayBrokerHello.rewrite(firstFrame: framed, brokerToken: token, device: device)
        greeted = true
      }
    } catch {
      // Answered as the broker itself would, so BrokerClient reports it.
      if let answer = try? BrokerEventFrame(id: nil, .error(code: error.code, message: error.message, stream: nil)).line() {
        connection?.sendToDevice(WebSocketFrame.encode(.text, answer.dropLast()))
      }
      return end(error.code == .tooLarge ? .tooBig : .policyViolation, error.message)
    }
    guard brokerOpen else {
      queued.append(line)
      queuedBytes += line.count
      if queued.count > Self.maxQueuedFrames || queuedBytes > GatewayLimits.maxBrokerMessageOutBytes {
        end(.policyViolation, "too much sent before the broker answered")
      }
      return
    }
    broker?.send(line)
  }

  private func brokerOpened() {
    guard !closed else { return }
    brokerOpen = true
    let queued = self.queued
    self.queued = []
    queuedBytes = 0
    for line in queued { broker?.send(line) }
  }

  // MARK: Broker → device

  private func brokerData(_ data: Data) {
    guard !closed else { return }
    let frames: [Data]
    do {
      frames = try lines.append(data)
    } catch {
      return end(.tooBig, error.message)
    }
    for frame in frames { connection?.sendToDevice(WebSocketFrame.encode(.text, frame)) }
    if let connection, connection.devicePendingBytes > GatewayConnection.highWater, brokerReading {
      brokerReading = false
      broker?.setReading(false)
    }
  }

  /// The device caught up: read the broker again.
  func deviceDrained() {
    guard !closed, !brokerReading else { return }
    brokerReading = true
    broker?.setReading(true)
  }

  private func brokerClosed(_ reason: String?) {
    guard !closed else { return }
    broker = nil
    end(.goingAway, brokerOpen ? "Hivemind Server closed the terminal connection" : "Terminals are not running in Hivemind Server")
  }

  // MARK: Closing

  /// Sends a close frame and ends the device connection.
  private func end(_ code: WebSocketCloseCode, _ reason: String) {
    guard !closed else { return }
    closed = true
    broker?.close()
    broker = nil
    connection?.sendToDevice(WebSocketFrame.close(code, reason))
    connection?.finish(nil)
  }

  /// The device connection ended (or was revoked): the broker connection
  /// goes with it, which detaches every stream it attached.
  func close() {
    guard !closed else { return }
    closed = true
    broker?.close()
    broker = nil
  }
}
