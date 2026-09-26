import Foundation
import Testing
@testable import HivemindKit

// TerminalBroker over fakes only (BrokerFakes.swift): no tmux, PTY or socket
// is ever used here.

private let atlas = SessionName("hm-acme-atlas")!
private let base = ["-u", "-L", "hivemind", "-f", BrokerHarness.config]

private func errorCode(_ event: BrokerEvent?) -> BrokerErrorCode? {
  if case .error(let code, _, _) = event { return code }
  return nil
}

@MainActor
struct BrokerHelloTests {
  @Test func welcomesAClientWithTheRightTokenAndSaysWhereTmuxIs() async {
    let h = BrokerHarness()
    await h.start()
    let (transport, connection) = h.connect()
    await h.send(connection, .hello(version: 3, token: h.token.value, client: "Hivemind.app"), id: "h1")
    #expect(transport.take() == [BrokerEventFrame(id: "h1", .welcome(version: 1, tmuxPath: "/opt/homebrew/bin/tmux"))])
    #expect(connection.isAuthenticated)
    #expect(connection.client == "Hivemind.app")
  }

  @Test func looksTmuxUpAgainOnEveryHello() async {
    let h = BrokerHarness()
    h.tmuxPath = nil
    await h.start()
    let (first, c1) = h.connect()
    await h.send(c1, .hello(version: 1, token: h.token.value, client: nil))
    #expect(first.events() == [.welcome(version: 1, tmuxPath: nil)])
    h.tmuxPath = "/usr/local/bin/tmux"
    let (second, c2) = h.connect()
    await h.send(c2, .hello(version: 1, token: h.token.value, client: nil))
    #expect(second.events() == [.welcome(version: 1, tmuxPath: "/usr/local/bin/tmux")])
    #expect(h.broker.tmuxPath == "/usr/local/bin/tmux")
  }

  @Test func aWrongTokenIsUnauthorizedAndCloses() async {
    let h = BrokerHarness()
    await h.start()
    let (transport, connection) = h.connect()
    await h.send(connection, .hello(version: 1, token: String(repeating: "cd", count: 32), client: nil), id: "x")
    let frames = transport.take()
    #expect(frames.count == 1)
    #expect(frames.first?.id == "x")
    #expect(errorCode(frames.first?.event) == .unauthorized)
    #expect(transport.isClosed)
    #expect(!connection.isOpen)
    #expect(h.broker.connectionCount == 0)
    // Nothing the connection sends afterwards is read.
    await h.send(connection, .sessionsList)
    #expect(transport.take().isEmpty)
    #expect(!h.logs.joined().contains(h.token.value))
  }

  @Test func anythingBeforeHelloIsUnauthorizedAndCloses() async {
    let h = BrokerHarness()
    await h.start()
    let (transport, connection) = h.connect()
    await h.send(connection, .sessionsList, id: "early")
    #expect(errorCode(transport.take().first?.event) == .unauthorized)
    #expect(transport.isClosed)
    #expect(h.tmux.calls("list-sessions").count == 1) // only the start's own poll
  }

  @Test func aMalformedFirstLineIsUnauthorizedToo() async {
    let h = BrokerHarness()
    await h.start()
    let (transport, connection) = h.connect()
    await h.sendRaw(connection, "{\"type\":\"hello\",\"version\":1}\n")
    #expect(errorCode(transport.take().first?.event) == .unauthorized)
    #expect(transport.isClosed)
  }

  @Test func anUnsupportedVersionCloses() async {
    let h = BrokerHarness()
    await h.start()
    let (transport, connection) = h.connect()
    await h.send(connection, .hello(version: 0, token: h.token.value, client: nil))
    #expect(errorCode(transport.take().first?.event) == .unsupportedVersion)
    #expect(transport.isClosed)
  }

  @Test func closesAConnectionThatDoesNotSayHelloInTime() async {
    let h = BrokerHarness()
    await h.start()
    let (transport, connection) = h.connect()
    await h.advance(BrokerLimits.helloTimeout - 0.1)
    #expect(connection.isOpen)
    await h.advance(0.2)
    #expect(errorCode(transport.take().first?.event) == .unauthorized)
    #expect(transport.isClosed)

    let (late, ok) = await h.client()
    await h.advance(10)
    #expect(ok.isOpen)
    #expect(!late.isClosed)
  }

