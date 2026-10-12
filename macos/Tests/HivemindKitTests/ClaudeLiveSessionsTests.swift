import Foundation
import Testing
@testable import HivemindKit

// The Claude live-session check (docs/accounts.md, "Live sessions") over fake config directories under the temp dir.
// A live record names this test process, whose pid answers signal 0; the injected process-start reader says when it
// started, so a record with another start is a reused pid.

private let session = "5c2b1a09-8f7e-4d6c-9b5a-4e3d2c1b0a99"
private let me = getpid()
/// As `ps` prints it, with the day padded; the reader below gives it squeezed.
private let started = "Mon Oct  5 14:03:07 2026"

/// A process-start reader for which this process started at `start`, and no other process exists.
private func reader(_ start: String = "Mon Oct 5 14:03:07 2026") -> (Int32) -> String? {
  { $0 == me ? start : nil }
}

/// Writes `<directory>/sessions/<name>` (`<pid>.json` by default) with Claude's keys.
private func writeRecord(in directory: String, name: String? = nil, pid: Int32 = me, sessionId: String = session,
                         cwd: String = "/Users/me/acme", pidDomain: String? = "darwin", procStart: String? = started) throws {
  var object: [String: Any] = ["pid": Int(pid), "sessionId": sessionId, "cwd": cwd, "kind": "interactive", "status": "busy"]
  if let pidDomain { object["pidDomain"] = pidDomain }
  if let procStart { object["procStart"] = procStart }
  let folder = directory + "/sessions"
  try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
  try JSONSerialization.data(withJSONObject: object).write(to: URL(fileURLWithPath: folder + "/" + (name ?? "\(pid).json")))
}

/// Runs `body` with a fresh fake home at its real path, its shared tree `<root>/.claude` and a shadow
/// `<root>/.claude-personal` (neither created); the temp folder is removed afterwards.
private func withTrees(_ body: (String, ClaudeLiveSessions.Directory, ClaudeLiveSessions.Directory) throws -> Void) throws {
  let root = try temporaryHome().resolvingSymlinksInPath()
  defer { try? FileManager.default.removeItem(at: root) }
  try body(root.path, .init(path: root.path + "/.claude", label: "Claude"), .init(path: root.path + "/.claude-personal", label: "Claude personal"))
}

struct ClaudeLiveSessionsTests {
  @Test func aSessionLiveUnderAnotherAccountIsHeld() throws {
    try withTrees { _, shared, shadow in
      try writeRecord(in: shadow.path)
      let holder = try ClaudeLiveSessions(processStart: reader()).holder(of: .session(session), cwd: "/x", in: [shared, shadow])
      #expect(holder == ClaudeLiveSessions.Holder(sessionID: session, label: "Claude personal"))
    }
  }

  @Test func aRecordIsLiveOnlyForTheMacProcessThatWroteIt() throws {
    try withTrees { _, shared, _ in
      let check = ClaudeLiveSessions(processStart: reader())
      func held() throws -> Bool { try check.holder(of: .session(session), cwd: "/x", in: [shared]) != nil }
      try writeRecord(in: shared.path)
      #expect(try held())
      try writeRecord(in: shared.path, pidDomain: "darwin:host")
      #expect(try !held())
      try writeRecord(in: shared.path, pidDomain: nil)
      #expect(try !held())
      try writeRecord(in: shared.path, procStart: "Tue Oct 6 09:00:00 2026")
      #expect(try !held(), "a reused pid")
      try writeRecord(in: shared.path, procStart: nil)
      #expect(try !held())
      try writeRecord(in: shared.path, name: "\(me).json", pid: 2_000_000_000)
      #expect(try !held(), "no such process")
      for pid: Int32 in [0, 1, -1] {
        try writeRecord(in: shared.path, name: "\(me).json", pid: pid)
        #expect(try !held(), "pid \(pid)")
      }
      try writeRecord(in: shared.path)
      #expect(try ClaudeLiveSessions(processStart: { _ in nil }).holder(of: .session(session), cwd: "/x", in: [shared]) == nil)
    }
  }

