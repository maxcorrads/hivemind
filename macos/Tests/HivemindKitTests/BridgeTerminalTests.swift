import Foundation
import Testing
@testable import HivemindKit

// The page ↔ app terminal messages (web/native-bridge.ts on the other side).

private let atlas = SessionName("hm-acme-atlas")!

private func launchItem(_ extra: [String: Any] = [:]) -> [String: Any] {
  ["project": "acme", "agent": "Atlas", "title": "Acme - Atlas", "cwd": "~/acme", "command": "claude\n"].merging(extra) { $1 }
}

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
    let error = try detail(.error(id: "a", code: .noSuchSession, message: "</script>\u{2028}", stream: nil))
    #expect(error["message"] as? String == "</script>\u{2028}")
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