  @Test func aSecondHelloIsABadMessageButKeepsTheConnection() async {
    let h = BrokerHarness()
    await h.start()
    let (transport, connection) = await h.client()
    await h.send(connection, .hello(version: 1, token: h.token.value, client: nil), id: "again")
    let frame = transport.take().first
    #expect(frame?.id == "again")
    #expect(errorCode(frame?.event) == .badMessage)
    #expect(connection.isOpen)
  }

  @Test func aBadMessageAfterHelloIsAnsweredAndTheConnectionStays() async {
    let h = BrokerHarness()
    await h.start()
    let (transport, connection) = await h.client()
    await h.sendRaw(connection, "{\"type\":\"attach\",\"session\":\"hm-acme-atlas\",\"cols\":0,\"rows\":24}\nnot json\n{\"type\":\"dance\"}\n")
    #expect(transport.events().map(errorCode) == [.badMessage, .badMessage, .unknownType])
    #expect(connection.isOpen)
  }

  @Test func aLineOverTheLimitCloses() async {
    let h = BrokerHarness()
    await h.start()
    let (transport, connection) = await h.client()
    connection.received(Data(repeating: UInt8(ascii: "x"), count: BrokerLimits.maxRequestBytes + 1))
    await h.broker.settle()
    #expect(errorCode(transport.take().first?.event) == .tooLarge)
    #expect(transport.isClosed)
  }

  @Test func linesMaySplitAcrossReads() async {
    let h = BrokerHarness()
    await h.start()
    let (transport, connection) = h.connect()
    let line = try! BrokerRequestFrame(.hello(version: 1, token: h.token.value, client: nil)).line()
    connection.received(line.prefix(10))
    #expect(transport.take().isEmpty)
    connection.received(line.dropFirst(10))
    #expect(transport.events() == [.welcome(version: 1, tmuxPath: "/opt/homebrew/bin/tmux")])
  }

  @Test func servesAtMostTheConnectionLimit() async {
    let h = BrokerHarness()
    await h.start()
    for _ in 0..<BrokerLimits.maxConnections { _ = h.connect() }
    let transport = FakeTransport()
    #expect(h.broker.accept(transport) == nil)
    #expect(transport.isClosed)
  }

  @Test func acceptsNothingWhenStopped() {
    let h = BrokerHarness()
    let transport = FakeTransport()
    #expect(h.broker.accept(transport) == nil)
    #expect(transport.isClosed)
  }
}

@MainActor
struct BrokerSessionsTests {
  @Test func listsHivemindSessionsWithTheRequestID() async {
    let h = BrokerHarness()
    h.tmux.add("hm-acme-atlas", agent: "Atlas", attached: 1)
    await h.start()
    let (transport, connection) = await h.client()
    await h.send(connection, .sessionsList, id: "l")
    let frames = transport.take()
    #expect(frames.count == 1)
    #expect(frames.first?.id == "l")
    guard case .sessions(let items) = frames.first?.event else { Issue.record("no sessions"); return }
    #expect(items.map(\.name) == [atlas])
    #expect(items.first?.agent == "Atlas")
    #expect(items.first?.attached == 1)
    #expect(h.tmux.calls.last == ["list-sessions", "-F", TmuxCommand.listFormat])
  }

  @Test func noTmuxServerYetMeansNoSessions() async {
    let h = BrokerHarness()
    await h.start()
    let (transport, connection) = await h.client()
    await h.send(connection, .sessionsList)
    #expect(transport.events() == [.sessions([])])
  }

  @Test func noTmuxAtAllMeansNoSessionsAndNoCalls() async {
    let h = BrokerHarness()
    h.tmuxPath = nil
    await h.start()
    let (transport, connection) = await h.client()
    await h.send(connection, .sessionsList)
    #expect(transport.events() == [.sessions([])])
    #expect(h.tmux.calls.isEmpty)
  }

  @Test func aFailingListIsATmuxError() async {
    let h = BrokerHarness()
    await h.start()
    let (transport, connection) = await h.client()
    h.tmux.scripted["list-sessions"] = TmuxResult(status: 1, stderr: "protocol version mismatch\nmore")
    await h.send(connection, .sessionsList, id: "l")
    let frame = transport.take().first
    #expect(frame == BrokerEventFrame(id: "l", .error(code: .tmuxFailed, message: "protocol version mismatch", stream: nil)))
  }

