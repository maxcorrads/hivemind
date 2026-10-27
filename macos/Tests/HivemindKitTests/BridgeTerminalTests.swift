import Foundation
import Testing
@testable import HivemindKit

// The page ↔ app terminal messages (web/native-bridge.ts on the other side).

private let atlas = SessionName("hm-acme-atlas")!

private func launchItem(_ extra: [String: Any] = [:]) -> [String: Any] {
  ["project": "acme", "agent": "Atlas", "title": "Acme - Atlas", "cwd": "~/acme", "command": "claude\n"].merging(extra) { $1 }
}

private func accountFields(_ extra: [String: Any] = [:]) -> [String: Any] {
  ["id": "a1", "driver": "codex", "label": "Codex personal", "homePath": "", "shadowPath": "~/.codex_personal"].merging(extra) { $1 }
}
private let codexPersonal = LaunchAccount(id: "a1", driver: .codex, label: "Codex personal", homePath: "", shadowPath: "~/.codex_personal")

private func launchMessage(_ launches: Any, open: Any = true, id: Any? = "r1") -> BridgeMessage? {
  var body: [String: Any] = ["type": "terminal-launch", "launches": launches, "openInTerminal": open]
  if let id { body["id"] = id }
  return BridgeMessage(body: body)
}

struct BridgeTerminalMessageTests {
  @Test func parsesTerminalLaunch() {
    let parsed = launchMessage([launchItem(), launchItem(["agent": NSNull(), "cwd": NSNull()])], open: false)
    #expect(parsed == .terminalLaunch(id: "r1", launches: [
      TerminalSessionLaunch(project: "acme", agent: "Atlas", title: "Acme - Atlas", cwd: "~/acme", command: "claude\n")!,
      TerminalSessionLaunch(project: "acme", agent: nil, title: "Acme - Atlas", cwd: nil, command: "claude\n")!,
    ], openInTerminal: false))
    #expect(launchMessage([launchItem()], id: nil) != nil)
    let resumed = launchMessage([launchItem(["session": "hm-acme-new-1"])])
    #expect(resumed == .terminalLaunch(id: "r1", launches: [
      TerminalSessionLaunch(project: "acme", agent: "Atlas", title: "Acme - Atlas", cwd: "~/acme", command: "claude\n",
                            session: SessionName("hm-acme-new-1"))!,
    ], openInTerminal: true))
    guard case .terminalLaunch(_, let launches, _) = resumed else { return }
    #expect(launches[0].brokerLaunch(home: "/Users/me")?.session == SessionName("hm-acme-new-1"))
  }

  @Test func passesTheAccountOnAsThePageSentIt() {
    let parsed = launchMessage([launchItem(["account": accountFields()]), launchItem(["account": NSNull()]), launchItem()])
    guard case .terminalLaunch(_, let launches, _) = parsed else { Issue.record("dropped"); return }
    #expect(launches.map(\.account) == [codexPersonal, nil, nil])
    let broker = launches[0].brokerLaunch(home: "/Users/me")
    #expect(broker?.cwd == "/Users/me/acme")
    #expect(broker?.account == codexPersonal, "the broker, not the app, expands the account's ~/")
    #expect(launches[1].brokerLaunch(home: "/Users/me")?.account == nil)
  }

  @Test func passesTheHostOnAndDropsALaunchWhoseHostIsNotAHostID() {
    let host = "20000000-0000-4000-8000-000000000001"
    let parsed = launchMessage([launchItem(["host": host]), launchItem(["host": NSNull()]), launchItem()])
    guard case .terminalLaunch(_, let launches, _) = parsed else { Issue.record("dropped"); return }
    #expect(launches.map(\.host) == [host, nil, nil])
    #expect(launches[0].brokerLaunch(home: "/Users/me")?.host == host)
    for bad: Any in ["Build Mac", "20000000-0000-4000-8000-00000000000A", 1] {
      #expect(launchMessage([launchItem(["host": bad])]) == nil, "\(bad)")
    }
    // The page sees a host only on a host's session.
    let local = BrokerSession(name: atlas, project: "acme", agent: "Atlas", alive: true, attached: 0, createdAt: 1)
    let items = BridgeTerminalEvent.sessions([local, local.on(host: host)]).detail["items"] as? [[String: Any]]
    #expect(items?[0].keys.contains("host") == false)
    #expect(items?[1]["host"] as? String == host)
  }

  @Test func dropsTheWholeLaunchWhenAnythingIsOff() {
    let bad: [[String: Any]] = [
      launchItem(["project": "Acme"]),
      launchItem(["project": NSNull()]),
      launchItem(["agent": ""]),
      launchItem(["agent": 1]),
      launchItem(["cwd": "relative"]),
      launchItem(["cwd": "~bob/x"]),
      launchItem(["cwd": 3]),
      launchItem(["command": " "]),
      launchItem(["command": "a\0b"]),
      launchItem(["command": String(repeating: "x", count: BrokerLimits.maxCommandBytes + 1)]),
      launchItem(["title": String(repeating: "t", count: BrokerLimits.maxTitleCharacters + 1)]),
      launchItem(["session": "acme-atlas"]),
      launchItem(["session": 1]),
      launchItem(["account": "a1"]),
      launchItem(["account": [String: Any]()]),
      launchItem(["account": accountFields(["driver": "opencode"])]),
      launchItem(["account": accountFields(["homePath": NSNull()])]),
      launchItem(["account": accountFields(["label": 1])]),
      launchItem(["account": accountFields(["id": ""])]),
      launchItem(["account": accountFields(["label": String(repeating: "x", count: LaunchAccount.maxLabelLength + 1)])]),
      launchItem(["account": accountFields(["shadowPath": ".codex_personal"])]),
      launchItem(["account": accountFields(["shadowPath": "~/.codex"])]),
    ]
    for item in bad {
      #expect(launchMessage([launchItem(), item]) == nil, "\(item)")
    }
    #expect(launchMessage([Any]()) == nil)
    #expect(launchMessage(Array(repeating: launchItem(), count: BrokerLimits.maxLaunches + 1)) == nil)
    #expect(launchMessage([launchItem()], open: 1) == nil, "openInTerminal must be a boolean")
    #expect(launchMessage([launchItem()], open: NSNull()) == nil)
    #expect(launchMessage([launchItem()], id: 5) == nil)
    #expect(launchMessage([launchItem()], id: "") == nil)
    #expect(BridgeMessage(body: ["type": "terminal-launch", "launches": [launchItem()]]) == nil)
  }

  @Test func resolvesTheFolderForTheBroker() throws {
    let home = "/Users/me"
    func folder(_ cwd: String?) -> String? {
      TerminalSessionLaunch(project: "acme", agent: nil, title: "", cwd: cwd, command: "claude")?.brokerLaunch(home: home)?.cwd
    }
    #expect(folder("~/src/a b") == "/Users/me/src/a b")
    #expect(folder("~") == "/Users/me")
    #expect(folder(nil) == "/Users/me")
    #expect(folder("/opt/x") == "/opt/x")
    let launch = TerminalSessionLaunch(project: "acme", agent: "Atlas", title: "t", cwd: "~/x", command: "c")!
    #expect(launch.brokerLaunch(home: "/Users/me/") == (try BrokerLaunch(project: "acme", agent: "Atlas", title: "t", cwd: "/Users/me/x", command: "c")))
    // A home that pushes the folder past the broker's limit.
    let long = TerminalSessionLaunch(project: "acme", agent: nil, title: "", cwd: "~/" + String(repeating: "x", count: 1000), command: "c")!
    #expect(long.brokerLaunch(home: "/" + String(repeating: "h", count: 100)) == nil)
  }

  @Test func parsesTheStreamMessages() {
    #expect(BridgeMessage(body: ["type": "terminal-attach", "id": "a", "session": "hm-acme-atlas", "cols": 80, "rows": 24])
      == .terminalAttach(id: "a", session: atlas, size: TerminalSize(columns: 80, rows: 24)!))
    #expect(BridgeMessage(body: ["type": "terminal-input", "stream": 2, "data": "aGk="]) == .terminalInput(stream: 2, data: Data("hi".utf8)))
    #expect(BridgeMessage(body: ["type": "terminal-resize", "stream": 2, "cols": 100, "rows": 30])
      == .terminalResize(stream: 2, size: TerminalSize(columns: 100, rows: 30)!))
    #expect(BridgeMessage(body: ["type": "terminal-detach", "stream": 2]) == .terminalDetach(stream: 2))
    #expect(BridgeMessage(body: ["type": "terminal-ack", "stream": 2, "bytes": 4096]) == .terminalAck(stream: 2, bytes: 4096))
    #expect(BridgeMessage(body: ["type": "terminal-kill", "session": "hm-acme-atlas"]) == .terminalKill(id: nil, session: atlas))
    #expect(BridgeMessage(body: ["type": "terminal-open", "session": "hm-acme-atlas"]) == .terminalOpen(session: atlas))
    #expect(BridgeMessage(body: ["type": "sessions-subscribe"]) == .sessionsSubscribe)
    #expect(BridgeMessage(body: ["type": "sessions-unsubscribe"]) == .sessionsUnsubscribe)
  }

  @Test func parsesABatchKill() {
    let bea = SessionName("hm-acme-bea")!
    #expect(BridgeMessage(body: ["type": "terminal-kill", "id": "all", "sessions": ["hm-acme-atlas", "hm-acme-bea", "hm-acme-atlas"]])
      == .terminalKillMany(id: "all", sessions: [atlas, bea]), "repeats are dropped, in order")
    let most = (1...BridgeMessage.maxKillSessions).map { "hm-acme-a\($0)" }
    if case .terminalKillMany(_, let sessions) = BridgeMessage(body: ["type": "terminal-kill", "sessions": most]) {
      #expect(sessions.count == BridgeMessage.maxKillSessions)
    } else {
      Issue.record("\(BridgeMessage.maxKillSessions) sessions are one batch")
    }
    let bad: [[String: Any]] = [
      ["type": "terminal-kill", "sessions": []],
      ["type": "terminal-kill", "sessions": most + ["hm-acme-more"]],
      ["type": "terminal-kill", "sessions": ["hm-acme-atlas", "acme"]],
      ["type": "terminal-kill", "sessions": ["hm-acme-atlas", 7]],
      ["type": "terminal-kill", "sessions": "hm-acme-atlas"],
      ["type": "terminal-kill", "sessions": NSNull()],
      ["type": "terminal-kill", "session": "hm-acme-atlas", "sessions": ["hm-acme-bea"]],
      ["type": "terminal-kill", "id": 5, "sessions": ["hm-acme-atlas"]],
    ]
    for body in bad {
      #expect(BridgeMessage(body: body) == nil, "\(body)")
    }
  }

  @Test func parsesAnAccountPrepareAndLeavesItsPathsToTheBroker() {
    #expect(BridgeMessage(body: ["type": "account-prepare", "id": "p1", "account": accountFields()])
      == .accountPrepare(id: "p1", account: codexPersonal))
    #expect(BridgeMessage(body: ["type": "account-prepare", "account": accountFields(["shadowPath": "", "homePath": "/Volumes/x/.codex"])])
      == .accountPrepare(id: nil, account: LaunchAccount(id: "a1", driver: .codex, label: "Codex personal", homePath: "/Volumes/x/.codex", shadowPath: "")))
    let bad: [[String: Any]] = [
      ["type": "account-prepare", "id": "p1"],
      ["type": "account-prepare", "id": "p1", "account": NSNull()],
      ["type": "account-prepare", "id": "p1", "account": "a1"],
      ["type": "account-prepare", "id": "p1", "account": accountFields(["driver": "opencode"])],
      ["type": "account-prepare", "id": "p1", "account": accountFields(["homePath": NSNull()])],
      ["type": "account-prepare", "id": "p1", "account": accountFields(["id": ""])],
      ["type": "account-prepare", "id": "p1", "account": accountFields(["label": " "])],
      ["type": "account-prepare", "id": "p1", "account": accountFields(["shadowPath": ".codex_personal"])],
      ["type": "account-prepare", "id": "p1", "account": accountFields(["shadowPath": "~/.codex_personal/"])],
      ["type": "account-prepare", "id": "p1", "account": accountFields(["shadowPath": "~/.codex"])],
      ["type": "account-prepare", "id": 5, "account": accountFields()],
      ["type": "account-prepare", "id": "", "account": accountFields()],
    ]
    for body in bad {
      #expect(BridgeMessage(body: body) == nil, "\(body)")
    }
  }

  @Test func anAccountPrepareMayNameAHostAndConversationsFindNamesOne() {
    // docs/remote-hosts.md#accounts and #conversations.
    #expect(BridgeMessage(body: ["type": "account-prepare", "id": "p1", "account": accountFields(), "host": fakeHost.id])
      == .accountPrepare(id: "p1", account: codexPersonal, host: fakeHost.id))
    #expect(BridgeMessage(body: ["type": "account-prepare", "id": "p1", "account": accountFields(), "host": NSNull()])
      == .accountPrepare(id: "p1", account: codexPersonal))
    let agents: [[String: Any]] = [["id": "a1", "name": "Atlas", "worktree": "/Users/me/acme"], ["id": "b1", "name": "Bea", "worktree": NSNull()]]
    #expect(BridgeMessage(body: ["type": "conversations-find", "id": "c1", "host": fakeHost.id, "agents": agents])
      == .conversationsFind(id: "c1", host: fakeHost.id, agents: [ConversationAgent(id: "a1", name: "Atlas", worktree: "/Users/me/acme"),
                                                                   ConversationAgent(id: "b1", name: "Bea", worktree: nil)]))
    let bad: [[String: Any]] = [
      ["type": "account-prepare", "id": "p1", "account": accountFields(), "host": "Build Mac"],
      ["type": "account-prepare", "id": "p1", "account": accountFields(), "host": "20000000-0000-4000-8000-00000000000A"],
      ["type": "account-prepare", "id": "p1", "account": accountFields(), "host": 5],
      ["type": "conversations-find", "id": "c1", "agents": agents],
      ["type": "conversations-find", "id": "c1", "host": "x", "agents": agents],
      ["type": "conversations-find", "id": "c1", "host": fakeHost.id],
      ["type": "conversations-find", "id": "c1", "host": fakeHost.id, "agents": [["id": "a1", "name": "Atlas", "worktree": 5]]],
      ["type": "conversations-find", "id": "c1", "host": fakeHost.id, "agents": [["id": "", "name": "Atlas", "worktree": NSNull()]]],
      ["type": "conversations-find", "id": "c1", "host": fakeHost.id, "agents": [["id": "a1", "name": "At\nlas", "worktree": NSNull()]]],
    ]
    for body in bad { #expect(BridgeMessage(body: body) == nil, "\(body)") }
  }

  @Test @MainActor func aHostsPrepareAndItsConversationsGoToTheBrokerAndTheirAnswersToThePage() throws {
    let client = FakeBrokerClient()
    let recorder = RouterRecorder()
    let router = TerminalBridgeRouter(client: client, environment: .init(
      home: "/Users/me", tmuxConfigPath: "/tmp/tmux.conf", now: { recorder.clock },
      deliver: { recorder.delivered.append($0) }, openTerminals: { recorder.opened.append($0) }, scheduler: FakeScheduler()))
    router.handle(.accountPrepare(id: "p1", account: codexPersonal, host: fakeHost.id))
    #expect(client.sent == [.accountPrepare(account: codexPersonal, host: fakeHost.id)])
    client.answer(.accountPrepared(AccountPreparation(loggedIn: false)))
    let agents = [ConversationAgent(id: "a1", name: "Atlas", worktree: nil)]
    router.handle(.conversationsFind(id: "c1", host: fakeHost.id, agents: agents))
    #expect(client.sent.last == .conversationsFind(host: fakeHost.id, agents: agents))
    let found = BrokerConversation(cli: "codex", software: "codex2", id: "01a13757-5872-7e90-8bde-22d6bdb43926", cwd: nil, at: 1, host: fakeHost.id)
    client.answer(.conversations(["a1": found]))
    #expect(recorder.delivered == [.accountPrepared(id: "p1", AccountPreparation(loggedIn: false)), .conversationsFound(id: "c1", ["a1": found])])
    let detail = BridgeTerminalEvent.conversationsFound(id: "c1", ["a1": found]).detail
    #expect(detail["type"] as? String == "conversations-found")
    let item = try #require((detail["conversations"] as? [String: [String: Any]])?["a1"])
    #expect(item["host"] as? String == fakeHost.id && item["software"] as? String == "codex2" && item["cwd"] is NSNull)
    #expect(TerminalTrustGate.refusal(.conversationsFind(id: "c1", host: fakeHost.id, agents: agents))
      == .answer(.error(id: "c1", code: .unauthorized, message: TerminalTrustGate.unverifiedMessage, stream: nil)))
  }

  @Test @MainActor func anAccountPrepareGoesToTheBrokerAndOnlyItsPageHearsTheAnswer() {
    let client = FakeBrokerClient()
    let recorder = RouterRecorder()
    let router = TerminalBridgeRouter(client: client, environment: .init(
      home: "/Users/me", tmuxConfigPath: "/tmp/tmux.conf", now: { recorder.clock },
      deliver: { recorder.delivered.append($0) }, openTerminals: { recorder.opened.append($0) }, scheduler: FakeScheduler()))
    router.handle(.accountPrepare(id: "p1", account: codexPersonal))
    #expect(client.started == 1)
    #expect(client.sent == [.accountPrepare(account: codexPersonal)], "the paths go as the page sent them")
    client.answer(.accountPrepared(AccountPreparation(loggedIn: false)))
    #expect(recorder.delivered == [.accountPrepared(id: "p1", AccountPreparation(loggedIn: false))])
    router.handle(.accountPrepare(id: "p2", account: codexPersonal))
    router.pageDidChange()
    client.answer(.accountPrepared(AccountPreparation(loggedIn: true)))
    #expect(recorder.delivered.count == 1, "an answer for a page that is gone is dropped")
    client.push(.accountPrepared(AccountPreparation(loggedIn: true)))
    #expect(recorder.delivered.count == 1, "an answer nobody asked for is dropped")
  }

  @Test func anAccountPrepareFromAnUnverifiedPageIsRefusedAndTheIOSAppForwardsItAsIs() {
    #expect(TerminalTrustGate.refusal(.accountPrepare(id: "p1", account: codexPersonal))
      == .answer(.error(id: "p1", code: .unauthorized, message: TerminalTrustGate.unverifiedMessage, stream: nil)))
    // On a device the broker, through the gateway, expands the account's ~/: no home is needed for it.
    for home in ["/Users/me", nil] {
      #expect(RemoteTerminalPolicy.decide(.accountPrepare(id: "p1", account: codexPersonal), home: home)
        == .forward(.accountPrepare(id: "p1", account: codexPersonal)))
    }
  }

  @Test func dropsBadStreamMessages() {
    let bad: [[String: Any]] = [
      ["type": "terminal-attach", "session": "acme", "cols": 80, "rows": 24],
      ["type": "terminal-attach", "session": "hm-acme", "cols": 80],
      ["type": "terminal-attach", "session": "hm-acme", "cols": 80.5, "rows": 24],
      ["type": "terminal-attach", "session": "hm-acme", "cols": true, "rows": 24],
      ["type": "terminal-attach", "session": "hm-acme", "cols": 5000, "rows": 24],
      ["type": "terminal-input", "stream": 0, "data": "aGk="],
      ["type": "terminal-input", "stream": "1", "data": "aGk="],
      ["type": "terminal-input", "stream": 1, "data": ""],
      ["type": "terminal-input", "stream": 1, "data": "not base64!"],
      ["type": "terminal-input", "stream": 1, "data": Data(count: BrokerLimits.maxInputBytes + 1).base64EncodedString()],
      ["type": "terminal-input", "stream": 1],
      ["type": "terminal-resize", "stream": 1, "cols": 0, "rows": 0],
      ["type": "terminal-detach"],
      ["type": "terminal-ack", "stream": 1],
      ["type": "terminal-ack", "stream": 1, "bytes": 0],
      ["type": "terminal-ack", "stream": 1, "bytes": -5],
      ["type": "terminal-ack", "stream": 1, "bytes": 1.5],
      ["type": "terminal-ack", "stream": 1, "bytes": true],
      ["type": "terminal-ack", "stream": 0, "bytes": 1],
      ["type": "terminal-kill", "session": "hm-acme atlas"],
      ["type": "terminal-open", "session": 7],
      ["type": "terminal-shell", "command": "id"],
    ]
    for body in bad {
      #expect(BridgeMessage(body: body) == nil, "\(body)")
    }
    #expect(BridgeMessage(body: ["type": "terminal-input", "stream": 1,
                                 "data": Data(count: BrokerLimits.maxInputBytes).base64EncodedString()]) != nil)
  }
}