  @Test func anotherSessionIsNotHeld() throws {
    try withTrees { _, shared, shadow in
      try writeRecord(in: shadow.path, sessionId: "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0")
      #expect(try ClaudeLiveSessions(processStart: reader()).holder(of: .session(session), cwd: "/x", in: [shared, shadow]) == nil)
    }
  }

  @Test func continueIsHeldByALiveSessionInTheSameFolderByRealpath() throws {
    try withTrees { root, shared, shadow in
      let acme = root + "/acme", beta = root + "/beta"
      for folder in [acme, beta] { try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true) }
      try FileManager.default.createSymbolicLink(atPath: root + "/link", withDestinationPath: acme)
      try writeRecord(in: shared.path, cwd: root + "/link")
      let check = ClaudeLiveSessions(processStart: reader())
      #expect(try check.holder(of: .latest, cwd: acme, in: [shadow, shared]) == ClaudeLiveSessions.Holder(sessionID: session, label: "Claude"))
      #expect(try check.holder(of: .latest, cwd: beta, in: [shadow, shared]) == nil)
    }
  }

  @Test func onlyNumberedJSONRecordsAreRead() throws {
    try withTrees { _, shared, _ in
      // Each holds a live record; none is a `<pid>.json`, so none is opened as one.
      for name in ["\(me).0123456789abcdef.key", "abc.json", "\(me).json.tmp", ".\(me).json"] {
        try writeRecord(in: shared.path, name: name)
      }
      #expect(try ClaudeLiveSessions(processStart: reader()).holder(of: .session(session), cwd: "/x", in: [shared]) == nil)
    }
  }

  @Test func aRecordThatDoesNotParseIsSkipped() throws {
    try withTrees { _, shared, _ in
      try writeRecord(in: shared.path)
      try Data("{\"pid\":".utf8).write(to: URL(fileURLWithPath: shared.path + "/sessions/12.json"))
      try Data("[1]".utf8).write(to: URL(fileURLWithPath: shared.path + "/sessions/13.json"))
      try writeRecord(in: shared.path, name: "14.json", sessionId: session + "-other")
      #expect(try ClaudeLiveSessions(processStart: reader()).holder(of: .session(session), cwd: "/x", in: [shared])?.label == "Claude")
    }
  }

  @Test func missingDirectoriesHoldNothing() throws {
    try withTrees { _, shared, shadow in
      let check = ClaudeLiveSessions(processStart: reader())
      #expect(try check.holder(of: .session(session), cwd: "/x", in: [shared, shadow]) == nil)
      try FileManager.default.createDirectory(atPath: shared.path, withIntermediateDirectories: true)
      #expect(try check.holder(of: .latest, cwd: "/Users/me/acme", in: [shared, shadow]) == nil)
    }
  }

  @Test func anUnreadableSessionsFolderRefusesTheLaunch() throws {
    try withTrees { _, shared, shadow in
      try writeRecord(in: shadow.path)
      let folder = shadow.path + "/sessions"
      try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: folder)
      defer { try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: folder) }
      #expect(throws: BrokerProtocolError(.internal, "Cannot check `\(folder)`: Permission denied")) {
        try ClaudeLiveSessions(processStart: reader()).holder(of: .session(session), cwd: "/x", in: [shared, shadow])
      }
    }
  }

  @Test func resumeAndContinueFlagsOfAClaudeCommandAreChecked() {
    #expect(ClaudeLiveSessions.resumed(in: "claude --resume \(session)") == .session(session))
    #expect(ClaudeLiveSessions.resumed(in: "claude -r \(session)") == .session(session))
    #expect(ClaudeLiveSessions.resumed(in: "claude --resume=\(session)") == .session(session))
    #expect(ClaudeLiveSessions.resumed(in: "claude --resume \"\(session)\"") == .session(session))
    #expect(ClaudeLiveSessions.resumed(in: "claude --continue") == .latest)
    #expect(ClaudeLiveSessions.resumed(in: "claude -c") == .latest)
    #expect(ClaudeLiveSessions.resumed(in: "cd '/x y' && /opt/homebrew/bin/claude --model opus -r \(session)") == .session(session))
    #expect(ClaudeLiveSessions.resumed(
      in: "HIVEMIND_ROLE='worker' claude --model opus -c --mcp-config '{\"a\":\"b c\"}' -- 'You are -c --resume x'") == .latest)
  }

  @Test func newSessionsPickersForksAndOtherCommandsAreNotChecked() {
    for command in [
      "claude", "claude --model opus", "claude --resume", "claude --resume --model opus", "claude -r",
      "claude -- '--resume \(session)'", "claude 'say -c, then --continue'", "claude -- -c",
      "claude --resume \(session) --fork-session", "claude --fork-session -c",
      "codex resume \(session)", "claude-work -c", "echo -c; claude", "claude; ls -c", "claude | grep -c x",
      "zsh -c 'claude'",
    ] {
      #expect(ClaudeLiveSessions.resumed(in: command) == nil, "\(command)")
    }
  }

  @Test func theDirectoriesAreTheLaunchsSharedTreeAndItsShadows() {
    func claude(_ label: String, home: String = "", shadow: String = "") -> LaunchAccount {
      LaunchAccount(id: label, driver: .claude, label: label, homePath: home, shadowPath: shadow)
    }
    let primary = claude("Claude"), personal = claude("Personal", shadow: "~/.claude-personal")
    let work = claude("Work", home: "~/.claude-work"), workShadow = claude("Work 2", home: "/Users/a/.claude-work", shadow: "/Users/a/.claude-w2")
    let codex = LaunchAccount(id: "c", driver: .codex, label: "Codex", homePath: "", shadowPath: "~/.codex-2")
    typealias Directory = ClaudeLiveSessions.Directory
    #expect(ClaudeLiveSessions.directories(for: nil, known: [], home: "/Users/a") == [Directory(path: "/Users/a/.claude", label: "/Users/a/.claude")])
    let known = [personal, work, workShadow, codex, primary]
    let main = [Directory(path: "/Users/a/.claude", label: "Claude"), Directory(path: "/Users/a/.claude-personal", label: "Personal")]
    #expect(ClaudeLiveSessions.directories(for: nil, known: known, home: "/Users/a") == main)
    #expect(ClaudeLiveSessions.directories(for: codex, known: known, home: "/Users/a") == main)
    #expect(ClaudeLiveSessions.directories(for: personal, known: [], home: "/Users/a/")
      == [Directory(path: "/Users/a/.claude", label: "/Users/a/.claude"), Directory(path: "/Users/a/.claude-personal", label: "Personal")])
    #expect(ClaudeLiveSessions.directories(for: claude("Explicit", home: "/Users/a/.claude"), known: known, home: "/Users/a")
      == [Directory(path: "/Users/a/.claude", label: "Explicit"), Directory(path: "/Users/a/.claude-personal", label: "Personal")])
    #expect(ClaudeLiveSessions.directories(for: workShadow, known: known, home: "/Users/a")
      == [Directory(path: "/Users/a/.claude-work", label: "Work"), Directory(path: "/Users/a/.claude-w2", label: "Work 2")])
  }

  @Test func theKernelsStartTimeIsWhatPsPrints() throws {
    let ps = Process()
    ps.executableURL = URL(fileURLWithPath: "/bin/ps")
    ps.arguments = ["-o", "lstart=", "-p", "\(me)"]
    ps.environment = ["TZ": "UTC", "LC_ALL": "C"]
    let output = Pipe()
    ps.standardOutput = output
    try ps.run()
    let printed = String(decoding: output.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    ps.waitUntilExit()
    #expect(ClaudeLiveSessions.systemProcessStart(me) == printed.split(whereSeparator: \.isWhitespace).joined(separator: " "))
    #expect(ClaudeLiveSessions.systemProcessStart(2_000_000_000) == nil)
  }
}

