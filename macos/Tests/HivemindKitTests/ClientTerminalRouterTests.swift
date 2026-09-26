import Foundation
import Testing
@testable import HivemindKit

// One window's terminal routing, over a fake broker client: nothing here
// connects anywhere or opens Terminal.

@MainActor
final class FakeBrokerClient: BrokerClienting {
  var status = BrokerClientStatus(connection: .idle) {
    didSet { onStatusChange?(status) }
  }
  var onStatusChange: (@MainActor (BrokerClientStatus) -> Void)?
  var onEvent: (@MainActor (BrokerEvent) -> Void)?
  var started = 0
  var stopped = 0
  var retries = 0
  var sessionsSubscribed = false
  var sent: [BrokerRequest] = []
  var replies: [BrokerClient.Reply?] = []
  var readingChanges: [Bool] = []

  func start() { started += 1 }
  func stop() { stopped += 1 }
  func retryNow() { retries += 1 }
  func send(_ request: BrokerRequest, reply: (@MainActor (BrokerEvent) -> Void)?) {
    sent.append(request)
    replies.append(reply)
  }
  func setSessionsSubscribed(_ subscribed: Bool) { sessionsSubscribed = subscribed }
  func setReading(_ reading: Bool) { readingChanges.append(reading) }

  /// Answers the last request.
  func answer(_ event: BrokerEvent) { replies.last!!(event) }
  func push(_ event: BrokerEvent) { onEvent?(event) }
}

@MainActor
final class RouterRecorder {
  var delivered: [BridgeTerminalEvent] = []
  var opened: [[TerminalLaunch]] = []
  var clock = Date(timeIntervalSince1970: 1_000_000)
}

private let atlas = SessionName("hm-acme-atlas")!
private let size = TerminalSize(columns: 80, rows: 24)!
private let tmux = "/opt/homebrew/bin/tmux"
private let conf = "/Users/me/Library/Application Support/Hivemind/tmux.conf"

@MainActor
struct TerminalBridgeRouterTests {
  let client = FakeBrokerClient()
  let recorder = RouterRecorder()
  let scheduler = FakeScheduler()
  let router: TerminalBridgeRouter

  init() {
    let recorder = recorder
    router = TerminalBridgeRouter(client: client, environment: .init(
      home: "/Users/me", tmuxConfigPath: conf, now: { recorder.clock },
      deliver: { recorder.delivered.append($0) },
      openTerminals: { recorder.opened.append($0) },
      scheduler: scheduler))
    client.status = BrokerClientStatus(connection: .connected, tmuxPath: tmux)
  }

  func launch(agent: String? = "Atlas", cwd: String? = "~/acme") -> TerminalSessionLaunch {
    TerminalSessionLaunch(project: "acme", agent: agent, title: "Acme - Atlas", cwd: cwd, command: "claude")!
  }

  func tick() { recorder.clock.addTimeInterval(1) }

  @Test func startsTheClientOnTheFirstTerminalMessageOnly() {
    router.handle(.ready)
    router.handle(.badge(count: 2))
    #expect(client.started == 0)
    router.handle(.sessionsSubscribe)
    router.handle(.terminalAttach(id: nil, session: atlas, size: size))
    #expect(client.started == 1)
  }

  @Test func subscribingSendsStatusAndRelaysSessionPushes() {
    router.handle(.sessionsSubscribe)
    #expect(client.sessionsSubscribed)
    #expect(client.retries == 1)
    #expect(recorder.delivered == [.status(tmux: .available, broker: .connected)])
    let item = BrokerSession(name: atlas, project: "acme", agent: "Atlas", alive: true, attached: 0, createdAt: 1)
    client.push(.sessions([item]))
    #expect(recorder.delivered.last == .sessions([item]))
    router.handle(.sessionsUnsubscribe)
    #expect(!client.sessionsSubscribed)
    client.push(.sessions([]))
    #expect(recorder.delivered.count == 2)
  }

