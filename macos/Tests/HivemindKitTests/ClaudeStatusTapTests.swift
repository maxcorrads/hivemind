import Foundation
import Testing
@testable import HivemindKit

// The Claude status-line tap (docs/accounts.md, "Claude status-line tap"): the settings file the broker passes with
// `--settings`, and the tap run from that file's commands with `/bin/sh -c`, as Claude runs a status line or a hook.
// Fake trees under the temp dir only; a fake statusLine command stands in for the account's own, and no `claude` runs.

/// Fixture A of spike 0.2 (#320), trimmed: a status line with both windows.
private let statusInput = #"{"session_id":"00000000-0000-4000-8000-000000000001","cwd":"/Users/test/repo","rate_limits":{"five_hour":{"used_percentage":23.5,"resets_at":1791820800},"seven_day":{"used_percentage":41.2,"resets_at":1792252800}}}"#
/// Fixture E of spike 0.2: a `StopFailure` input.
private let stopFailureInput = #"{"session_id":"abc123","transcript_path":".../projects/.../00893aaf-....jsonl","cwd":"/Users/...","hook_event_name":"StopFailure","error":"rate_limit","error_details":"429 Too Many Requests","last_assistant_message":"API Error: Rate limit reached"}"#

private let shadow = LaunchAccount(id: "0f8fad5b-d9cb-469f-a165-70867728950e", driver: .claude, label: "Claude work",
                                   homePath: "", shadowPath: "~/.claude-work")

/// A fake Mac under a fresh temp folder: a home whose Application Support holds the tap (a path with a space), the
/// account's own folder `~/.claude-work`, a project folder to run in and a TMPDIR.
private struct FakeMac {
  let root: URL
  var home: String { root.appendingPathComponent("home").path }
  var tap: ClaudeStatusTap { ClaudeStatusTap(folder: HivemindPaths(home: URL(fileURLWithPath: home)).accounts) }
  var accountFolder: String { tap.accountFolder(shadow.id)!.path }
  var ownSettings: String { home + "/.claude-work/settings.json" }
  var project: URL { root.appendingPathComponent("project") }
  var temporary: URL { root.appendingPathComponent("tmp") }

  /// The account's own settings.json, the one the tap chains to.
  func own(_ json: String) throws {
    try Data(json.utf8).write(to: URL(fileURLWithPath: ownSettings))
  }

