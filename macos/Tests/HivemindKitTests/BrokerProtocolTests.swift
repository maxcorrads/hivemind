import Foundation
import Testing
@testable import HivemindKit

// The broker's wire protocol, decoded and encoded only: nothing here opens a
// socket or runs tmux.

private func request(_ json: String) throws(BrokerProtocolError) -> BrokerRequestFrame {
  try BrokerRequestFrame.decode(Data(json.utf8))
}

private func refusal(_ json: String) -> BrokerProtocolError? {
  do {
    _ = try request(json)
    return nil
  } catch {
    return error
  }
}

private func eventRefusal(_ json: String) -> BrokerProtocolError? {
  do {
    _ = try BrokerEventFrame.decode(Data(json.utf8))
    return nil
  } catch {
    return error
  }
}

private let atlas = SessionName("hm-acme-atlas")!
private let size = TerminalSize(columns: 120, rows: 40)!

private func launch(project: String = "acme", agent: String? = "Atlas", title: String = "Acme - Atlas",
                    cwd: String = "/Users/me/acme", command: String = "claude", account: LaunchAccount? = nil) throws -> BrokerLaunch {
  try BrokerLaunch(project: project, agent: agent, title: title, cwd: cwd, command: command, account: account)
}

private let claudeWork = LaunchAccount(id: "a1", driver: .claude, label: "Claude work", homePath: "", shadowPath: "~/.claude-work")

struct BrokerVersionTests {
  @Test func negotiatesTheHighestCommonVersion() {
    #expect(BrokerProtocol.negotiate(clientVersion: 1) == 1)
    #expect(BrokerProtocol.negotiate(clientVersion: 7) == BrokerProtocol.version)
    #expect(BrokerProtocol.negotiate(clientVersion: 0) == nil)
    #expect(BrokerProtocol.negotiate(clientVersion: -1) == nil)
  }
}

struct BrokerRequestTests {
  @Test func everyRequestRoundTrips() throws {
    let frames: [BrokerRequestFrame] = [
      .init(id: "1", .hello(version: 1, token: String(repeating: "a", count: 64), client: "Hivemind.app 0.5.0")),
      .init(.hello(version: 1, token: "t", client: nil)),
      .init(id: "2", .sessionsList),
      .init(.sessionsSubscribe),
      .init(.sessionsUnsubscribe),
      .init(id: "l", .launch([try launch(), try launch(agent: nil, title: "", command: "codex 'hi'\n")])),
      .init(id: "r", .launch([try BrokerLaunch(project: "acme", agent: "Atlas", title: "t", cwd: "/", command: "c", session: SessionName("hm-acme-new-1"))])),
      .init(id: "w", .launch([try launch(account: claudeWork), try launch(agent: nil, command: "codex")])),
      .init(id: "a", .attach(session: atlas, size: size)),
      .init(.input(stream: 3, data: Data([0, 1, 2, 0xFF, 0x1B]))),
      .init(.resize(stream: 3, size: TerminalSize(columns: 2, rows: 1)!)),
      .init(.detach(stream: 3)),
      .init(id: "k", .kill(session: atlas)),
      .init(id: "p", .accountPrepare(account: claudeWork)),
      .init(id: "p", .accountPrepare(account: claudeWork, host: "20000000-0000-4000-8000-000000000001")),
      .init(id: "c", .conversationsFind(host: "20000000-0000-4000-8000-000000000001",
                                        agents: [ConversationAgent(id: "a1", name: "Atlas", worktree: "/Users/me/acme")])),
    ]
    for frame in frames {
      let line = try frame.line()
      #expect(line.last == UInt8(ascii: "\n"))
      #expect(!line.dropLast().contains(UInt8(ascii: "\n")), "one line")
      #expect(try BrokerRequestFrame.decode(line.dropLast()) == frame)
    }
  }