struct BridgeTerminalEventTests {
  private func detail(_ event: BridgeTerminalEvent) throws -> [String: Any] {
    let script = event.javaScript
    let prefix = #"window.dispatchEvent(new CustomEvent("hivemind:terminal", {detail: "#
    #expect(script.hasPrefix(prefix))
    #expect(script.hasSuffix("}));"))
    let json = script.dropFirst(prefix.count).dropLast(4)
    return try #require(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
  }

  @Test func encodesEveryEventAsJSONDetail() throws {
    let status = try detail(.status(tmux: .missing, broker: .connected))
    #expect(status["type"] as? String == "terminal-status")
    #expect(status["tmux"] as? String == "missing")
    #expect(status["broker"] as? String == "connected")

    let sessions = try detail(.sessions([BrokerSession(name: atlas, project: "acme", agent: nil, alive: true, attached: 1, createdAt: 42)]))
    let item = try #require((sessions["items"] as? [[String: Any]])?.first)
    #expect(item["name"] as? String == "hm-acme-atlas")
    #expect(item["agent"] is NSNull)
    #expect(item["alive"] as? Bool == true)
    #expect(item["createdAt"] as? Int == 42)

    let launched = try detail(.launched(id: "r", names: [atlas, nil], created: [atlas],
                                        errors: [BrokerLaunchFailure(index: 1, code: .cwdMissing, message: "gone")]))
    #expect(launched["type"] as? String == "terminal-launched")
    #expect((launched["names"] as? [Any])?.count == 2)
    #expect((launched["names"] as? [Any])?.last is NSNull)
    #expect(((launched["errors"] as? [[String: Any]])?.first?["code"]) as? String == "cwd-missing")

    let output = try detail(.output(stream: 3, data: Data([0x1B, 0, 0xFF])))
    #expect(output["data"] as? String == Data([0x1B, 0, 0xFF]).base64EncodedString())
    #expect(try detail(.exit(stream: 3, status: nil))["status"] is NSNull)
    #expect(try detail(.attached(id: nil, stream: 3, session: atlas))["id"] is NSNull)
    #expect(try detail(.killed(id: "k", session: atlas))["type"] as? String == "terminal-killed")
    let many = try detail(.killedMany(id: "all", sessions: [atlas],
                                      errors: [BridgeKillFailure(session: SessionName("hm-acme-bea")!, code: .noSuchSession, message: "gone")]))
    #expect(many["type"] as? String == "terminal-killed")
    #expect(many["id"] as? String == "all")
    #expect(many["session"] == nil)
    #expect(many["sessions"] as? [String] == ["hm-acme-atlas"])
    #expect((many["errors"] as? [[String: String]]) == [["session": "hm-acme-bea", "code": "no-such-session", "message": "gone"]])
    let error = try detail(.error(id: "a", code: .noSuchSession, message: "</script>\u{2028}", stream: nil))
    #expect(error["message"] as? String == "</script>\u{2028}")
  }