/// The broker's side: an item that resumes a live Claude session fails before any of it runs, and the other items start.
@MainActor
struct ClaudeLiveSessionsBrokerTests {
  /// A broker whose Mac home is a fake under the temp dir, at its real path, where this process started at `started`.
  func harness() throws -> (BrokerHarness, root: URL) {
    let root = try temporaryHome().resolvingSymlinksInPath()
    let h = BrokerHarness()
    h.home = root.path
    h.processStart = reader()
    h.shadowHomes = FakeShadowHomes()
    return (h, root)
  }

  let personal = LaunchAccount(id: "a1", driver: .claude, label: "Claude personal", homePath: "", shadowPath: "~/.claude-personal")
  let primary = LaunchAccount(id: "a2", driver: .claude, label: "Claude", homePath: "", shadowPath: "")
  let second = SessionName("hm-acme-new-1")!

  func refusal(_ label: String) -> BrokerLaunchFailure {
    BrokerLaunchFailure(index: 0, code: .internal,
                        message: "launches[0].command: Claude session `\(session)` is already open in another process (account `\(label)`).")
  }

  @Test func resumingASessionLiveUnderAPreparedShadowFailsOnlyItsItem() async throws {
    let (h, root) = try harness()
    defer { try? FileManager.default.removeItem(at: root) }
    try writeRecord(in: root.path + "/.claude-personal")
    await h.start()
    let (transport, connection) = await h.client()
    await h.send(connection, .accountPrepare(account: personal), id: "prepare")
    _ = transport.take()
    let resume = try BrokerLaunch(project: "acme", agent: "Atlas", title: "Acme - Atlas", cwd: "/Users/me/acme",
                                  command: "claude --resume \(session)", account: primary)
    await h.send(connection, .launch([resume, brokerLaunch(nil)]))
    #expect(transport.events().first == .launched(names: [nil, second], created: [second], errors: [refusal("Claude personal")]))
    #expect(h.tmux.calls("new-session").count == 1)
  }