  /// The installed settings file's command at `keys` (["statusLine", "command"]…), as Claude would read it.
  func command(_ keys: [Any]) throws -> String {
    var value: Any = try JSONSerialization.jsonObject(with: Data(contentsOf: tap.accountFolder(shadow.id)!.appendingPathComponent("settings.json")))
    for key in keys {
      if let name = key as? String { value = try #require((value as? [String: Any])?[name]) }
      if let index = key as? Int { value = try #require((value as? [Any])?[index]) }
    }
    return try #require(value as? String)
  }

  var statusLineCommand: String { get throws { try command(["statusLine", "command"]) } }
  var limitErrorCommand: String { get throws { try command(["hooks", "StopFailure", 0, "hooks", 0, "command"]) } }

  /// Runs `command` with `/bin/sh -c` in the project folder with a bare environment (HOME and TMPDIR in the fake Mac),
  /// `input` on stdin. Returns the exit status and stdout.
  func run(_ command: String, input: String) throws -> (status: Int32, output: String) {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/sh")
    process.arguments = ["-c", command]
    process.currentDirectoryURL = project
    process.environment = ["PATH": "/usr/bin:/bin", "HOME": home, "TMPDIR": temporary.path + "/",
                           "CLAUDE_CONFIG_DIR": home + "/.claude-work"]
    let stdin = Pipe(), stdout = Pipe()
    process.standardInput = stdin
    process.standardOutput = stdout
    process.standardError = FileHandle.nullDevice
    try process.run()
    stdin.fileHandleForWriting.write(Data(input.utf8))
    try stdin.fileHandleForWriting.close()
    let output = stdout.fileHandleForReading.readDataToEndOfFile()
    process.waitUntilExit()
    return (process.terminationStatus, String(decoding: output, as: UTF8.self))
  }
}

/// Runs `body` over a fresh fake Mac with the tap installed for `shadow`; the temp folder is removed afterwards.
private func withFakeMac(_ body: (FakeMac) throws -> Void) throws {
  let root = try temporaryHome()
  defer { try? FileManager.default.removeItem(at: root) }
  let mac = FakeMac(root: root)
  for folder in [mac.home + "/.claude-work", mac.project.path, mac.temporary.path] {
    try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
  }
  _ = try mac.tap.install(for: shadow, home: mac.home)
  try body(mac)
}

private func permissions(_ path: String) throws -> Int? {
  try FileManager.default.attributesOfItem(atPath: path)[.posixPermissions] as? Int
}

private func inode(_ path: String) throws -> Int? {
  try FileManager.default.attributesOfItem(atPath: path)[.systemFileNumber] as? Int
}

private func text(_ path: String) -> String? {
  FileManager.default.contents(atPath: path).map { String(decoding: $0, as: UTF8.self) }
}

/// Every file under `root` with its size, modification time and inode, and every folder.
private func snapshot(_ root: URL) throws -> [String: String] {
  var entries: [String: String] = [:]
  let enumerator = try #require(FileManager.default.enumerator(atPath: root.path))
  while let name = enumerator.nextObject() as? String {
    let attributes = try FileManager.default.attributesOfItem(atPath: root.appendingPathComponent(name).path)
    entries[name] = attributes[.type] as? FileAttributeType == .typeDirectory ? "folder"
      : "\(attributes[.size] ?? "") \(attributes[.modificationDate] ?? "") \(attributes[.systemFileNumber] ?? "")"
  }
  return entries
}

struct ClaudeStatusTapTests {
  @Test func theSettingsFileRunsTheTapForTheStatusLineAndARateLimitStopFailure() throws {
    try withFakeMac { mac in
      let tap = mac.tap
      let script = TerminalScript.shellQuoted(tap.script.path)
      let folder = TerminalScript.shellQuoted(mac.accountFolder)
      #expect(tap.script.path.contains("Application Support"), "every path is quoted for the shell")
      let settings = try #require(FileManager.default.contents(atPath: mac.accountFolder + "/settings.json"))
      let json = try #require(try JSONSerialization.jsonObject(with: settings) as? NSDictionary)
      let expected: NSDictionary = [
        "statusLine": ["type": "command", "command": "/bin/sh \(script) status \(folder) \(TerminalScript.shellQuoted(mac.ownSettings))"],
        "hooks": ["StopFailure": [["matcher": "rate_limit", "hooks": [["type": "command", "command": "/bin/sh \(script) limit-error \(folder)"]]]]],
      ]
      #expect(json == expected)
      #expect(FileManager.default.contents(atPath: tap.script.path) == Data(ClaudeStatusTap.scriptText.utf8))
      #expect(try permissions(mac.accountFolder + "/settings.json") == 0o600)
      #expect(try permissions(tap.script.path) == 0o600)
      #expect(try permissions(mac.accountFolder) == 0o700)
      #expect(try permissions(tap.folder.path) == 0o700)

      // A second install writes the same bytes.
      #expect(try tap.install(for: shadow, home: mac.home) == mac.accountFolder + "/settings.json")
      #expect(FileManager.default.contents(atPath: mac.accountFolder + "/settings.json") == settings)
    }
  }

  @Test(arguments: [
    (LaunchAccount(id: "a3", driver: .claude, label: "Claude", homePath: "", shadowPath: ""), "/Users/tester/.claude/settings.json"),
    (LaunchAccount(id: "a2", driver: .claude, label: "Claude team", homePath: "~/.claude-team", shadowPath: ""), "/Users/tester/.claude-team/settings.json"),
    (LaunchAccount(id: "a4", driver: .claude, label: "Claude work", homePath: "/Volumes/x/claude", shadowPath: "/Volumes/x/work"), "/Volumes/x/work/settings.json"),
  ])
  func theTapChainsToTheSettingsOfTheFolderTheAccountLogsInTo(account: LaunchAccount, own: String) throws {
    let tap = ClaudeStatusTap(folder: URL(fileURLWithPath: "/Users/tester/Library/Application Support/Hivemind/accounts"))
    let settings = try #require(tap.settings(for: account, home: "/Users/tester"))
    let json = try #require(try JSONSerialization.jsonObject(with: settings) as? [String: Any])
    let command = try #require((json["statusLine"] as? [String: Any])?["command"] as? String)
    #expect(command.hasSuffix(" status '/Users/tester/Library/Application Support/Hivemind/accounts/\(account.id)' '\(own)'"))
  }

  @Test(arguments: ["", ".", "..", "../escape", "a/b", "a b", "é", String(repeating: "a", count: 65)])
  func anIdThatIsNotAPlainFileNameGetsNoTapAndWritesNothing(id: String) throws {
    let root = try temporaryHome()
    defer { try? FileManager.default.removeItem(at: root) }
    let tap = ClaudeStatusTap(folder: root.appendingPathComponent("accounts"))
    let account = LaunchAccount(id: id, driver: .claude, label: "Claude odd", homePath: "", shadowPath: "")
    #expect(tap.accountFolder(id) == nil)
    #expect(tap.statusLineFile(id) == nil && tap.limitErrorFile(id) == nil)
    #expect(tap.settings(for: account, home: root.path) == nil)
    #expect(throws: BrokerFiles.Failure("The id of the account Claude odd cannot name a folder")) {
      try tap.install(for: account, home: root.path)
    }
    #expect(try FileManager.default.contentsOfDirectory(atPath: root.path).isEmpty)
  }

  @Test func aCodexAccountHasNoTap() throws {
    let root = try temporaryHome()
    defer { try? FileManager.default.removeItem(at: root) }
    let tap = ClaudeStatusTap(folder: root.appendingPathComponent("accounts"))
    let codex = LaunchAccount(id: "a1", driver: .codex, label: "Codex", homePath: "", shadowPath: "")
    #expect(throws: BrokerFiles.Failure("Only a Claude account has a status-line tap")) { try tap.install(for: codex, home: root.path) }
    #expect(try FileManager.default.contentsOfDirectory(atPath: root.path).isEmpty)
  }

  @Test func theStatusLineIsSavedThenTheAccountsOwnCommandRunsOnTheSameInputAndItsOutputIsPrinted() throws {
    try withFakeMac { mac in
      // Only statusLine.command is read: the token in `env` never reaches the output.
      try mac.own(#"{"env":{"ANTHROPIC_API_KEY":"sk-ant-FAKE-own-settings"},"statusLine":{"type":"command","command":"printf 'own %s|' \"$(/bin/pwd -P)\"; /bin/cat","padding":0}}"#)
      let result = try mac.run(try mac.statusLineCommand, input: statusInput)
      #expect(result.status == 0)
      let folder = try #require(realpath(mac.project.path, nil))
      defer { free(folder) }
      #expect(result.output == "own \(String(cString: folder))|\(statusInput)\n", "the same input, in Claude's folder")
      #expect(!result.output.contains("sk-ant-FAKE"))
      let statusLine = try #require(mac.tap.statusLineFile(shadow.id))
      #expect(text(statusLine.path) == statusInput + "\n")
      #expect(try permissions(mac.accountFolder + "/statusline.json") == 0o600)

      // The chained command runs with Claude's umask, not one of the tap's.
      try mac.own(#"{"statusLine":{"type":"command","command":"/bin/cat > /dev/null; umask"}}"#)
      #expect(try mac.run("umask 027; " + mac.statusLineCommand, input: statusInput) == (0, "0027\n"))
      #expect(try permissions(mac.accountFolder + "/statusline.json") == 0o600)

      // The chained command's exit status is the tap's.
      try mac.own(#"{"statusLine":{"type":"command","command":"/bin/cat > /dev/null; printf down; exit 3"}}"#)
      #expect(try mac.run(try mac.statusLineCommand, input: statusInput) == (3, "down"))
    }
  }

  @Test(arguments: [
    nil, "{}", #"{"statusLine":{"type":"command"}}"#, #"{"statusLine":{"type":"command","command":{"a":1}}}"#, "not json",
  ])
  func withNoCommandOfItsOwnTheTapPrintsNothingAndStillSavesTheInput(own: String?) throws {
    try withFakeMac { mac in
      if let own { try mac.own(own) }
      #expect(try mac.run(try mac.statusLineCommand, input: statusInput) == (0, ""))
      #expect(text(mac.accountFolder + "/statusline.json") == statusInput + "\n")
    }
  }

  @Test func everyWriteReplacesItsFileThroughARenameInTheAccountFolder() throws {
    try withFakeMac { mac in
      let statusLine = mac.accountFolder + "/statusline.json"
      _ = try mac.run(try mac.statusLineCommand, input: statusInput)
      let reader = try #require(FileHandle(forReadingAtPath: statusLine))
      defer { try? reader.close() }
      let before = try inode(statusLine)
      let next = statusInput.replacingOccurrences(of: "23.5", with: "24.0")
      _ = try mac.run(try mac.statusLineCommand, input: next)
      // A reader of the old file still reads it whole: the new one replaced it, nothing was written into it.
      #expect(String(decoding: reader.readDataToEndOfFile(), as: UTF8.self) == statusInput + "\n")
      #expect(text(statusLine) == next + "\n")
      #expect(try inode(statusLine) != before)

      let limitError = mac.accountFolder + "/limit-error"
      _ = try mac.run(try mac.limitErrorCommand, input: stopFailureInput)
      let first = try inode(limitError)
      _ = try mac.run(try mac.limitErrorCommand, input: stopFailureInput)
      #expect(try inode(limitError) != first)
      // No temporary file is left behind.
      #expect(try FileManager.default.contentsOfDirectory(atPath: mac.accountFolder).sorted() == ["limit-error", "settings.json", "statusline.json"])
    }
  }

  @Test func aRateLimitStopFailureWritesTheTimeAndNothingOfItsInput() throws {
    try withFakeMac { mac in
      let before = Int(Date().timeIntervalSince1970)
      #expect(try mac.run(try mac.limitErrorCommand, input: stopFailureInput) == (0, ""))
      let after = Int(Date().timeIntervalSince1970)
      let file = try #require(mac.tap.limitErrorFile(shadow.id))
      let written = try #require(text(file.path))
      #expect(written.hasSuffix("\n"))
      let seconds = try #require(Int(written.trimmingCharacters(in: .newlines)))
      #expect((before...after).contains(seconds))
      #expect(try permissions(mac.accountFolder + "/limit-error") == 0o600)
    }
  }

  @Test func theTapWritesNothingOutsideItsAccountFolder() throws {
    try withFakeMac { mac in
      try mac.own(#"{"statusLine":{"type":"command","command":"/bin/cat > /dev/null; printf own"}}"#)
      let (status, limitError) = (try mac.statusLineCommand, try mac.limitErrorCommand)
      let before = try snapshot(mac.root)
      #expect(try mac.run(status, input: statusInput) == (0, "own"))
      _ = try mac.run(limitError, input: stopFailureInput)
      var after = try snapshot(mac.root)
      let account = "home/Library/Application Support/Hivemind/accounts/\(shadow.id)"
      #expect(after.removeValue(forKey: account + "/statusline.json") != nil)
      #expect(after.removeValue(forKey: account + "/limit-error") != nil)
      #expect(after == before)

      // With no account folder, nothing is written at all, and the account's own status line still shows.
      try FileManager.default.removeItem(atPath: mac.accountFolder)
      let missing = try snapshot(mac.root)
      #expect(try mac.run(status, input: statusInput) == (0, "own"))
      #expect(try mac.run(limitError, input: stopFailureInput) == (0, ""))
      #expect(try snapshot(mac.root) == missing)
    }
  }
}
