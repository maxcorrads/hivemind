import Foundation
import Testing
@testable import HivemindKit

// RemoteWebSocketChannel over a fake task: nothing here opens a WebSocket.

@MainActor
final class RCFakeTask: WebSocketTasking {
  let request: URLRequest
  let events: WebSocketTaskEvents
  var resumed = false
  var cancelled = false
  var sent: [String] = []
  var receives: [@MainActor @Sendable (Result<URLSessionWebSocketTask.Message, any Error>) -> Void] = []
  var sendCompletions: [@MainActor @Sendable ((any Error)?) -> Void] = []

  init(request: URLRequest, events: WebSocketTaskEvents) {
    self.request = request
    self.events = events
  }

  func resume() { resumed = true }
  func send(text: String, completion: @escaping @MainActor @Sendable ((any Error)?) -> Void) {
    sent.append(text)
    sendCompletions.append(completion)
  }
  func receive(completion: @escaping @MainActor @Sendable (Result<URLSessionWebSocketTask.Message, any Error>) -> Void) {
    receives.append(completion)
  }
  func cancel() { cancelled = true }

  /// Answers the oldest receive().
  func deliver(_ message: URLSessionWebSocketTask.Message) {
    guard !receives.isEmpty else { Issue.record("no receive pending"); return }
    receives.removeFirst()(.success(message))
  }
}

struct RCSocketError: Error, LocalizedError {
  var errorDescription: String? { "The network connection was lost." }
}

@MainActor
final class RCChannelEvents {
  var opened = 0
  var messages: [String] = []
  var closes: [String?] = []

  var handlers: WebSocketChannelHandlers {
    WebSocketChannelHandlers(
      onOpen: { self.opened += 1 },
      onMessage: { self.messages.append(String(decoding: $0, as: UTF8.self)) },
      onClose: { self.closes.append($0) })
  }
}

@MainActor
struct RemoteWebSocketChannelTests {
  let events = RCChannelEvents()
  let session = RemoteDeviceSession(endpoint: GatewayEndpoint(host: "fd7a:115c:a1e0::5", port: 7443)!, token: DeviceSessionToken.generate(), expiresAt: .distantFuture)

  final class Tasks {
    var all: [RCFakeTask] = []
    var last: RCFakeTask { all.last! }
  }

  func channel(prepare: RemoteWebSocketChannel.Prepare? = nil, unauthorized: @escaping @MainActor () -> Void = {}) -> (RemoteWebSocketChannel, Tasks) {
    let tasks = Tasks()
    let session = session
    let channel = RemoteWebSocketChannel(
      prepare: prepare ?? { RemoteBrokerConnection.request(for: session) },
      makeTask: { request, events in
        let task = RCFakeTask(request: request, events: events)
        tasks.all.append(task)
        return task
      },
      onUnauthorized: unauthorized)
    return (channel, tasks)
  }

  @Test func theRequestCarriesTheCookieAndNoOrigin() {
    let request = RemoteBrokerConnection.request(for: session)
    #expect(request.url?.absoluteString == "wss://[fd7a:115c:a1e0::5]:7443/_hivemind/broker")
    #expect(request.value(forHTTPHeaderField: "Cookie") == session.cookieHeader)
    #expect(request.value(forHTTPHeaderField: "Origin") == nil)
    #expect(!request.httpShouldHandleCookies)
  }

  @Test func opensThenRelaysMessagesOneAtATime() async {
    let (channel, tasks) = channel()
    channel.start(handlers: events.handlers)
    channel.send(Data("{\"type\":\"hello\"}".utf8))
    await rcSettle()
    let task = tasks.last
    #expect(task.resumed)
    #expect(task.request.value(forHTTPHeaderField: "Cookie") == session.cookieHeader)
    // Held until the upgrade completes, then sent before anything else.
    #expect(task.sent.isEmpty)
    task.events.onOpen()
    #expect(events.opened == 1)
    #expect(task.sent == ["{\"type\":\"hello\"}"])
    #expect(task.receives.count == 1)
    task.deliver(.string("{\"type\":\"welcome\"}"))
    #expect(events.messages == ["{\"type\":\"welcome\"}"])
    #expect(task.receives.count == 1)
    channel.send(Data("{\"type\":\"sessions.list\"}".utf8))
    #expect(task.sent.last == "{\"type\":\"sessions.list\"}")
  }

  @Test func pausingStopsAskingForMessages() async {
    let (channel, tasks) = channel()
    channel.start(handlers: events.handlers)
    await rcSettle()
    let task = tasks.last
    task.events.onOpen()
    channel.setReceiving(false)
    task.deliver(.string("a"))
    #expect(task.receives.isEmpty)
    channel.setReceiving(false)
    #expect(task.receives.isEmpty)
    channel.setReceiving(true)
    #expect(task.receives.count == 1)
    channel.setReceiving(true)
    #expect(task.receives.count == 1)
  }