  @Test func subscribersGetTheListAndThenOnlyChanges() async {
    let h = BrokerHarness()
    h.tmux.add("hm-acme-atlas")
    await h.start()
    let (transport, connection) = await h.client()
    await h.send(connection, .sessionsSubscribe, id: "s")
    let first = transport.take()
    #expect(first.count == 1)
    #expect(first.first?.id == "s")
    #expect(connection.isSubscribed)

    // Unchanged: nothing is pushed.
    await h.advance(BrokerLimits.sessionsPollInterval)
    #expect(transport.take().isEmpty)

    h.tmux.add("hm-acme-new-1")
    await h.advance(BrokerLimits.sessionsPollInterval)
    let pushed = transport.take()
    #expect(pushed.count == 1)
    #expect(pushed.first?.id == nil)
    guard case .sessions(let items) = pushed.first?.event else { Issue.record("no push"); return }
    #expect(items.map(\.name.rawValue) == ["hm-acme-atlas", "hm-acme-new-1"])

    await h.send(connection, .sessionsUnsubscribe)
    #expect(!connection.isSubscribed)
    h.tmux.sessions.removeAll()
    await h.advance(60)
    #expect(transport.take().isEmpty)
  }

  @Test func pollsSlowlyWithoutSubscribersAndEveryTwoSecondsWithThem() async {
    let h = BrokerHarness()
    await h.start()
    let polls = { h.tmux.calls("list-sessions").count }
    #expect(polls() == 1)
    await h.advance(BrokerLimits.sessionsPollInterval)
    #expect(polls() == 1)
    await h.advance(15)
    #expect(polls() == 2)
    let (_, connection) = await h.client()
    await h.send(connection, .sessionsSubscribe)
    let afterSubscribe = polls()
    await h.advance(BrokerLimits.sessionsPollInterval)
    #expect(polls() == afterSubscribe + 1)
    await h.advance(BrokerLimits.sessionsPollInterval)
    #expect(polls() == afterSubscribe + 2)
  }

  @Test func theMenuSeesTheSessionCount() async {
    let h = BrokerHarness()
    h.tmux.add("hm-acme-atlas")
    #expect(h.broker.status.state == .stopped)
    await h.start()
    #expect(h.broker.status == BrokerStatus(state: .listening, tmuxPath: "/opt/homebrew/bin/tmux", sessionCount: 1))
    #expect(h.changes > 0)
  }
}

@MainActor
struct BrokerLaunchTests {
  @Test func startsASessionPerLaunchWithArgvOnly() async {
    let h = BrokerHarness()
    await h.start()
    let (transport, connection) = await h.client()
    let launches = [brokerLaunch("Atlas"), brokerLaunch(nil), brokerLaunch(nil, cwd: "/Users/me/beta")]
    await h.send(connection, .launch(launches), id: "go")
    let names = ["hm-acme-atlas", "hm-acme-new-1", "hm-acme-new-2"].map { SessionName($0)! }
    #expect(transport.take().first == BrokerEventFrame(id: "go", .launched(names: names, created: names, errors: [])))
    let tmux = TmuxCommand(executable: "/opt/homebrew/bin/tmux", configPath: BrokerHarness.config)
    let created = h.tmux.calls("new-session")
    #expect(created.count == 3)
    #expect(created.first.map { base + $0 } == tmux.newSession(TmuxNewSession(name: names[0], launch: launches[0])))
    #expect(created.first?.contains("HIVEMIND_TMUX_SESSION=hm-acme-atlas") == true)
    #expect(Set(h.tmux.executables) == ["/opt/homebrew/bin/tmux"])
  }

  @Test func tmuxRunsWithoutTheAppsOwnTmuxVariables() async {
    let h = BrokerHarness()
    await h.start()
    let (_, connection) = await h.client()
    await h.send(connection, .launch([brokerLaunch("Atlas")]))
    let environment = h.tmux.environments.last ?? [:]
    #expect(environment["TMUX"] == nil)
    #expect(environment["HOME"] == "/Users/me")
    #expect(environment["LANG"] == "it_IT.UTF-8")
    #expect(environment["PATH"] == "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")
  }

