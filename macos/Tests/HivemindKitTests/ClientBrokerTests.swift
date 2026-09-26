import Foundation
import Testing
@testable import HivemindKit

// BrokerClient over a fake transport: nothing here opens a socket.

@MainActor
final class FakeBrokerConnection: BrokerTransportConnection {
  let handlers: BrokerTransportHandlers
  var started = false
  var closed = false
  var sent = Data()
  /// Every setReading, in order.
  var readingChanges: [Bool] = []
  var startedPaused: Bool?

  init(handlers: BrokerTransportHandlers) { self.handlers = handlers }

  func start() {
    started = true
    startedPaused = readingChanges.last == false
  }
  func send(_ data: Data) { sent.append(data) }
  func setReading(_ reading: Bool) { readingChanges.append(reading) }
  func close() { closed = true }

  /// Every frame the client wrote, decoded.
  var frames: [BrokerRequestFrame] {
    sent.split(separator: UInt8(ascii: "\n")).compactMap { try? BrokerRequestFrame.decode(Data($0)) }
  }

  func open() { handlers.onOpen() }
  func push(_ frame: BrokerEventFrame) { handlers.onData(try! frame.line()) }
  func push(_ event: BrokerEvent, id: String? = nil) { push(BrokerEventFrame(id: id, event)) }
  func welcome(tmux: String? = "/opt/homebrew/bin/tmux") { open(); push(.welcome(version: 1, tmuxPath: tmux)) }
  func drop(_ reason: String? = nil) { handlers.onClose(reason) }
}

@MainActor
final class FakeBrokerConnector: BrokerConnecting {
  var connections: [FakeBrokerConnection] = []
  var current: FakeBrokerConnection { connections.last! }

  func connection(handlers: BrokerTransportHandlers) -> any BrokerTransportConnection {
    let connection = FakeBrokerConnection(handlers: handlers)
    connections.append(connection)
    return connection
  }
}

@MainActor
final class TokenStub {
  var token: BrokerToken? = BrokerToken(String(repeating: "ab", count: 32))
}

private let atlas = SessionName("hm-acme-atlas")!

@MainActor
struct BrokerClientTests {
  let connector = FakeBrokerConnector()
  let scheduler = FakeScheduler()
  let tokens = TokenStub()

  func client() -> BrokerClient {
    let tokens = tokens
    return BrokerClient(
      configuration: .init(connector: connector, token: { tokens.token }, clientLabel: "test"),
      scheduler: scheduler)
  }

  @Test func saysHelloWithTheTokenThenIsConnected() {
    let sut = client()
    var statuses: [BrokerClientStatus.Connection] = []
    sut.onStatusChange = { statuses.append($0.connection) }
    sut.start()
    #expect(sut.status.connection == .connecting)
    #expect(connector.current.started)
    connector.current.open()
    #expect(connector.current.frames == [BrokerRequestFrame(.hello(version: 1, token: String(repeating: "ab", count: 32), client: "test"))])
    connector.current.push(.welcome(version: 1, tmuxPath: "/opt/homebrew/bin/tmux"))
    #expect(sut.status == BrokerClientStatus(connection: .connected, tmuxPath: "/opt/homebrew/bin/tmux"))
    #expect(sut.status.bridgeEvent == .status(tmux: .available, broker: .connected))
    #expect(statuses == [.connecting, .connected])
  }

  @Test func reportsTmuxMissing() {
    let sut = client()
    sut.start()
    connector.current.welcome(tmux: nil)
    #expect(sut.status.bridgeEvent == .status(tmux: .missing, broker: .connected))
  }

  @Test func noTokenIsUnavailableAndRetriesWithBackoff() {
    tokens.token = nil
    let sut = client()
    sut.start()
    #expect(sut.status.connection == .unavailable)
    #expect(sut.status.bridgeEvent == .status(tmux: .unknown, broker: .unavailable))
    #expect(connector.connections.isEmpty)
    tokens.token = BrokerToken(String(repeating: "cd", count: 32))
    scheduler.advance(0.4)
    #expect(connector.connections.isEmpty)
    scheduler.advance(0.1)
    #expect(connector.connections.count == 1)
    connector.current.welcome()
    #expect(sut.status.connection == .connected)
  }

