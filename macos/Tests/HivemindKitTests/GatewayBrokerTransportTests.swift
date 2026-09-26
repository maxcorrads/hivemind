import Foundation
import Testing
@testable import HivemindKit

// The broker over a WebSocket, with a fake channel: nothing here opens one.

@MainActor
final class FakeWebSocketChannel: WebSocketChannel {
  var handlers: WebSocketChannelHandlers?
  var sent: [Data] = []
  var receiving: [Bool] = []
  var closed = false

  func start(handlers: WebSocketChannelHandlers) { self.handlers = handlers }
  func send(_ message: Data) { sent.append(message) }
  func setReceiving(_ receiving: Bool) { self.receiving.append(receiving) }
  func close() { closed = true }

  func open() { handlers?.onOpen() }
  func receive(_ text: String) { handlers?.onMessage(Data(text.utf8)) }
  func receive(_ frame: BrokerEventFrame) {
    var line = try! frame.line()
    line.removeLast()
    handlers?.onMessage(line)
  }
  func drop(_ reason: String?) { handlers?.onClose(reason) }
  var sentFrames: [BrokerRequestFrame] { sent.compactMap { try? BrokerRequestFrame.decode($0) } }
}

@MainActor
final class TransportEvents {
  var opened = 0
  var data = Data()
  var closes: [String?] = []

  var handlers: BrokerTransportHandlers {
    BrokerTransportHandlers(
      onOpen: { self.opened += 1 },
      onData: { self.data.append($0) },
      onClose: { self.closes.append($0) })
  }
}

@MainActor
struct WebSocketBrokerConnectionTests {
  let channel = FakeWebSocketChannel()
  let events = TransportEvents()

  func connection() -> WebSocketBrokerConnection {
    let connection = WebSocketBrokerConnection(channel: channel, handlers: events.handlers)
    connection.start()
    return connection
  }

  @Test func oneMessagePerFrameEachWay() {
    let sut = connection()
    channel.open()
    #expect(events.opened == 1)
    sut.send(Data("{\"type\":\"sessions.list\"}\n{\"type\":\"sess".utf8))
    #expect(channel.sent == [Data("{\"type\":\"sessions.list\"}".utf8)])
    sut.send(Data("ions.subscribe\"}\n".utf8))
    #expect(channel.sent.count == 2)
    #expect(channel.sent[1] == Data("{\"type\":\"sessions.subscribe\"}".utf8))

    channel.receive("{\"type\":\"welcome\",\"version\":1,\"tmuxPath\":null}")
    channel.receive("{\"type\":\"sessions\",\"items\":[]}\n")
    #expect(events.data == Data("{\"type\":\"welcome\",\"version\":1,\"tmuxPath\":null}\n{\"type\":\"sessions\",\"items\":[]}\n".utf8))
  }

  @Test func aMessageWithTwoFramesEndsTheConnection() {
    // Held, as BrokerClient holds its transport: the channel's handlers
    // reference the connection weakly.
    let sut = connection()
    defer { withExtendedLifetime(sut) {} }
    channel.open()
    channel.receive("{\"type\":\"a\"}\n{\"type\":\"b\"}")
    #expect(channel.closed)
    #expect(events.closes == ["a WebSocket message must hold exactly one frame"])
    // Nothing after the end.
    channel.receive("{\"type\":\"c\"}")
    channel.drop(nil)
    #expect(events.data.isEmpty)
    #expect(events.closes.count == 1)
  }

  @Test func anOversizedFrameEndsTheConnection() {
    let sut = connection()
    channel.open()
    sut.send(Data(repeating: UInt8(ascii: "x"), count: GatewayLimits.maxBrokerMessageInBytes + 1))
    #expect(channel.closed)
    #expect(channel.sent.isEmpty)
    #expect(events.closes.count == 1)
  }

  @Test func readingMapsToReceivingAndCloseIsSilent() {
    let sut = connection()
    sut.setReading(false)
    sut.setReading(true)
    #expect(channel.receiving == [false, true])
    sut.close()
    #expect(channel.closed)
    channel.drop("late")
    #expect(events.closes.isEmpty)
  }

  @Test func framing() throws {
    #expect(try BrokerWebSocketFraming.line(fromMessage: Data("{}".utf8), limit: 10) == Data("{}\n".utf8))
    #expect(try BrokerWebSocketFraming.line(fromMessage: Data("{}\n".utf8), limit: 10) == Data("{}\n".utf8))
    #expect(throws: BrokerProtocolError.self) { try BrokerWebSocketFraming.line(fromMessage: Data(), limit: 10) }
    #expect(throws: BrokerProtocolError.self) { try BrokerWebSocketFraming.line(fromMessage: Data("\n".utf8), limit: 10) }
    #expect(throws: BrokerProtocolError.self) { try BrokerWebSocketFraming.line(fromMessage: Data("12345678901".utf8), limit: 10) }
  }

  /// BrokerClient, unchanged, over the WebSocket transport: it says hello
  /// with the placeholder token and is connected on welcome.
  @Test func brokerClientRunsOverIt() {
    let channel = channel
    let client = BrokerClient(
      configuration: .init(
        connector: WebSocketBrokerConnector(makeChannel: { channel }),
        token: { GatewayBrokerHello.deviceToken }, clientLabel: "ios"),
      scheduler: FakeScheduler())
    client.start()
    channel.open()
    #expect(channel.sentFrames == [BrokerRequestFrame(.hello(version: 1, token: String(repeating: "0", count: 64), client: "ios"))])
    channel.receive(BrokerEventFrame(.welcome(version: 1, tmuxPath: "/opt/homebrew/bin/tmux")))
    #expect(client.status == BrokerClientStatus(connection: .connected, tmuxPath: "/opt/homebrew/bin/tmux"))
  }
}

struct GatewayBrokerHelloTests {
  let brokerToken = BrokerToken(String(repeating: "ab", count: 32))!
  let device = DeviceRecord(name: "Anna's iPad", platform: .ipados, tokenHash: DeviceToken.generate().hash, createdAt: Date())

  @Test func swapsInTheBrokerTokenAndNamesTheDevice() throws {
    let hello = try BrokerRequestFrame(id: "h1", .hello(version: 1, token: GatewayBrokerHello.deviceToken.value, client: "ios")).line()
    let rewritten = try GatewayBrokerHello.rewrite(firstFrame: hello, brokerToken: brokerToken, device: device)
    #expect(rewritten.last == UInt8(ascii: "\n"))
    let frame = try BrokerRequestFrame.decode(rewritten.dropLast())
    #expect(frame == BrokerRequestFrame(id: "h1", .hello(version: 1, token: brokerToken.value, client: "device:ipados:Anna's iPad")))
  }

  @Test func anythingButHelloFirstIsUnauthorized() throws {
    let list = try BrokerRequestFrame(.sessionsList).line()
    #expect(throws: BrokerProtocolError(.unauthorized, "say hello first")) {
      try GatewayBrokerHello.rewrite(firstFrame: list, brokerToken: brokerToken, device: device)
    }
    #expect(throws: BrokerProtocolError.self) {
      try GatewayBrokerHello.rewrite(firstFrame: Data("not json".utf8), brokerToken: brokerToken, device: device)
    }
  }

  @Test func labelIsCutToTheBrokerLimit() {
    let long = DeviceRecord(name: String(repeating: "x", count: 64), platform: .ios, tokenHash: DeviceToken.generate().hash, createdAt: Date())
    #expect(GatewayBrokerHello.clientLabel(for: long).count == BrokerLimits.maxClientLabelCharacters)
  }
}