  @Test func reusesARunningSessionWithoutRunningItsCommandAgain() async {
    let h = BrokerHarness()
    h.tmux.add("hm-acme-atlas", agent: "Atlas")
    h.tmux.add("hm-acme-new-1")
    await h.start()
    let (transport, connection) = await h.client()
    await h.send(connection, .launch([brokerLaunch("Atlas"), brokerLaunch(nil)]))
    #expect(transport.events().first == .launched(
      names: [atlas, SessionName("hm-acme-new-2")!], created: [SessionName("hm-acme-new-2")!], errors: []))
    #expect(h.tmux.calls("new-session").count == 1)
  }

  @Test func theSameAgentTwiceInOneBatchGetsOneSession() async {
    let h = BrokerHarness()
    await h.start()
    let (transport, connection) = await h.client()
    await h.send(connection, .launch([brokerLaunch("Atlas"), brokerLaunch("atlas")]))
    #expect(transport.events().first == .launched(names: [atlas, atlas], created: [atlas], errors: []))
  }

  @Test func refusesAFolderThatIsNotADirectoryAndStartsTheRest() async {
    let h = BrokerHarness()
    await h.start()
    let (transport, connection) = await h.client()
    await h.send(connection, .launch([brokerLaunch("Gone", cwd: "/Users/me/gone"), brokerLaunch("Atlas")]))
    #expect(transport.events().first == .launched(
      names: [nil, atlas], created: [atlas],
      errors: [BrokerLaunchFailure(index: 0, code: .cwdMissing, message: "launches[0].cwd: not a folder")]))
  }

  @Test func reportsTmuxsOwnErrorPerLaunch() async {
    let h = BrokerHarness()
    await h.start()
    let (transport, connection) = await h.client()
    h.tmux.scripted["new-session"] = TmuxResult(status: 1, stderr: "create window failed: fork failed\n")
    await h.send(connection, .launch([brokerLaunch("Atlas")]))
    #expect(transport.events().first == .launched(
      names: [nil], created: [],
      errors: [BrokerLaunchFailure(index: 0, code: .tmuxFailed, message: "create window failed: fork failed")]))
  }

  @Test func aSessionAnotherClientStartedMeanwhileIsReused() async {
    let h = BrokerHarness()
    await h.start()
    let (transport, connection) = await h.client()
    h.tmux.scripted["new-session"] = TmuxResult(status: 1, stderr: "duplicate session: hm-acme-atlas\n")
    h.tmux.add("hm-acme-atlas")
    h.tmux.scripted["list-sessions"] = TmuxResult(status: 0, stdout: "")
    await h.send(connection, .launch([brokerLaunch("Atlas")]))
    #expect(transport.events().first == .launched(names: [atlas], created: [], errors: []))
  }

  @Test func newAgentsLaunchedFromTwoConnectionsAtOnceGetSessionsOfTheirOwn() async {
    let h = BrokerHarness()
    await h.start()
    let (first, one) = await h.client()
    let (second, other) = await h.client()
    // tmux answers after a while, so both launches are in flight together.
    h.tmux.yields = 5
    one.received(try! BrokerRequestFrame(id: "a", .launch([brokerLaunch(nil)])).line())
    other.received(try! BrokerRequestFrame(id: "b", .launch([brokerLaunch(nil)])).line())
    await h.broker.settle()
    let new1 = SessionName("hm-acme-new-1")!
    let new2 = SessionName("hm-acme-new-2")!
    #expect(first.take().first == BrokerEventFrame(id: "a", .launched(names: [new1], created: [new1], errors: [])))
    #expect(second.take().first == BrokerEventFrame(id: "b", .launched(names: [new2], created: [new2], errors: [])))
    #expect(h.tmux.calls("new-session").count == 2)
  }

  @Test func aLaunchQueuedBehindAnotherIsDroppedWhenItsClientLeaves() async {
    let h = BrokerHarness()
    await h.start()
    let (_, one) = await h.client()
    let (_, other) = await h.client()
    h.tmux.yields = 5
    one.received(try! BrokerRequestFrame(.launch([brokerLaunch("Atlas")])).line())
    other.received(try! BrokerRequestFrame(.launch([brokerLaunch("Bea")])).line())
    other.closed()
    await h.broker.settle()
    #expect(h.tmux.calls("new-session").count == 1)
    #expect(h.tmux.sessions.keys.sorted() == ["hm-acme-atlas"])
  }

  @Test func withoutTmuxALaunchIsRefused() async {
    let h = BrokerHarness()
    h.tmuxPath = nil
    await h.start()
    let (transport, connection) = await h.client()
    await h.send(connection, .launch([brokerLaunch("Atlas")]), id: "go")
    let frame = transport.take().first
    #expect(frame == BrokerEventFrame(id: "go", .error(code: .tmuxMissing, message: TmuxLocator.installHint, stream: nil)))
  }

  @Test func subscribersSeeTheNewSessionRightAway() async {
    let h = BrokerHarness()
    await h.start()
    let (watcher, watching) = await h.client()
    await h.send(watching, .sessionsSubscribe)
    _ = watcher.take()
    let (_, launching) = await h.client()
    await h.send(launching, .launch([brokerLaunch("Atlas")]))
    guard case .sessions(let items) = watcher.events().last else { Issue.record("no push"); return }
    #expect(items.map(\.name) == [atlas])
    #expect(items.first?.project == "acme")
    #expect(items.first?.agent == "Atlas")
  }

  @Test func requestsThatRunTmuxAreAnsweredInOrder() async {
    let h = BrokerHarness()
    await h.start()
    let (transport, connection) = await h.client()
    var lines = Data()
    lines += try! BrokerRequestFrame(id: "1", .launch([brokerLaunch("Atlas")])).line()
    lines += try! BrokerRequestFrame(id: "2", .sessionsList).line()
    lines += try! BrokerRequestFrame(id: "3", .kill(session: atlas)).line()
    lines += try! BrokerRequestFrame(id: "4", .sessionsList).line()
    connection.received(lines)
    await h.broker.settle()
    let frames = transport.take()
    #expect(frames.map(\.id) == ["1", "2", "3", "4"])
    guard case .sessions(let listed) = frames[1].event else { Issue.record("no list"); return }
    #expect(listed.map(\.name) == [atlas])
    #expect(frames[2].event == .killed(session: atlas))
    #expect(frames[3].event == .sessions([]))
  }
}