  @Test func backsOffUpToFiveSecondsAndStartsOverAfterAWelcome() {
    let sut = client()
    sut.start()
    var delays: [TimeInterval] = []
    for _ in 0..<6 {
      let before = scheduler.clock
      connector.current.drop("connect: No such file or directory")
      let count = connector.connections.count
      while connector.connections.count == count { scheduler.advance(0.25) }
      delays.append(scheduler.clock.timeIntervalSince(before))
    }
    #expect(delays == [0.5, 1, 2, 4, 5, 5])
    #expect(sut.status.connection == .unavailable)
    #expect(sut.status.reason == "connect: No such file or directory")
    connector.current.welcome()
    connector.current.drop()
    let count = connector.connections.count
    scheduler.advance(0.4)
    #expect(connector.connections.count == count)
    scheduler.advance(0.1)
    #expect(connector.connections.count == count + 1)
  }

  @Test func givesUpOnAConnectionThatIsNeverWelcomed() {
    let sut = client()
    sut.start()
    connector.current.open()
    scheduler.advance(BrokerLimits.helloTimeout)
    #expect(connector.connections[0].closed)
    #expect(sut.status.connection == .unavailable)
    #expect(sut.status.reason == "Hivemind Server did not answer")
  }

  @Test func refusesAnUnauthorizedHelloAndANewerProtocol() {
    let sut = client()
    sut.start()
    connector.current.open()
    connector.current.push(.error(code: .unauthorized, message: "bad token", stream: nil))
    #expect(sut.status.connection == .unavailable)
    #expect(sut.status.reason == "unauthorized: bad token")
    scheduler.advance(0.5)
    connector.current.open()
    connector.current.push(.welcome(version: 2, tmuxPath: nil))
    #expect(sut.status.connection == .unavailable)
  }

  @Test func matchesRepliesByIDAndPushesTheRest() {
    let sut = client()
    var pushed: [BrokerEvent] = []
    sut.onEvent = { pushed.append($0) }
    sut.start()
    connector.current.welcome()
    var replies: [BrokerEvent] = []
    sut.send(.kill(session: atlas)) { replies.append($0) }
    sut.send(.attach(session: atlas, size: TerminalSize(columns: 80, rows: 24)!)) { replies.append($0) }
    let frames = connector.current.frames
    #expect(frames.dropFirst().map(\.id) == ["c1", "c2"])
    connector.current.push(.attached(stream: 1, session: atlas), id: "c2")
    connector.current.push(.output(stream: 1, data: Data("hi".utf8)))
    connector.current.push(.killed(session: atlas), id: "c1")
    connector.current.push(.killed(session: atlas), id: "c1")
    #expect(replies == [.attached(stream: 1, session: atlas), .killed(session: atlas)])
    #expect(pushed == [.output(stream: 1, data: Data("hi".utf8)), .killed(session: atlas)])
    #expect(sut.streams == [1])
    connector.current.push(.exit(stream: 1, status: 0))
    #expect(sut.streams.isEmpty)
  }

  @Test func sendsNoIDWithoutAReplyAndDropsThoseWhileNotConnected() {
    let sut = client()
    sut.start()
    sut.send(.input(stream: 1, data: Data("x".utf8)), reply: nil)
    connector.current.welcome()
    sut.send(.resize(stream: 1, size: TerminalSize(columns: 100, rows: 30)!), reply: nil)
    #expect(connector.current.frames.dropFirst() == [BrokerRequestFrame(.resize(stream: 1, size: TerminalSize(columns: 100, rows: 30)!))])
  }

  @Test func holdsRequestsWhileConnectingAndFailsThemWhenUnavailable() {
    let sut = client()
    sut.start()
    var replies: [BrokerEvent] = []
    sut.send(.sessionsList) { replies.append($0) }
    #expect(connector.current.frames.isEmpty)
    connector.current.welcome()
    #expect(connector.current.frames.last == BrokerRequestFrame(id: "c1", .sessionsList))
    connector.current.drop()
    #expect(replies == [.error(code: .internal, message: BrokerClient.lostConnectionMessage, stream: nil)])
    sut.send(.sessionsList) { replies.append($0) }
    #expect(replies.last == .error(code: .internal, message: BrokerClient.notConnectedMessage, stream: nil))
  }

  @Test func aLostConnectionEndsItsStreams() {
    let sut = client()
    var pushed: [BrokerEvent] = []
    sut.onEvent = { pushed.append($0) }
    sut.start()
    connector.current.welcome()
    connector.current.push(.attached(stream: 2, session: atlas), id: "x")
    connector.current.push(.attached(stream: 1, session: atlas), id: "y")
    pushed = []
    connector.current.drop("read: Connection reset by peer")
    #expect(pushed == [.exit(stream: 1, status: nil), .exit(stream: 2, status: nil)])
    #expect(sut.streams.isEmpty)
    #expect(connector.connections[0].closed)
  }