  @Test func aBinaryMessageEndsTheConnection() async {
    let (channel, tasks) = channel()
    channel.start(handlers: events.handlers)
    await rcSettle()
    tasks.last.events.onOpen()
    tasks.last.deliver(.data(Data([1, 2])))
    #expect(tasks.last.cancelled)
    #expect(events.closes == ["The gateway sent a binary message"])
    tasks.last.events.onComplete(nil, nil)
    #expect(events.closes.count == 1)
  }

  @Test func aRefusedSessionIsReportedAndDropped() async {
    var unauthorized = 0
    let (channel, tasks) = channel(unauthorized: { unauthorized += 1 })
    channel.start(handlers: events.handlers)
    await rcSettle()
    tasks.last.events.onComplete(RCSocketError(), 401)
    #expect(unauthorized == 1)
    #expect(events.opened == 0)
    #expect(events.closes == ["The gateway refused the device session"])
    _ = channel
  }

  @Test func closesAreReported() async {
    let (first, tasks) = channel()
    first.start(handlers: events.handlers)
    await rcSettle()
    tasks.last.events.onOpen()
    tasks.last.events.onClose(1000)
    #expect(events.closes == [nil])

    let (second, more) = channel()
    second.start(handlers: events.handlers)
    await rcSettle()
    more.last.events.onOpen()
    more.last.events.onClose(1011)
    #expect(events.closes.last == "The gateway closed the terminal connection (1011)")

    let (third, others) = channel()
    third.start(handlers: events.handlers)
    await rcSettle()
    others.last.events.onComplete(RCSocketError(), nil)
    #expect(events.closes.last == "The network connection was lost.")
    #expect(events.closes.count == 3)
  }

  @Test func aFailedSendEndsTheConnection() async {
    let (channel, tasks) = channel()
    channel.start(handlers: events.handlers)
    await rcSettle()
    tasks.last.events.onOpen()
    channel.send(Data("x".utf8))
    tasks.last.sendCompletions[0](RCSocketError())
    #expect(events.closes == ["The network connection was lost."])
    #expect(tasks.last.cancelled)
  }

  @Test func aFailedPrepareNeverConnects() async {
    let (channel, tasks) = channel(prepare: { throw RemoteClientError.unreachable("asleep") })
    channel.start(handlers: events.handlers)
    await rcSettle()
    #expect(tasks.all.isEmpty)
    #expect(events.closes == ["The Mac did not answer (asleep)."])
  }

  @Test func closeBeforePrepareFinishesConnectsNothing() async {
    let (channel, tasks) = channel()
    channel.start(handlers: events.handlers)
    channel.close()
    await rcSettle()
    #expect(tasks.all.isEmpty)
    #expect(events.closes.isEmpty)
  }

  @Test func closeCancelsAndSilences() async {
    let (channel, tasks) = channel()
    channel.start(handlers: events.handlers)
    await rcSettle()
    let task = tasks.last
    task.events.onOpen()
    channel.close()
    #expect(task.cancelled)
    task.deliver(.string("late"))
    task.events.onComplete(nil, nil)
    #expect(events.messages.isEmpty)
    #expect(events.closes.isEmpty)
  }

  @Test func brokerClientSaysHelloWithThePlaceholderToken() async throws {
    let tasks = Tasks()
    let session = session
    let configuration = RemoteBrokerConnection.configuration(
      session: { session }, invalidate: {},
      makeTask: { request, events in
        let task = RCFakeTask(request: request, events: events)
        tasks.all.append(task)
        return task
      })
    let scheduler = FakeScheduler()
    let client = BrokerClient(configuration: configuration, scheduler: scheduler)
    var statuses: [BrokerClientStatus.Connection] = []
    client.onStatusChange = { statuses.append($0.connection) }
    client.start()
    await rcSettle()
    let task = tasks.last
    task.events.onOpen()
    let hello = try BrokerRequestFrame.decode(Data(try #require(task.sent.first).utf8))
    #expect(hello.request == .hello(version: BrokerProtocol.version, token: GatewayBrokerHello.deviceToken.value, client: RemoteBrokerConnection.clientLabel))
    task.deliver(.string("{\"type\":\"welcome\",\"version\":1,\"tmuxPath\":\"/opt/homebrew/bin/tmux\"}\n"))
    #expect(client.status == BrokerClientStatus(connection: .connected, tmuxPath: "/opt/homebrew/bin/tmux"))
    #expect(statuses == [.connecting, .connected])
    client.stop()
    #expect(task.cancelled)
  }
}