@MainActor
struct BrokerKillTests {
  @Test func killsASessionAndSaysSo() async {
    let h = BrokerHarness()
    h.tmux.add("hm-acme-atlas")
    await h.start()
    let (transport, connection) = await h.client()
    await h.send(connection, .kill(session: atlas), id: "k")
    #expect(transport.take().first == BrokerEventFrame(id: "k", .killed(session: atlas)))
    #expect(h.tmux.calls("kill-session") == [["kill-session", "-t", "=hm-acme-atlas"]])
    #expect(h.broker.sessions == [])
  }

  @Test func killingWhatIsNotRunningIsNoSuchSession() async {
    let h = BrokerHarness()
    await h.start()
    let (transport, connection) = await h.client()
    await h.send(connection, .kill(session: atlas))
    #expect(errorCode(transport.events().first) == .noSuchSession)
    h.tmux.add("hm-acme-other")
    await h.send(connection, .kill(session: atlas))
    #expect(errorCode(transport.events().first) == .noSuchSession)
  }
}

@MainActor
struct BrokerStreamTests {
  @Test func attachRunsTmuxAttachInAPTYAtTheRequestedSize() async throws {
    let h = BrokerHarness()
    h.tmux.add("hm-acme-atlas")
    await h.start()
    let (transport, connection) = await h.client()
    await h.send(connection, .attach(session: atlas, size: TerminalSize(columns: 120, rows: 40)!), id: "a")
    #expect(transport.take() == [BrokerEventFrame(id: "a", .attached(stream: 1, session: atlas))])
    let spec = try #require(h.spawner.terminals.first?.spec)
    #expect(spec.executable == "/opt/homebrew/bin/tmux")
    #expect(spec.arguments == base + ["attach-session", "-t", "=hm-acme-atlas"])
    #expect(spec.size == TerminalSize(columns: 120, rows: 40))
    #expect(spec.environment["TERM"] == "xterm-256color")
    #expect(spec.environment["TMUX"] == nil)
    #expect(connection.streamCount == 1)
    #expect(h.broker.streamCount == 1)
  }