  @Test func keepsTheSessionsSubscriptionAcrossReconnects() {
    let sut = client()
    sut.start()
    sut.setSessionsSubscribed(true)
    connector.current.welcome()
    #expect(connector.current.frames.last == BrokerRequestFrame(.sessionsSubscribe))
    connector.current.drop()
    scheduler.advance(0.5)
    connector.current.welcome()
    #expect(connector.current.frames.last == BrokerRequestFrame(.sessionsSubscribe))
    sut.setSessionsSubscribed(false)
    #expect(connector.current.frames.last == BrokerRequestFrame(.sessionsUnsubscribe))
  }

  @Test func ignoresLateCallbacksOfAnOldConnection() {
    let sut = client()
    var pushed: [BrokerEvent] = []
    sut.onEvent = { pushed.append($0) }
    sut.start()
    let old = connector.current
    old.welcome()
    old.drop()
    scheduler.advance(0.5)
    connector.current.welcome()
    old.push(.output(stream: 1, data: Data("x".utf8)))
    old.drop()
    #expect(pushed.isEmpty)
    #expect(sut.status.connection == .connected)
  }

  @Test func skipsLinesItCannotReadButClosesOnAnOversizedOne() {
    let sut = client()
    var pushed: [BrokerEvent] = []
    sut.onEvent = { pushed.append($0) }
    sut.start()
    connector.current.welcome()
    connector.current.handlers.onData(Data("{\"type\":\"future\"}\nnot json\n".utf8))
    connector.current.push(.killed(session: atlas))
    #expect(pushed == [.killed(session: atlas)])
    #expect(sut.status.connection == .connected)
    connector.current.handlers.onData(Data(repeating: UInt8(ascii: "x"), count: BrokerLimits.maxEventBytes + 1))
    #expect(sut.status.connection == .unavailable)
  }

  @Test func retryNowSkipsTheBackoffAndLooksForTmuxAgain() {
    let sut = client()
    sut.start()
    connector.current.drop()
    #expect(connector.connections.count == 1)
    sut.retryNow()
    #expect(connector.connections.count == 2)
    connector.current.welcome(tmux: "/opt/homebrew/bin/tmux")
    sut.retryNow()
    #expect(connector.connections.count == 2)
    connector.current.drop()
    scheduler.advance(0.5)
    connector.current.welcome(tmux: nil)
    sut.retryNow()
    #expect(connector.connections.count == 4)
    connector.current.welcome(tmux: "/usr/local/bin/tmux")
    #expect(sut.status.tmuxPath == "/usr/local/bin/tmux")
  }

  @Test func stopClosesAndCallsNothingBack() {
    let sut = client()
    var replies: [BrokerEvent] = []
    var pushed: [BrokerEvent] = []
    sut.onEvent = { pushed.append($0) }
    sut.start()
    connector.current.welcome()
    connector.current.push(.attached(stream: 1, session: atlas), id: "x")
    pushed = []
    sut.send(.sessionsList) { replies.append($0) }
    sut.stop()
    #expect(connector.current.closed)
    #expect(sut.status.connection == .idle)
    #expect(replies.isEmpty && pushed.isEmpty)
    scheduler.advance(60)
    #expect(connector.connections.count == 1)
  }

  @Test func pausesAndResumesReadingAndKeepsThePauseAcrossAReconnect() {
    let sut = client()
    sut.start()
    connector.current.welcome()
    sut.setReading(false)
    sut.setReading(false)
    #expect(connector.current.readingChanges == [false], "only changes reach the transport")
    #expect(!sut.isReading)
    connector.current.drop("gone")
    scheduler.advance(1)
    #expect(connector.connections.count == 2)
    #expect(connector.current.startedPaused == true, "a new connection starts paused, before it reads anything")
    sut.setReading(true)
    #expect(connector.current.readingChanges == [false, true])
    sut.setReading(false)
    sut.stop()
    #expect(sut.isReading, "stop forgets the pause")
  }

  @Test func readsTheTokenFile() throws {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("hm-token-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: folder) }
    let file = folder.appendingPathComponent("broker.token")
    #expect(BrokerTokenFile.read(file) == nil)
    let token = String(repeating: "0f", count: 32)
    try Data((token + "\n").utf8).write(to: file)
    #expect(BrokerTokenFile.read(file)?.value == token)
    try Data("nope".utf8).write(to: file)
    #expect(BrokerTokenFile.read(file) == nil)
    try Data(repeating: UInt8(ascii: "a"), count: 1000).write(to: file)
    #expect(BrokerTokenFile.read(file) == nil)
    let link = folder.appendingPathComponent("link.token")
    try Data((token).utf8).write(to: file)
    try FileManager.default.createSymbolicLink(at: link, withDestinationURL: file)
    #expect(BrokerTokenFile.read(link) == nil)
  }
}