  @Test func encodesTheAccountPreparedAnswerWithOkAndTheErrorOnlyWhenThereIsOne() throws {
    let ready = try detail(.accountPrepared(id: "p1", AccountPreparation(loggedIn: true)))
    #expect(ready["type"] as? String == "account-prepared")
    #expect(ready["id"] as? String == "p1")
    #expect(ready["ok"] as? Bool == true)
    #expect(ready["loggedIn"] as? Bool == true)
    #expect(ready["error"] == nil)
    let failed = try detail(.accountPrepared(id: nil, AccountPreparation(loggedIn: false, error: "Move it away.")))
    #expect(failed["id"] is NSNull)
    #expect(failed["ok"] as? Bool == false)
    #expect(failed["loggedIn"] as? Bool == false)
    #expect(failed["error"] as? String == "Move it away.")
    #expect(BridgeTerminalEvent(BrokerEventFrame(id: "b-3", .accountPrepared(AccountPreparation(loggedIn: false))), id: "p1")
      == .accountPrepared(id: "p1", AccountPreparation(loggedIn: false)))
  }

  @Test func neverSplicesRawTextIntoTheScript() throws {
    let message = "\"}}); alert(1); ({\"\u{2028}"
    let event = BridgeTerminalEvent.error(id: nil, code: .internal, message: message, stream: nil)
    #expect(!event.javaScript.contains("\u{2028}"))
    #expect(try detail(event)["message"] as? String == message)
  }

  @Test func mapsBrokerEventsForThePage() {
    #expect(BridgeTerminalEvent(BrokerEventFrame(.welcome(version: 1, tmuxPath: nil))) == nil)
    #expect(BridgeTerminalEvent(BrokerEventFrame(id: "b-7", .attached(stream: 1, session: atlas)), id: "page-1")
      == .attached(id: "page-1", stream: 1, session: atlas))
    #expect(BridgeTerminalEvent(BrokerEventFrame(.output(stream: 1, data: Data("x".utf8)))) == .output(stream: 1, data: Data("x".utf8)))
    #expect(BridgeTerminalEvent(BrokerEventFrame(.error(code: .tmuxMissing, message: "m", stream: nil)), id: "p")
      == .error(id: "p", code: .tmuxMissing, message: "m", stream: nil))
  }

  @Test func theNativeCommandsStillDispatchAsBefore() {
    #expect(BridgeCommand.navigate(hash: "#/c/general").javaScript
      == ##"window.dispatchEvent(new CustomEvent("hivemind:native", {detail: {"command":"navigate","hash":"#\/c\/general"}}));"##)
  }
}