  @Test func attachingWhatIsNotRunningIsNoSuchSession() async {
    let h = BrokerHarness()
    await h.start()
    let (transport, connection) = await h.client()
    await h.send(connection, .attach(session: atlas, size: TerminalSize(columns: 80, rows: 24)!), id: "a")
    let frame = transport.take().first
    #expect(frame?.id == "a")
    #expect(errorCode(frame?.event) == .noSuchSession)
    #expect(h.spawner.terminals.isEmpty)
  }

  @Test func aPTYThatCannotOpenIsAnError() async {
    let h = BrokerHarness()
    h.tmux.add("hm-acme-atlas")
    h.spawner.fail = true
    await h.start()
    let (transport, connection) = await h.client()
    await h.send(connection, .attach(session: atlas, size: TerminalSize(columns: 80, rows: 24)!))
    #expect(errorCode(transport.events().first) == .internal)
    #expect(connection.streamCount == 0)
  }

  @Test func streamIDsCountUpAndAreNeverReused() async {
    let h = BrokerHarness()
    h.tmux.add("hm-acme-atlas")
    await h.start()
    let (transport, connection) = await h.client()
    let first = await h.attach(connection, transport, "hm-acme-atlas")
    #expect(first?.0 == 1)
    await h.send(connection, .detach(stream: 1))
    _ = transport.take()
    let second = await h.attach(connection, transport, "hm-acme-atlas")
    #expect(second?.0 == 2)
  }

  @Test func atMostSixteenStreamsPerConnection() async {
    let h = BrokerHarness()
    h.tmux.add("hm-acme-atlas")
    await h.start()
    let (transport, connection) = await h.client()
    for _ in 0..<BrokerLimits.maxStreamsPerClient { _ = await h.attach(connection, transport, "hm-acme-atlas") }
    await h.send(connection, .attach(session: atlas, size: TerminalSize(columns: 80, rows: 24)!))
    #expect(errorCode(transport.events().first) == .tooManyStreams)
    #expect(connection.streamCount == BrokerLimits.maxStreamsPerClient)
    // Another connection has its own sixteen.
    let (other, otherConnection) = await h.client()
    let stream = await h.attach(otherConnection, other, "hm-acme-atlas")
    #expect(stream?.0 == 1)
  }

  @Test func outputIsBatchedThenSentInChunks() async throws {
    let h = BrokerHarness()
    h.tmux.add("hm-acme-atlas")
    await h.start()
    let (transport, connection) = await h.client()
    let (stream, terminal) = try #require(await h.attach(connection, transport, "hm-acme-atlas"))
    terminal.print("hello ")
    terminal.print("world")
    #expect(transport.take().isEmpty)
    await h.advance(BrokerLimits.outputBatchInterval)
    #expect(transport.events() == [.output(stream: stream, data: Data("hello world".utf8))])

    let big = Data((0..<(BrokerLimits.maxOutputBytes * 2 + 10)).map { UInt8($0 % 251) })
    terminal.print(big)
    await h.advance(BrokerLimits.outputBatchInterval)
    let chunks = transport.events().compactMap { event -> Data? in
      if case .output(_, let data) = event { return data }
      return nil
    }
    #expect(chunks.map(\.count) == [BrokerLimits.maxOutputBytes, BrokerLimits.maxOutputBytes, 10])
    #expect(chunks.reduce(Data(), +) == big)
  }

  @Test func inputAndResizeGoToTheStreamsPTY() async throws {
    let h = BrokerHarness()
    h.tmux.add("hm-acme-atlas")
    await h.start()
    let (transport, connection) = await h.client()
    let (stream, terminal) = try #require(await h.attach(connection, transport, "hm-acme-atlas"))
    await h.send(connection, .input(stream: stream, data: Data([0x03])))
    await h.send(connection, .resize(stream: stream, size: TerminalSize(columns: 100, rows: 30)!))
    #expect(terminal.input == [Data([0x03])])
    #expect(terminal.sizes == [TerminalSize(columns: 100, rows: 30)!])
    #expect(transport.take().isEmpty)

    terminal.acceptsInput = false
    await h.send(connection, .input(stream: stream, data: Data("x".utf8)), id: "i")
    let frame = transport.take().first
    #expect(frame?.id == "i")
    #expect(errorCode(frame?.event) == .internal)
  }