  @Test func sendsStatusChangesOnceThePageUsesTerminals() {
    client.status = BrokerClientStatus(connection: .unavailable, reason: "a")
    #expect(recorder.delivered.isEmpty)
    router.handle(.sessionsSubscribe)
    client.status = BrokerClientStatus(connection: .unavailable, reason: "b")
    client.status = BrokerClientStatus(connection: .connected, tmuxPath: nil)
    #expect(recorder.delivered == [
      .status(tmux: .unknown, broker: .unavailable),
      .status(tmux: .missing, broker: .connected),
    ])
  }

  @Test func launchesThenOpensTerminalAttachedToEachSession() {
    let other = SessionName("hm-acme-new-1")!
    router.handle(.terminalLaunch(id: "p1", launches: [launch(), launch(agent: nil, cwd: nil), launch(agent: "Bad")], openInTerminal: true))
    #expect(client.sent == [.launch([
      try! BrokerLaunch(project: "acme", agent: "Atlas", title: "Acme - Atlas", cwd: "/Users/me/acme", command: "claude"),
      try! BrokerLaunch(project: "acme", agent: nil, title: "Acme - Atlas", cwd: "/Users/me", command: "claude"),
      try! BrokerLaunch(project: "acme", agent: "Bad", title: "Acme - Atlas", cwd: "/Users/me/acme", command: "claude"),
    ])])
    let failure = BrokerLaunchFailure(index: 2, code: .cwdMissing, message: "no folder")
    client.answer(.launched(names: [atlas, other, nil], created: [other], errors: [failure]))
    #expect(recorder.delivered == [.launched(id: "p1", names: [atlas, other, nil], created: [other], errors: [failure])])
    let command = TmuxCommand(executable: tmux, configPath: conf)
    #expect(recorder.opened == [[
      TerminalLaunch(title: "Acme - Atlas", cwd: nil, command: command.attachShellLine(atlas))!,
      TerminalLaunch(title: "Acme - Atlas", cwd: nil, command: command.attachShellLine(other))!,
    ]])
    #expect(recorder.opened[0][0].command.hasPrefix("exec '/opt/homebrew/bin/tmux' '-u' '-L' 'hivemind'"))
  }

  @Test func launchesWithoutTerminalWhenNotAsked() {
    router.handle(.terminalLaunch(id: nil, launches: [launch()], openInTerminal: false))
    client.answer(.launched(names: [atlas], created: [atlas], errors: []))
    #expect(recorder.opened.isEmpty)
    #expect(recorder.delivered == [.launched(id: nil, names: [atlas], created: [atlas], errors: [])])
  }

  @Test func relaysALaunchErrorWithThePageID() {
    router.handle(.terminalLaunch(id: "p1", launches: [launch()], openInTerminal: true))
    client.answer(.error(code: .tmuxMissing, message: TmuxLocator.installHint, stream: nil))
    #expect(recorder.opened.isEmpty)
    #expect(recorder.delivered == [.error(id: "p1", code: .tmuxMissing, message: TmuxLocator.installHint, stream: nil)])
  }

  @Test func throttlesLaunchOpenAndKillEachOnItsOwn() {
    router.handle(.terminalLaunch(id: nil, launches: [launch()], openInTerminal: false))
    router.handle(.terminalLaunch(id: "p2", launches: [launch()], openInTerminal: false))
    router.handle(.terminalOpen(session: atlas))
    router.handle(.terminalOpen(session: atlas))
    router.handle(.terminalKill(id: nil, session: atlas))
    router.handle(.terminalKill(id: "p6", session: atlas))
    #expect(client.sent.count == 3)
    // Each refused one is answered, so the page need not wait for a timeout.
    let message = TerminalBridgeRouter.throttledMessage
    #expect(recorder.delivered == [
      .error(id: "p2", code: .internal, message: message, stream: nil),
      .error(id: nil, code: .internal, message: message, stream: nil),
      .error(id: "p6", code: .internal, message: message, stream: nil),
    ])
    tick()
    router.handle(.terminalLaunch(id: nil, launches: [launch()], openInTerminal: false))
    #expect(client.sent.count == 4)
  }

  @Test func opensOnlyARunningSession() {
    router.handle(.terminalOpen(session: atlas))
    #expect(client.sent == [.sessionsList])
    client.answer(.sessions([BrokerSession(name: atlas, project: "acme", agent: "Atlas", alive: true, attached: 1, createdAt: 1)]))
    #expect(recorder.opened.map { $0.map(\.title) } == [["hm-acme-atlas"]])
    tick()
    router.handle(.terminalOpen(session: atlas))
    client.answer(.sessions([]))
    #expect(recorder.opened.count == 1)
    #expect(recorder.delivered.last == .error(id: nil, code: .noSuchSession, message: "hm-acme-atlas is not running", stream: nil))
  }

  @Test func doesNotOpenTerminalWithoutTmux() {
    client.status = BrokerClientStatus(connection: .connected, tmuxPath: nil)
    router.handle(.terminalOpen(session: atlas))
    client.answer(.sessions([BrokerSession(name: atlas, project: nil, agent: nil, alive: true, attached: 0, createdAt: 1)]))
    #expect(recorder.opened.isEmpty)
    #expect(recorder.delivered.last == .error(id: nil, code: .tmuxMissing, message: TmuxLocator.installHint, stream: nil))
  }

  @Test func attachesAndRelaysOnlyItsOwnStreams() {
    router.handle(.terminalAttach(id: "a1", session: atlas, size: size))
    #expect(client.sent == [.attach(session: atlas, size: size)])
    client.answer(.attached(stream: 3, session: atlas))
    #expect(recorder.delivered == [.attached(id: "a1", stream: 3, session: atlas)])
    #expect(router.streams == [3])

    router.handle(.terminalInput(stream: 3, data: Data("ls\r".utf8)))
    router.handle(.terminalInput(stream: 4, data: Data("x".utf8)))
    router.handle(.terminalResize(stream: 3, size: TerminalSize(columns: 120, rows: 40)!))
    router.handle(.terminalResize(stream: 9, size: size))
    #expect(client.sent.dropFirst() == [
      .input(stream: 3, data: Data("ls\r".utf8)),
      .resize(stream: 3, size: TerminalSize(columns: 120, rows: 40)!),
    ])

    client.push(.output(stream: 3, data: Data("out".utf8)))
    client.push(.output(stream: 4, data: Data("other".utf8)))
    client.push(.error(code: .noSuchStream, message: "x", stream: 3))
    client.push(.error(code: .internal, message: "y", stream: nil))
    #expect(recorder.delivered.dropFirst() == [
      .output(stream: 3, data: Data("out".utf8)),
      .error(id: nil, code: .noSuchStream, message: "x", stream: 3),
    ])

    router.handle(.terminalDetach(stream: 3))
    #expect(client.sent.last == .detach(stream: 3))
    client.push(.exit(stream: 3, status: 0))
    client.push(.exit(stream: 3, status: 0))
    #expect(recorder.delivered.last == .exit(stream: 3, status: 0))
    #expect(recorder.delivered.count == 4)
    #expect(router.streams.isEmpty)
  }

  @Test func relaysAnAttachError() {
    router.handle(.terminalAttach(id: "a1", session: atlas, size: size))
    client.answer(.error(code: .tooManyStreams, message: "16", stream: nil))
    #expect(recorder.delivered == [.error(id: "a1", code: .tooManyStreams, message: "16", stream: nil)])
    #expect(router.streams.isEmpty)
  }

  @Test func killsWithThePageID() {
    router.handle(.terminalKill(id: "k1", session: atlas))
    #expect(client.sent == [.kill(session: atlas)])
    client.answer(.killed(session: atlas))
    #expect(recorder.delivered == [.killed(id: "k1", session: atlas)])
  }

  @Test func aNewPageDetachesTheOldPagesStreams() {
    router.handle(.sessionsSubscribe)
    router.handle(.terminalAttach(id: "a1", session: atlas, size: size))
    client.answer(.attached(stream: 1, session: atlas))
    router.handle(.terminalAttach(id: "a2", session: atlas, size: size))
    let late = client.replies.last!!
    router.pageDidChange()
    #expect(client.sent.last == .detach(stream: 1))
    #expect(!client.sessionsSubscribed)
    #expect(router.streams.isEmpty)
    let count = recorder.delivered.count

    // An attach that lands after the page left is detached, not delivered.
    late(.attached(stream: 2, session: atlas))
    #expect(client.sent.last == .detach(stream: 2))
    client.push(.exit(stream: 1, status: 0))
    client.push(.output(stream: 2, data: Data("x".utf8)))
    client.status = BrokerClientStatus(connection: .unavailable)
    #expect(recorder.delivered.count == count)
    #expect(client.stopped == 0)
  }

  // MARK: Output and flow control

  /// Attaches stream `stream` for the page and forgets what was delivered.
  func attached(_ stream: BrokerStreamID) {
    router.handle(.terminalAttach(id: nil, session: atlas, size: size))
    client.answer(.attached(stream: stream, session: atlas))
    recorder.delivered = []
  }

  func outputs() -> [BridgeTerminalEvent] {
    recorder.delivered.filter { if case .output = $0 { true } else { false } }
  }

  @Test func outputIsGatheredIntoOneEventPerStreamPerFrame() {
    attached(1)
    router.handle(.terminalAttach(id: nil, session: atlas, size: size))
    client.answer(.attached(stream: 2, session: atlas))
    recorder.delivered = []
    client.push(.output(stream: 1, data: Data("a".utf8)))
    client.push(.output(stream: 2, data: Data("x".utf8)))
    client.push(.output(stream: 1, data: Data("b".utf8)))
    #expect(recorder.delivered.isEmpty, "nothing before the frame")
    scheduler.advance(TerminalBridgeRouter.outputInterval)
    #expect(recorder.delivered == [.output(stream: 1, data: Data("ab".utf8)), .output(stream: 2, data: Data("x".utf8))])
    scheduler.advance(1)
    #expect(recorder.delivered.count == 2)
  }

  @Test func anyOtherEventFlushesTheFrameFirstSoOrderHolds() {
    attached(1)
    client.push(.output(stream: 1, data: Data("bye".utf8)))
    client.push(.exit(stream: 1, status: 0))
    #expect(recorder.delivered == [.output(stream: 1, data: Data("bye".utf8)), .exit(stream: 1, status: 0)])
    #expect(scheduler.pending.isEmpty)
    #expect(router.flow.pending.isEmpty)
  }

  @Test func aLargeFrameGoesAtOnceInEventsOfAtMostTheLimit() {
    attached(1)
    let chunk = Data(repeating: 0x61, count: 64 << 10)
    for _ in 0..<3 { client.push(.output(stream: 1, data: chunk)) }
    #expect(recorder.delivered.isEmpty)
    client.push(.output(stream: 1, data: chunk + Data("z".utf8)))
    let sizes = outputs().map { event -> Int in if case .output(_, let data) = event { data.count } else { 0 } }
    #expect(sizes == [TerminalBridgeRouter.maxOutputEventBytes, 1])
  }

  @Test func stopsReadingWhileThePageIsBehindAndResumesOnceItAcks() {
    attached(1)
    let chunk = Data(repeating: 0x61, count: 64 << 10)
    let chunks = TerminalOutputFlow.pauseAboveBytes / chunk.count
    for _ in 0..<chunks { client.push(.output(stream: 1, data: chunk)) }
    #expect(client.readingChanges.isEmpty, "at the mark, not above it")
    client.push(.output(stream: 1, data: Data("!".utf8)))
    #expect(client.readingChanges == [false])
    #expect(router.flow.paused)
    scheduler.advance(1)
    // Acks for other streams, or more than was sent, change nothing wrongly.
    router.handle(.terminalAck(stream: 9, bytes: 1 << 30))
    router.handle(.terminalAck(stream: 1, bytes: TerminalOutputFlow.pauseAboveBytes - TerminalOutputFlow.resumeAtBytes))
    #expect(client.readingChanges == [false], "still above the low mark")
    router.handle(.terminalAck(stream: 1, bytes: 1))
    #expect(client.readingChanges == [false, true])
    router.handle(.terminalAck(stream: 1, bytes: 1 << 30))
    #expect(router.flow.pending == [1: 0])
    #expect(client.readingChanges == [false, true])
  }

  @Test func detachingForgetsWhatThePageWillNeverAck() {
    attached(1)
    let big = Data(repeating: 0x61, count: TerminalOutputFlow.pauseAboveBytes + 1)
    client.push(.output(stream: 1, data: big))
    #expect(client.readingChanges == [false])
    client.push(.output(stream: 1, data: Data("late".utf8)))
    router.handle(.terminalDetach(stream: 1))
    #expect(client.readingChanges == [false, true])
    let before = recorder.delivered.count
    // Output until its exit is dropped, and so is an ack for it.
    client.push(.output(stream: 1, data: Data("more".utf8)))
    router.handle(.terminalAck(stream: 1, bytes: 4))
    scheduler.advance(1)
    #expect(recorder.delivered.count == before)
    #expect(router.flow.pending.isEmpty)
    client.push(.exit(stream: 1, status: nil))
    #expect(recorder.delivered.last == .exit(stream: 1, status: nil))
  }

  @Test func aNewPageOrALostConnectionResumesReading() {
    attached(1)
    client.push(.output(stream: 1, data: Data(repeating: 0x61, count: TerminalOutputFlow.pauseAboveBytes + 1)))
    #expect(client.readingChanges == [false])
    router.pageDidChange()
    #expect(client.readingChanges == [false, true])
    #expect(router.flow.pending.isEmpty)

    attached(2)
    client.push(.output(stream: 2, data: Data(repeating: 0x61, count: TerminalOutputFlow.pauseAboveBytes + 1)))
    // BrokerClient reports every stream of a lost connection as exited.
    client.push(.exit(stream: 2, status: nil))
    #expect(client.readingChanges == [false, true, false, true])
  }

  @Test func closingTheWindowStopsTheClient() {
    router.handle(.sessionsSubscribe)
    router.close()
    #expect(client.stopped == 1)
    #expect(client.onEvent == nil && client.onStatusChange == nil)
  }

  @Test func retriesOnlyOnceStarted() {
    router.retry()
    #expect(client.retries == 0)
    router.handle(.terminalAttach(id: nil, session: atlas, size: size))
    router.retry()
    #expect(client.retries == 1)
  }
}