  @Test func theWireFormatIsFlatJSONWithType() throws {
    #expect(try request(#"{"type":"sessions.subscribe"}"#) == .init(.sessionsSubscribe))
    #expect(try request(#"{"type":"attach","id":"x","session":"hm-acme-atlas","cols":80,"rows":24}"#)
      == .init(id: "x", .attach(session: atlas, size: TerminalSize(columns: 80, rows: 24)!)))
    #expect(try request(#"{"type":"input","stream":1,"data":"aGk="}"#) == .init(.input(stream: 1, data: Data("hi".utf8))))
    #expect(try request(#"{"type":"launch","launches":[{"project":"acme","agent":null,"title":"t","cwd":"/","command":"c"}]}"#)
      == .init(.launch([try launch(agent: nil, title: "t", cwd: "/", command: "c")])))
    // Unknown keys are ignored, for later minor additions.
    #expect(try request(#"{"type":"detach","stream":2,"extra":[1,2]}"#) == .init(.detach(stream: 2)))
    let hello = try BrokerRequestFrame(.hello(version: 1, token: "abc", client: nil)).line()
    let object = try JSONSerialization.jsonObject(with: hello) as? [String: Any]
    #expect(object?["type"] as? String == "hello")
    #expect(object?["token"] as? String == "abc")
    #expect(object?["id"] == nil)
  }

  @Test func refusesMalformedFramesWithAReason() {
    let cases: [(String, BrokerErrorCode, String)] = [
      ("not json", .badMessage, "JSON"),
      ("[1]", .badMessage, "JSON object"),
      ("\"hello\"", .badMessage, "JSON object"),
      ("{}", .badMessage, "type: is missing"),
      (#"{"type":7}"#, .badMessage, "type: must be a string"),
      (#"{"type":"shell"}"#, .unknownType, "\"shell\""),
      (#"{"type":"hello","token":"t"}"#, .badMessage, "version: is missing"),
      (#"{"type":"hello","version":"1","token":"t"}"#, .badMessage, "version: must be an integer"),
      (#"{"type":"hello","version":true,"token":"t"}"#, .badMessage, "version: must be an integer"),
      (#"{"type":"hello","version":1.5,"token":"t"}"#, .badMessage, "version"),
      (#"{"type":"hello","version":1}"#, .badMessage, "token: is missing"),
      (#"{"type":"hello","version":1,"token":"t","client":"a\nb"}"#, .badMessage, "client"),
      (#"{"type":"sessions.list","id":""}"#, .badMessage, "id"),
      (#"{"type":"sessions.list","id":5}"#, .badMessage, "id"),
      (#"{"type":"sessions.list","id":"\#(String(repeating: "i", count: 65))"}"#, .badMessage, "id"),
      (#"{"type":"attach","session":"hm-acme","cols":0,"rows":24}"#, .badMessage, "cols/rows"),
      (#"{"type":"attach","session":"hm-acme","cols":80,"rows":501}"#, .badMessage, "cols/rows"),
      (#"{"type":"attach","session":"acme","cols":80,"rows":24}"#, .badMessage, "session: must match"),
      (#"{"type":"attach","session":"hm-acme;kill","cols":80,"rows":24}"#, .badMessage, "session"),
      (#"{"type":"kill","session":null}"#, .badMessage, "session"),
      (#"{"type":"launch","launches":[{"project":"acme","title":"t","cwd":"/","command":"c","session":"acme-1"}]}"#, .badMessage, "launches[0].session"),
      (#"{"type":"launch","launches":[{"project":"acme","title":"t","cwd":"/","command":"c","session":3}]}"#, .badMessage, "launches[0].session"),
      (#"{"type":"input","stream":0,"data":"aGk="}"#, .badMessage, "stream"),
      (#"{"type":"input","stream":-1,"data":"aGk="}"#, .badMessage, "stream"),
      (#"{"type":"input","stream":1,"data":""}"#, .badMessage, "data"),
      (#"{"type":"input","stream":1,"data":"***"}"#, .badMessage, "data: must be base64"),
      (#"{"type":"resize","stream":1,"cols":80}"#, .badMessage, "rows: is missing"),
      (#"{"type":"launch","launches":[]}"#, .badMessage, "launches: must hold 1–24"),
      (#"{"type":"launch","launches":{}}"#, .badMessage, "launches: must be an array"),
      (#"{"type":"launch","launches":["x"]}"#, .badMessage, "launches[0]: must be an object"),
    ]
    for (json, code, reason) in cases {
      let error = refusal(json)
      #expect(error?.code == code, "\(json)")
      #expect(error?.message.contains(reason) == true, "\(json): \(error?.message ?? "accepted")")
    }
  }

  @Test func refusesEveryBadLaunchNamingIt() {
    let good = #"{"project":"acme","agent":"Atlas","title":"t","cwd":"/x","command":"claude"}"#
    let bad: [(String, String)] = [
      (#"{"agent":"Atlas","title":"t","cwd":"/x","command":"claude"}"#, "launches[1].project: is missing"),
      (#"{"project":"Acme","title":"t","cwd":"/x","command":"claude"}"#, "launches[1].project"),
      (#"{"project":"-acme","title":"t","cwd":"/x","command":"claude"}"#, "launches[1].project"),
      (#"{"project":"\#(String(repeating: "a", count: 33))","title":"t","cwd":"/x","command":"claude"}"#, "project"),
      (#"{"project":"acme","agent":"","title":"t","cwd":"/x","command":"claude"}"#, "launches[1].agent"),
      (#"{"project":"acme","agent":"   ","title":"t","cwd":"/x","command":"claude"}"#, "launches[1].agent"),
      (#"{"project":"acme","agent":"a\tb","title":"t","cwd":"/x","command":"claude"}"#, "launches[1].agent"),
      (#"{"project":"acme","agent":"\#(String(repeating: "a", count: 65))","title":"t","cwd":"/x","command":"claude"}"#, "agent"),
      (#"{"project":"acme","agent":3,"title":"t","cwd":"/x","command":"claude"}"#, "launches[1].agent"),
      (#"{"project":"acme","title":"t","cwd":"relative","command":"claude"}"#, "launches[1].cwd: must be an absolute path"),
      (#"{"project":"acme","title":"t","cwd":"~/x","command":"claude"}"#, "launches[1].cwd"),
      (#"{"project":"acme","title":"t","cwd":"/x\u0000y","command":"claude"}"#, "launches[1].cwd: must not contain NUL"),
      (#"{"project":"acme","title":"t","cwd":"/\#(String(repeating: "a", count: 1024))","command":"claude"}"#, "cwd: must be at most 1024 bytes"),
      (#"{"project":"acme","title":"t","command":"claude"}"#, "launches[1].cwd: is missing"),
      (#"{"project":"acme","title":"t","cwd":"/x","command":" \n"}"#, "launches[1].command: must not be empty"),
      (#"{"project":"acme","title":"t","cwd":"/x","command":"a\u0000b"}"#, "command: must not contain NUL"),
      (#"{"project":"acme","title":"t","cwd":"/x","command":"\#(String(repeating: "é", count: 4097))"}"#, "command: must be at most 8192 bytes"),
      (#"{"project":"acme","title":"\#(String(repeating: "t", count: 201))","cwd":"/x","command":"c"}"#, "launches[1].title"),
      (#"{"project":"acme","cwd":"/x","command":"c"}"#, "launches[1].title: is missing"),
      (#"{"project":"acme","title":"t","cwd":"/x","command":"c","account":"a1"}"#, "launches[1].account: must be an object"),
      (#"{"project":"acme","title":"t","cwd":"/x","command":"c","account":{"id":"a1","driver":"opencode","label":"x","homePath":"","shadowPath":""}}"#,
       "launches[1].account: must be an object"),
      (#"{"project":"acme","title":"t","cwd":"/x","command":"c","account":{"id":"a1","driver":"codex","label":"x","shadowPath":""}}"#,
       "launches[1].account: must be an object"),
      (#"{"project":"acme","title":"t","cwd":"/x","command":"c","account":{"id":"a1","driver":"codex","label":"x","homePath":null,"shadowPath":""}}"#,
       "launches[1].account: must be an object"),
      (#"{"project":"acme","title":"t","cwd":"/x","command":"c","account":{"id":"","driver":"codex","label":"x","homePath":"","shadowPath":""}}"#,
       "launches[1].account.id: must be 1–64 bytes"),
      (#"{"project":"acme","title":"t","cwd":"/x","command":"c","account":{"id":"a1","driver":"codex","label":" ","homePath":"","shadowPath":""}}"#,
       "launches[1].account.label: must be 1–80 characters"),
      (#"{"project":"acme","title":"t","cwd":"/x","command":"c","account":{"id":"a1","driver":"codex","label":"x","homePath":"~/.codex/","shadowPath":""}}"#,
       "launches[1].account.homePath: a path cannot end with /"),
      (#"{"project":"acme","title":"t","cwd":"/x","command":"c","account":{"id":"a1","driver":"claude","label":"x","homePath":"","shadowPath":"~/.claude"}}"#,
       "launches[1].account.shadowPath: a shadow is its own directory, not the shared tree"),
    ]
    for (item, reason) in bad {
      let error = refusal(#"{"type":"launch","launches":[\#(good),\#(item)]}"#)
      #expect(error?.code == .badMessage, "\(item)")
      #expect(error?.message.contains(reason) == true, "\(item): \(error?.message ?? "accepted")")
    }
    let many = Array(repeating: good, count: BrokerLimits.maxLaunches + 1).joined(separator: ",")
    #expect(refusal(#"{"type":"launch","launches":[\#(many)]}"#)?.message.contains("1–24") == true)
  }

  @Test func aLaunchCarriesItsAccountAsStored() throws {
    let frame = BrokerRequestFrame(id: "l", .launch([try launch(account: claudeWork), try launch()]))
    let line = try frame.line()
    let object = try JSONSerialization.jsonObject(with: line) as? [String: Any]
    let items = object?["launches"] as? [[String: Any]]
    #expect(items?[0]["account"] as? [String: String]
      == ["id": "a1", "driver": "claude", "label": "Claude work", "homePath": "", "shadowPath": "~/.claude-work"], "~/ is not expanded")
    #expect(items?[1].keys.contains("account") == false)
    let decoded = try BrokerRequestFrame.decode(line.dropLast())
    guard case .launch(let launches) = decoded.request else { Issue.record("not a launch"); return }
    #expect(launches.map(\.account) == [claudeWork, nil])
    // A frame from before accounts, and an explicit null, launch without one.
    let item = #"{"project":"acme","agent":"Atlas","title":"Acme - Atlas","cwd":"/Users/me/acme","command":"claude"%@}"#
    for extra in ["", #","account":null"#] {
      #expect(try request(#"{"type":"launch","launches":["# + String(format: item, extra) + "]}") == .init(.launch([try launch()])))
    }
    #expect(throws: BrokerProtocolError.invalid("launch.account.shadowPath", "a path starts with / or ~/")) {
      try launch(account: LaunchAccount(id: "a1", driver: .codex, label: "x", homePath: "", shadowPath: "codex"))
    }
  }

  @Test func aLaunchNamesItsHostOnlyWhenItHasOneAndOnlyAsAHostID() throws {
    let host = "20000000-0000-4000-8000-000000000001"
    let onHost = try BrokerLaunch(project: "acme", agent: "Atlas", title: "Acme - Atlas", cwd: "/Users/me/acme", command: "claude", host: host)
    let line = try BrokerRequestFrame(id: "l", .launch([onHost, try launch()])).line()
    let items = (try JSONSerialization.jsonObject(with: line) as? [String: Any])?["launches"] as? [[String: Any]]
    #expect(items?[0]["host"] as? String == host)
    #expect(items?[1].keys.contains("host") == false, "this Mac's launch is as before hosts")
    guard case .launch(let launches) = try BrokerRequestFrame.decode(line.dropLast()).request else { Issue.record("not a launch"); return }
    #expect(launches.map(\.host) == [host, nil])
    for bad in ["Build Mac", "20000000-0000-4000-8000-00000000000A", "user@mini.local"] {
      #expect(throws: BrokerProtocolError.invalid("launch.host", "must be a host id (a lowercase UUID)")) {
        try BrokerLaunch(project: "acme", agent: "Atlas", title: "Acme - Atlas", cwd: "/Users/me/acme", command: "claude", host: bad)
      }
    }
    // A session of this Mac has no host key; a host's names its host.
    let local = BrokerSession(name: SessionName("hm-acme-atlas")!, project: "acme", agent: "Atlas", alive: true, attached: 0, createdAt: 1)
    let sessions = try BrokerEventFrame(id: nil, .sessions([local, local.on(host: host)])).line()
    let listed = (try JSONSerialization.jsonObject(with: sessions) as? [String: Any])?["items"] as? [[String: Any]]
    #expect(listed?[0].keys.contains("host") == false)
    #expect(listed?[1]["host"] as? String == host)
    #expect(try BrokerEventFrame.decode(sessions.dropLast()).event == .sessions([local, local.on(host: host)]))
  }

  @Test func anAccountPrepareCarriesItsAccountAsStoredAndIsCheckedAsALaunchsIs() throws {
    let line = try BrokerRequestFrame(id: "p1", .accountPrepare(account: claudeWork)).line()
    let object = try JSONSerialization.jsonObject(with: line) as? [String: Any]
    #expect(object?["type"] as? String == "account.prepare")
    #expect(object?["account"] as? [String: String]
      == ["id": "a1", "driver": "claude", "label": "Claude work", "homePath": "", "shadowPath": "~/.claude-work"], "~/ is not expanded")
    let account = #"{"id":"a1","driver":"codex","label":"Codex work","homePath":"","shadowPath":"%@"}"#
    #expect(try request(#"{"type":"account.prepare","id":"p","account":"# + String(format: account, "~/.codex_work") + "}")
      == .init(id: "p", .accountPrepare(account: LaunchAccount(id: "a1", driver: .codex, label: "Codex work", homePath: "", shadowPath: "~/.codex_work"))))
    let bad: [(String, String)] = [
      (#"{"type":"account.prepare"}"#, "account: is missing"),
      (#"{"type":"account.prepare","account":null}"#, "account: is missing"),
      (#"{"type":"account.prepare","account":"a1"}"#, "account: must be an object"),
      (#"{"type":"account.prepare","account":{"id":"a1","driver":"opencode","label":"x","homePath":"","shadowPath":""}}"#,
       "account: must be an object"),
      (#"{"type":"account.prepare","account":"# + String(format: account, "codex_work") + "}", "account.shadowPath: a path starts with / or ~/"),
      (#"{"type":"account.prepare","account":"# + String(format: account, "~/.codex") + "}",
       "account.shadowPath: a shadow is its own directory, not the shared tree"),
      (#"{"type":"account.prepare","account":{"id":"","driver":"codex","label":"x","homePath":"","shadowPath":""}}"#, "account.id"),
    ]
    for (json, reason) in bad {
      let error = refusal(json)
      #expect(error?.code == .badMessage, "\(json)")
      #expect(error?.message.contains(reason) == true, "\(json): \(error?.message ?? "accepted")")
    }
  }

  @Test func acceptsTheLimitsExactly() throws {
    let command = String(repeating: "x", count: BrokerLimits.maxCommandBytes)
    let cwd = "/" + String(repeating: "c", count: BrokerLimits.maxCwdBytes - 1)
    let title = String(repeating: "t", count: BrokerLimits.maxTitleCharacters)
    let agent = String(repeating: "a", count: BrokerLimits.maxAgentCharacters)
    let item = try launch(agent: agent, title: title, cwd: cwd, command: command)
    let frame = BrokerRequestFrame(id: String(repeating: "i", count: 64), .launch(Array(repeating: item, count: BrokerLimits.maxLaunches)))
    #expect(try BrokerRequestFrame.decode(frame.line().dropLast()) == frame)
    let input = BrokerRequestFrame(.input(stream: Int(Int32.max), data: Data(repeating: 7, count: BrokerLimits.maxInputBytes)))
    #expect(try BrokerRequestFrame.decode(input.line().dropLast()) == input)
    let tooMuch = BrokerRequestFrame(.input(stream: 1, data: Data(repeating: 7, count: BrokerLimits.maxInputBytes + 1)))
    #expect(throws: BrokerProtocolError.self) { try BrokerRequestFrame.decode(tooMuch.line().dropLast()) }
    #expect(TerminalSize(columns: 1000, rows: 500) != nil)
    #expect(TerminalSize(columns: 1001, rows: 1) == nil)
    #expect(TerminalSize(columns: 1, rows: 1) == nil)
  }

  @Test func refusesAnOversizedLineBeforeParsingIt() {
    let huge = Data(repeating: UInt8(ascii: " "), count: BrokerLimits.maxRequestBytes + 1)
    #expect(throws: BrokerProtocolError(.tooLarge, "a message must be at most \(BrokerLimits.maxRequestBytes) bytes")) {
      try BrokerRequestFrame.decode(huge)
    }
    #expect(BrokerProtocolError(.tooLarge, "").closesConnection)
    #expect(BrokerProtocolError(.unauthorized, "").closesConnection)
    #expect(!BrokerProtocolError(.badMessage, "").closesConnection)
  }

  private func running(_ name: String, project: String? = "acme", agent: String? = nil) -> BrokerSession {
    BrokerSession(name: SessionName(name)!, project: project, agent: agent, alive: true, attached: 0, createdAt: 0)
  }

  @Test func launchesGetTheirSessionNames() throws {
    let running = [running("hm-acme-new-1"), running("hm-acme-atlas", agent: "Atlas")]
    let names = BrokerLaunch.sessionNames(
      for: [try launch(), try launch(agent: nil), try launch(agent: nil), try launch(project: "beta", agent: nil), try launch(agent: "Atlas")],
      existing: running)
    #expect(names.map(\.rawValue) == ["hm-acme-atlas", "hm-acme-new-2", "hm-acme-new-3", "hm-beta-new-1", "hm-acme-atlas"])
  }

  /// An agent first launched as hm-acme-new-1 keeps that session on resume
  /// while it runs; once it is gone the agent gets its own name.
  @Test func aLaunchReusesTheAgentsRunningSession() throws {
    let first = SessionName("hm-acme-new-1")!
    let resume = try BrokerLaunch(project: "acme", agent: "Atlas", title: "t", cwd: "/", command: "c", session: first)
    #expect(BrokerLaunch.sessionNames(for: [resume], existing: [running(first.rawValue)]) == [first])
    #expect(BrokerLaunch.sessionNames(for: [resume], existing: [running(first.rawValue, agent: "Atlas")]) == [first])
    #expect(BrokerLaunch.sessionNames(for: [resume], existing: []) == [atlas])
    // Never a name the client made up: a session that is not running is ignored.
    let madeUp = try BrokerLaunch(project: "acme", agent: nil, title: "t", cwd: "/", command: "c", session: SessionName("hm-mine")!)
    #expect(BrokerLaunch.sessionNames(for: [madeUp], existing: []) == [SessionName("hm-acme-new-1")!])
  }

  /// The hint is the agent's own join label, which any agent can set: it never reuses another agent's session,
  /// another project's, or one the broker did not launch.
  @Test func theSessionHintNeverReusesAnotherAgentsSession() throws {
    let other = SessionName("hm-acme-new-1")!
    let resume = try BrokerLaunch(project: "acme", agent: "Atlas", title: "t", cwd: "/", command: "c", session: other)
    #expect(BrokerLaunch.sessionNames(for: [resume], existing: [running(other.rawValue, agent: "Nova")]) == [atlas])
    #expect(BrokerLaunch.sessionNames(for: [resume], existing: [running(other.rawValue, project: "beta")]) == [atlas])
    #expect(BrokerLaunch.sessionNames(for: [resume], existing: [running(other.rawValue, project: nil)]) == [atlas])
    let nova = SessionName("hm-acme-nova")!
    let claim = try BrokerLaunch(project: "acme", agent: "Atlas", title: "t", cwd: "/", command: "c", session: nova)
    #expect(BrokerLaunch.sessionNames(for: [claim], existing: [running(nova.rawValue, agent: "Nova")]) == [atlas])
  }
}

struct BrokerEventTests {
  let session = BrokerSession(name: atlas, project: "acme", agent: "Atlas", alive: true, attached: 2, createdAt: 1_790_000_000_000)

  @Test func everyEventRoundTrips() throws {
    let frames: [BrokerEventFrame] = [
      .init(id: "1", .welcome(version: 1, tmuxPath: "/opt/homebrew/bin/tmux")),
      .init(id: "1", .welcome(version: 1, tmuxPath: nil)),
      .init(.sessions([session, BrokerSession(name: SessionName("hm-x")!, project: nil, agent: nil, alive: false, attached: 0, createdAt: 0)])),
      .init(.sessions([])),
      .init(id: "l", .launched(names: [atlas, nil], created: [atlas],
                               errors: [BrokerLaunchFailure(index: 1, code: .cwdMissing, message: "No folder /x")])),
      .init(id: "a", .attached(stream: 1, session: atlas)),
      .init(.output(stream: 1, data: Data([0x1B, 0x5B, 0x48, 0]))),
      .init(.exit(stream: 1, status: 0)),
      .init(.exit(stream: 1, status: nil)),
      .init(id: "k", .killed(session: atlas)),
      .init(id: "a", .error(code: .noSuchSession, message: "hm-acme-atlas is not running", stream: nil)),
      .init(.error(code: .noSuchStream, message: "no stream 4", stream: 4)),
      .init(id: "p", .accountPrepared(AccountPreparation(loggedIn: false))),
      .init(id: "c", .conversations(["a1": BrokerConversation(cli: "claude", software: "claude", id: "c1a2b3c4-0000-4000-8000-000000000001",
                                                              cwd: "/Users/me/acme", at: 1_700_000_000_000, host: "20000000-0000-4000-8000-000000000001")])),
      .init(id: "p", .accountPrepared(AccountPreparation(loggedIn: true, error: "`/Users/me/.codex_work/sessions` is a real file"))),
    ]
    for frame in frames {
      let line = try frame.line()
      #expect(try BrokerEventFrame.decode(line.dropLast()) == frame, "\(frame)")
    }
  }

  @Test func theWireFormatKeepsNulls() throws {
    let welcome = String(decoding: try BrokerEventFrame(.welcome(version: 1, tmuxPath: nil)).line(), as: UTF8.self)
    #expect(welcome.contains(#""tmuxPath":null"#))
    let exit = String(decoding: try BrokerEventFrame(.exit(stream: 2, status: nil)).line(), as: UTF8.self)
    #expect(exit.contains(#""status":null"#))
    let decoded = try BrokerEventFrame.decode(Data(#"{"type":"sessions","items":[{"name":"hm-acme-atlas","alive":true,"attached":0,"createdAt":5}]}"#.utf8))
    #expect(decoded.event == .sessions([BrokerSession(name: atlas, project: nil, agent: nil, alive: true, attached: 0, createdAt: 5)]))
  }

  @Test func refusesBadEvents() {
    for json in [
      #"{"type":"sessions","items":[{"name":"acme","alive":true,"attached":0,"createdAt":5}]}"#,
      #"{"type":"output","stream":1,"data":""}"#,
      #"{"type":"attached","stream":1}"#,
      #"{"type":"launched","names":["hm-a"]}"#,
      #"{"type":"welcome"}"#,
      #"{"type":"surprise"}"#,
    ] {
      #expect(eventRefusal(json) != nil, "\(json)")
    }
  }

  @Test func theAccountPreparedAnswerSaysOkExactlyWhenThereIsNoError() throws {
    let ready = try JSONSerialization.jsonObject(
      with: try BrokerEventFrame(id: "p", .accountPrepared(AccountPreparation(loggedIn: true))).line()) as? [String: Any]
    #expect(ready?["type"] as? String == "account.prepared")
    #expect(ready?["ok"] as? Bool == true)
    #expect(ready?["loggedIn"] as? Bool == true)
    #expect(ready?.keys.contains("error") == false, "no error key when ok")
    let failed = try JSONSerialization.jsonObject(
      with: try BrokerEventFrame(.accountPrepared(AccountPreparation(loggedIn: false, error: "Move it away."))).line()) as? [String: Any]
    #expect(failed?["ok"] as? Bool == false)
    #expect(failed?["loggedIn"] as? Bool == false)
    #expect(failed?["error"] as? String == "Move it away.")
    for json in [
      #"{"type":"account.prepared","ok":true,"loggedIn":false,"error":"x"}"#,
      #"{"type":"account.prepared","ok":false,"loggedIn":false}"#,
      #"{"type":"account.prepared","ok":true}"#,
      #"{"type":"account.prepared","ok":"yes","loggedIn":false}"#,
      #"{"type":"account.prepared","ok":false,"loggedIn":false,"error":7}"#,
    ] {
      #expect(eventRefusal(json) != nil, "\(json)")
    }
    let long = try BrokerEventFrame.decode(Data(#"{"type":"account.prepared","ok":false,"loggedIn":false,"error":"\#(String(repeating: "e", count: 1200))"}"#.utf8))
    #expect(long.event == .accountPrepared(AccountPreparation(loggedIn: false, error: String(repeating: "e", count: 1000))))
  }

  @Test func anUnknownErrorCodeStillReadsAsAnError() throws {
    let frame = try BrokerEventFrame.decode(Data(#"{"type":"error","code":"from-the-future","message":"m"}"#.utf8))
    #expect(frame.event == .error(code: .internal, message: "m", stream: nil))
  }
}

struct BrokerLineReaderTests {
  @Test func splitsLinesAcrossReads() throws {
    var reader = BrokerLineReader(limit: 10)
    #expect(try reader.append(Data("ab".utf8)) == [])
    #expect(reader.pendingCount == 2)
    #expect(try reader.append(Data("c\n\nde\nf".utf8)) == [Data("abc".utf8), Data("de".utf8)])
    #expect(try reader.append(Data("\n".utf8)) == [Data("f".utf8)])
    #expect(reader.pendingCount == 0)
  }

  @Test func refusesALineOverTheLimitWithoutBufferingIt() throws {
    var reader = BrokerLineReader(limit: 4)
    #expect(try reader.append(Data("abcd\n".utf8)) == [Data("abcd".utf8)])
    #expect(throws: BrokerProtocolError.self) { try reader.append(Data("abcde".utf8)) }
    #expect(reader.pendingCount == 0)
  }

  @Test func framesWhatTheCodecWrites() throws {
    var reader = BrokerLineReader(limit: BrokerLimits.maxRequestBytes)
    let frames = [BrokerRequestFrame(.sessionsList), BrokerRequestFrame(.input(stream: 1, data: Data("\n\n".utf8)))]
    let bytes = try frames.map { try $0.line() }.reduce(Data(), +)
    let lines = try reader.append(bytes)
    #expect(try lines.map { try BrokerRequestFrame.decode($0) } == frames)
  }
}