  @Test func anUnknownStreamIsNoSuchStream() async {
    let h = BrokerHarness()
    await h.start()
    let (transport, connection) = await h.client()
    await h.send(connection, .input(stream: 7, data: Data("x".utf8)))
    await h.send(connection, .resize(stream: 7, size: TerminalSize(columns: 80, rows: 24)!))
    await h.send(connection, .detach(stream: 7), id: "d")
    let frames = transport.take()
    #expect(frames.map { errorCode($0.event) } == [.noSuchStream, .noSuchStream, .noSuchStream])
    #expect(frames.last?.id == "d")
    #expect(frames.allSatisfy {
      if case .error(_, _, let stream) = $0.event { return stream == 7 }
      return false
    })
  }

  @Test func detachHangsUpThePTYAndLeavesTheSession() async throws {
    let h = BrokerHarness()
    h.tmux.add("hm-acme-atlas")
    await h.start()
    let (transport, connection) = await h.client()
    let (stream, terminal) = try #require(await h.attach(connection, transport, "hm-acme-atlas"))
    terminal.print("unsent")
    await h.send(connection, .detach(stream: stream), id: "d")
    #expect(transport.take() == [BrokerEventFrame(id: "d", .exit(stream: stream, status: nil))])
    #expect(terminal.terminated == 1)
    await h.advance(1)
    // What it printed before is dropped; a late exit is ignored.
    terminal.exit(0)
    #expect(transport.take().isEmpty)
    #expect(h.tmux.calls("kill-session").isEmpty)
    #expect(connection.streamCount == 0)
  }

  @Test func whenTheSessionEndsTheLastOutputComesBeforeTheExit() async throws {
    let h = BrokerHarness()
    h.tmux.add("hm-acme-atlas")
    await h.start()
    let (transport, connection) = await h.client()
    let (stream, terminal) = try #require(await h.attach(connection, transport, "hm-acme-atlas"))
    terminal.print("[exited]\r\n")
    terminal.exit(0)
    #expect(transport.events() == [.output(stream: stream, data: Data("[exited]\r\n".utf8)), .exit(stream: stream, status: 0)])
    #expect(connection.streamCount == 0)
    await h.advance(1)
    #expect(transport.take().filter { if case .output = $0.event { true } else { false } }.isEmpty)
  }

  @Test func closingTheConnectionHangsUpEveryStreamButKillsNothing() async throws {
    let h = BrokerHarness()
    h.tmux.add("hm-acme-atlas")
    await h.start()
    let (transport, connection) = await h.client()
    _ = await h.attach(connection, transport, "hm-acme-atlas")
    _ = await h.attach(connection, transport, "hm-acme-atlas")
    connection.closed()
    await h.broker.settle()
    #expect(h.spawner.terminals.map(\.terminated) == [1, 1])
    #expect(h.broker.connectionCount == 0)
    #expect(h.broker.streamCount == 0)
    #expect(!transport.isClosed) // the peer closed it; the broker does not again
    #expect(h.tmux.calls("kill-session").isEmpty)
  }

  @Test func stopHangsUpEveryPTYAndClosesEveryClientButKillsNoSession() async {
    let h = BrokerHarness()
    h.tmux.add("hm-acme-atlas")
    await h.start()
    let (one, c1) = await h.client()
    let (two, c2) = await h.client()
    _ = await h.attach(c1, one, "hm-acme-atlas")
    _ = await h.attach(c2, two, "hm-acme-atlas")
    h.broker.stop()
    #expect(h.spawner.terminals.map(\.terminated) == [1, 1])
    #expect(one.isClosed && two.isClosed)
    #expect(h.broker.connectionCount == 0)
    #expect(h.tmux.calls("kill-session").isEmpty)
    #expect(!h.broker.isRunning)
    let calls = h.tmux.calls.count
    await h.advance(60)
    #expect(h.tmux.calls.count == calls)
  }
}