  @Test func withoutAnAccountAResumeOfALiveSessionRunsAsBefore() async throws {
    let (h, root) = try harness()
    defer { try? FileManager.default.removeItem(at: root) }
    try writeRecord(in: root.path + "/.claude")
    await h.start()
    let (transport, connection) = await h.client()
    await h.send(connection, .launch([brokerLaunch("Atlas", command: "claude --resume \(session)")]))
    let atlas = SessionName("hm-acme-atlas")!
    #expect(transport.events().first == .launched(names: [atlas], created: [atlas], errors: []), "no account, no check: Claude decides")
  }

  @Test func aShadowsLaunchSeesTheSharedTreesSessionsAndNothingOfItRuns() async throws {
    let (h, root) = try harness()
    defer { try? FileManager.default.removeItem(at: root) }
    try writeRecord(in: root.path + "/.claude")
    await h.start()
    let (transport, connection) = await h.client()
    await h.send(connection, .accountPrepare(account: primary), id: "prepare")
    _ = transport.take()
    let launch = try BrokerLaunch(project: "acme", agent: "Atlas", title: "Acme - Atlas", cwd: "/Users/me/acme",
                                  command: "claude -r \(session)", account: personal)
    await h.send(connection, .launch([launch]))
    #expect(transport.events().first == .launched(names: [nil], created: [], errors: [refusal("Claude")]))
    #expect(h.tmux.calls("new-session").isEmpty)
  }

  @Test func continuingInTheFolderOfALiveSessionFailsAndANewSessionThereStarts() async throws {
    let (h, root) = try harness()
    defer { try? FileManager.default.removeItem(at: root) }
    try writeRecord(in: root.path + "/.claude", cwd: "/Users/me/acme")
    await h.start()
    let (transport, connection) = await h.client()
    let resume = try BrokerLaunch(project: "acme", agent: "Atlas", title: "Acme - Atlas", cwd: "/Users/me/acme",
                                  command: "claude --continue", account: primary)
    await h.send(connection, .launch([resume, brokerLaunch(nil, command: "claude")]))
    #expect(transport.events().first == .launched(names: [nil, second], created: [second], errors: [refusal("Claude")]))
  }

  @Test func resumingASessionWhoseProcessIsGoneStarts() async throws {
    let (h, root) = try harness()
    defer { try? FileManager.default.removeItem(at: root) }
    try writeRecord(in: root.path + "/.claude", procStart: "Tue Oct  6 09:00:00 2026")
    await h.start()
    let (transport, connection) = await h.client()
    await h.send(connection, .launch([brokerLaunch("Atlas", command: "claude --resume \(session)")]))
    let atlas = SessionName("hm-acme-atlas")!
    #expect(transport.events().first == .launched(names: [atlas], created: [atlas], errors: []))
  }
}