@MainActor
struct BrokerBackpressureTests {
  @Test func stopsReadingPTYsWhileTheClientIsBehindAndResumesWhenItCatchesUp() async throws {
    let h = BrokerHarness()
    h.tmux.add("hm-acme-atlas")
    await h.start()
    let (transport, connection) = await h.client()
    connection.wrote(transport.sent.count)
    let (_, first) = try #require(await h.attach(connection, transport, "hm-acme-atlas"))
    let (_, second) = try #require(await h.attach(connection, transport, "hm-acme-atlas"))
    connection.wrote(transport.sent.count)
    #expect(!connection.isReadingPaused)

    // The client reads nothing: past the limit, both PTYs go unread.
    let chunk = Data(repeating: 0x41, count: BrokerLimits.maxOutputBytes)
    var printed = 0
    while !connection.isReadingPaused {
      first.print(chunk)
      printed += chunk.count
      await h.advance(BrokerLimits.outputBatchInterval)
    }
    #expect(printed > BrokerLimits.maxOutboundBytes / 2)
    #expect(first.readingChanges == [false])
    #expect(second.readingChanges == [false])

    // A stream attached while paused starts paused.
    let (_, third) = try #require(await h.attach(connection, transport, "hm-acme-atlas"))
    #expect(third.readingChanges == [false])

    // Writing some is not enough; getting under the low mark is.
    await h.advance(BrokerLimits.outputBatchInterval)
    let unsent = connection.bufferedBytes
    connection.wrote(unsent - BrokerLimits.resumeOutboundBytes)
    #expect(connection.isReadingPaused)
    connection.wrote(1)
    #expect(!connection.isReadingPaused)
    #expect(first.readingChanges == [false, true])
    #expect(third.readingChanges == [false, true])
  }

  @Test func aClientThatStopsReadingAltogetherIsClosed() async throws {
    let h = BrokerHarness()
    h.tmux.add("hm-acme-atlas")
    await h.start()
    let (transport, connection) = await h.client()
    let (_, terminal) = try #require(await h.attach(connection, transport, "hm-acme-atlas"))
    // A PTY that keeps printing although it is no longer read, into a
    // client that never reads: the connection is dropped, not buffered.
    let chunk = Data(repeating: 0x41, count: BrokerLimits.maxOutputBytes)
    for _ in 0..<1_000 where connection.isOpen {
      terminal.print(chunk)
      await h.advance(BrokerLimits.outputBatchInterval)
    }
    #expect(!connection.isOpen)
    #expect(transport.isClosed)
    #expect(terminal.terminated == 1)
    #expect(transport.sent.count <= BrokerConnection.maxUnsentBytes + 2 * BrokerLimits.maxOutputBytes)
  }
}

@MainActor
struct BrokerOutputBufferTests {
  @Test func gathersPerStreamInArrivalOrder() {
    var buffer = BrokerOutputBuffer(chunkBytes: 4, pauseAbove: 100, resumeBelow: 10)
    buffer.append(Data("ab".utf8), to: 2)
    buffer.append(Data("xyz".utf8), to: 1)
    buffer.append(Data("cdef".utf8), to: 2)
    #expect(buffer.pendingBytes == 9)
    let taken = buffer.takeAll()
    #expect(taken.map(\.stream) == [2, 2, 1])
    #expect(taken.map { String(decoding: $0.data, as: UTF8.self) } == ["abcd", "ef", "xyz"])
    #expect(buffer.isEmpty)
    #expect(buffer.takeAll().isEmpty)
  }

  @Test func takesOrDiscardsOneStream() {
    var buffer = BrokerOutputBuffer(chunkBytes: 64, pauseAbove: 100, resumeBelow: 10)
    buffer.append(Data("one".utf8), to: 1)
    buffer.append(Data("two".utf8), to: 2)
    #expect(buffer.take(2).map(\.data) == [Data("two".utf8)])
    buffer.discard(1)
    #expect(buffer.isEmpty)
    buffer.append(Data(), to: 3)
    #expect(buffer.takeAll().isEmpty)
  }

  @Test func pausesAboveTheHighMarkAndResumesBelowTheLowOne() {
    var buffer = BrokerOutputBuffer(chunkBytes: 64, pauseAbove: 100, resumeBelow: 20)
    buffer.append(Data(count: 60), to: 1)
    #expect(buffer.updatePause() == nil)
    buffer.queued(50)
    #expect(buffer.buffered == 110)
    #expect(buffer.updatePause() == true)
    #expect(buffer.updatePause() == nil)
    _ = buffer.takeAll()
    buffer.wrote(40)
    #expect(buffer.buffered == 10)
    #expect(buffer.updatePause() == false)
    buffer.wrote(1_000)
    #expect(buffer.unsentBytes == 0)
  }
}
