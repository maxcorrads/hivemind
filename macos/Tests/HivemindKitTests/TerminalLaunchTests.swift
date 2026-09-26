import Foundation
import Testing
@testable import HivemindKit

// "Open in Terminal": parsing, script text and the launcher, with a fake
// opener. Scripts are only ever syntax-checked (`zsh -n`), never run, and
// nothing opens Terminal.

@MainActor
final class FakeTerminalOpener: TerminalOpening {
  var opened: [URL] = []
  var failing = false

  func open(script: URL) throws {
    if failing { throw TerminalLaunchError.terminalMissing }
    opened.append(script)
  }
}

private func launch(_ title: String = "Acme - Atlas", cwd: String? = "/Users/me/acme", command: String = "codex 'hi'\n") -> TerminalLaunch {
  TerminalLaunch(title: title, cwd: cwd, command: command)!
}

/// `zsh -n`: parses, runs nothing. True when the text is valid zsh.
private func zshParses(_ script: String) throws -> Bool {
  let file = try temporaryHome().appendingPathComponent("check.zsh")
  try script.write(to: file, atomically: true, encoding: .utf8)
  defer { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
  let process = Process()
  process.executableURL = URL(fileURLWithPath: "/bin/zsh")
  process.arguments = ["-n", "-f", file.path]
  process.standardOutput = FileHandle.nullDevice
  process.standardError = FileHandle.nullDevice
  try process.run()
  process.waitUntilExit()
  return process.terminationStatus == 0
}

/// Reads back one POSIX single-quoted word (only '…' runs and \' between
/// them), the only form shellQuoted produces. Nil for anything else.
private func unquoteSingle(_ word: String) -> String? {
  var out = ""
  var chars = Array(word)[...]
  guard !chars.isEmpty else { return nil }
  while let first = chars.first {
    if first == "'" {
      chars = chars.dropFirst()
      guard let end = chars.firstIndex(of: "'") else { return nil }
      out += String(chars[chars.startIndex..<end])
      chars = chars[(end + 1)...]
    } else if first == "\\", chars.dropFirst().first == "'" {
      out += "'"
      chars = chars.dropFirst(2)
    } else {
      return nil
    }
  }
  return out
}

private let awkwardPaths = [
  "/Users/me/My Projects/acme",
  "/Users/me/it's here",
  "/Users/me/\"double\" and 'single'",
  "/Users/me/line\nbreak",
  "/Users/me/tab\there",
  "/Users/me/$HOME `whoami` $(id) !! *?[a]",
  "/Users/me/ünïcødé/日本語/🐝",
  "/Users/me/back\\slash\\",
  "/Users/me/'''",
  "/-rf",
]

struct TerminalLaunchMessageTests {
  /// Agents only run in tmux now: the page can no longer hand the app a
  /// command to run in a plain Terminal window.
  @Test func refusesTheRemovedLaunchTerminalMessage() {
    let body: [String: Any] = ["type": "launch-terminal", "launches": [["title": "t", "command": "claude"]]]
    #expect(BridgeMessage(body: body) == nil)
  }

  @Test func refusesLaunchesOutsideTheLimits() {
    let bad: [(title: String, cwd: String?, command: String)] = [
      ("t", nil, ""),
      ("t", nil, " \n\t "),
      ("t", nil, "claude\0rm"),
      ("t", nil, String(repeating: "x", count: TerminalLaunch.maxCommandBytes + 1)),
      // 8 KB is bytes, not characters.
      ("t", nil, String(repeating: "é", count: TerminalLaunch.maxCommandBytes / 2 + 1)),
      (String(repeating: "t", count: TerminalLaunch.maxTitleLength + 1), nil, "claude"),
      ("t\0", nil, "claude"),
      ("t", "relative/path", "claude"),
      ("t", "", "claude"),
      ("t", "~other/x", "claude"),
      ("t", "/x\0y", "claude"),
      ("t", "/" + String(repeating: "a", count: TerminalLaunch.maxPathBytes), "claude"),
    ]
    for item in bad {
      #expect(TerminalLaunch(title: item.title, cwd: item.cwd, command: item.command) == nil, "\(item)")
    }
    let command = String(repeating: "x", count: TerminalLaunch.maxCommandBytes)
    let title = String(repeating: "t", count: TerminalLaunch.maxTitleLength)
    #expect(TerminalLaunch(title: title, cwd: nil, command: command) != nil)
  }

  @Test func expandsTheHomeFolderOnly() {
    #expect(launch(cwd: "~").folder(home: "/Users/me") == "/Users/me")
    #expect(launch(cwd: "~/src/a b").folder(home: "/Users/me") == "/Users/me/src/a b")
    #expect(launch(cwd: "~/src").folder(home: "/Users/me/") == "/Users/me/src")
    #expect(launch(cwd: "/opt/~/x").folder(home: "/Users/me") == "/opt/~/x")
    #expect(launch(cwd: nil).folder(home: "/Users/me") == nil)
  }
}

struct TerminalScriptTests {
  @Test func writesTheSelfDeletingLoginShellScript() {
    let script = TerminalScript.contents(for: launch(), home: "/Users/me")
    #expect(script == """
      #!/bin/zsh -l
      rm -f -- "$0"
      printf '\\033]0;%s\\007' 'Acme - Atlas'
      cd -- '/Users/me/acme' || exit 1
      codex 'hi'

      exec "${SHELL:-/bin/zsh}" -l

      """)
  }

  @Test func leavesOutTheCdWithoutAFolderAndExpandsTilde() {
    let bare = TerminalScript.contents(for: launch(cwd: nil, command: "claude"), home: "/Users/me")
    #expect(!bare.contains("cd --"))
    #expect(bare.contains("\nclaude\n\nexec "))
    let home = TerminalScript.contents(for: launch(cwd: "~/My Code", command: "claude"), home: "/Users/me")
    #expect(home.contains("cd -- '/Users/me/My Code' || exit 1\n"))
  }

  @Test func quotesEveryAwkwardFolderSoItReadsBackExactly() throws {
    for path in awkwardPaths {
      let quoted = TerminalScript.shellQuoted(path)
      #expect(unquoteSingle(quoted) == path, "\(path)")
      let script = TerminalScript.contents(for: launch(cwd: path, command: "claude"), home: "/Users/me")
      #expect(script.contains("cd -- \(quoted) || exit 1\n"))
      #expect(try zshParses(script), "\(path)")
    }
  }

  @Test func keepsTheLaunchSheetsMultilineCommandIntact() throws {
    // What LaunchSheet sends: a single-quoted multi-line prompt with quotes,
    // backticks and $ inside, as buildLaunchBlock quotes it.
    let prompt = "You are a Hivemind brain. Don't `explore` $HOME.\nInstalled local tools:\n- a \"b\" (c)"
    let command = "claude --model opus -- " + TerminalScript.shellQuoted(prompt) + "\n"
    let script = TerminalScript.contents(for: launch(command: command), home: "/Users/me")
    #expect(script.contains(command + "\nexec "))
    #expect(try zshParses(script))
  }

  @Test func aTrailingBackslashCannotSwallowTheShellThatKeepsTheWindowOpen() throws {
    let script = TerminalScript.contents(for: launch(command: "echo hi \\"), home: "/Users/me")
    #expect(script.hasSuffix("echo hi \\\n\nexec \"${SHELL:-/bin/zsh}\" -l\n"))
    #expect(try zshParses(script))
  }

  @Test func theTitleIsOneSafeLine() throws {
    #expect(TerminalScript.displayTitle("Acme\n- \u{1B}[31mAtlas\u{7}  ") == "Acme - [31mAtlas")
    #expect(TerminalScript.displayTitle(" \n\t") == "Hivemind")
    #expect(TerminalScript.displayTitle("a\u{202E}b") == "a b")
    let script = TerminalScript.contents(for: launch("It's \"$(id)\"\n%s", cwd: nil), home: "/Users/me")
    #expect(script.contains(#"printf '\033]0;%s\007' 'It'\''s "$(id)" %s'"#))
    #expect(try zshParses(script))
  }

  @Test func fileNamesAreSafeAndShort() {
    #expect(TerminalScript.fileName(for: "Acme - Atlas") == "Acme - Atlas.command")
    #expect(TerminalScript.fileName(for: "../../etc/passwd") == "-..-etc-passwd.command")
    #expect(TerminalScript.fileName(for: "...hidden") == "hidden.command")
    #expect(TerminalScript.fileName(for: "a:b/c") == "a-b-c.command")
    #expect(TerminalScript.fileName(for: "") == "Hivemind.command")
    #expect(TerminalScript.fileName(for: "...") == "Hivemind.command")
    #expect(TerminalScript.fileName(for: "Acme", suffix: 2) == "Acme 2.command")
    #expect(TerminalScript.fileName(for: String(repeating: "x", count: 300)) == String(repeating: "x", count: 80) + ".command")
    #expect(TerminalScript.fileName(for: "Bee 🐝 日本") == "Bee 🐝 日本.command")
  }
}

@MainActor
struct TerminalLauncherTests {
  let root: URL
  let directory: URL
  let opener = FakeTerminalOpener()

  init() throws {
    root = try temporaryHome()
    directory = TerminalLauncher.defaultDirectory(temporary: root)
  }

  func launcher(existing: Set<String> = ["/Users/me/acme"], now: Date = Date()) -> TerminalLauncher {
    TerminalLauncher(directory: directory, home: "/Users/me", opener: opener, folderExists: { existing.contains($0) }, now: { now })
  }

  private func mode(_ url: URL) throws -> Int {
    (try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as? NSNumber)?.intValue ?? -1
  }

  @Test func writesPrivateUniqueScriptsAndOpensEachInOrder() throws {
    let outcomes = launcher().launch([launch(), launch(), launch("Acme - Bea", cwd: nil, command: "claude")])
    let names = opener.opened.map(\.lastPathComponent)
    #expect(names == ["Acme - Atlas.command", "Acme - Atlas 2.command", "Acme - Bea.command"])
    #expect(outcomes == opener.opened.map { .opened($0) })
    #expect(opener.opened.allSatisfy { $0.deletingLastPathComponent().path == directory.path })
    #expect(try mode(directory) == 0o700)
    #expect(try mode(directory.deletingLastPathComponent()) == 0o700)
    for script in opener.opened {
      #expect(try mode(script) == 0o700)
    }
    let first = try String(contentsOf: opener.opened[0], encoding: .utf8)
    #expect(first == TerminalScript.contents(for: launch(), home: "/Users/me"))
  }

  @Test func skipsALaunchWhoseFolderIsMissing() throws {
    let outcomes = launcher().launch([launch(cwd: "~/gone"), launch()])
    #expect(outcomes.first == .missingFolder(title: "Acme - Atlas", folder: "/Users/me/gone"))
    #expect(opener.opened.count == 1)
    let files = try FileManager.default.contentsOfDirectory(atPath: directory.path)
    #expect(files == ["Acme - Atlas.command"])
  }

  @Test func removesTheScriptWhenTerminalCannotBeAsked() throws {
    opener.failing = true
    let outcomes = launcher().launch([launch()])
    #expect(outcomes == [.failed(title: "Acme - Atlas", reason: "Terminal.app was not found")])
    #expect(try FileManager.default.contentsOfDirectory(atPath: directory.path).isEmpty)
  }

  @Test func refusesAFolderThatIsASymlink() throws {
    let elsewhere = root.appendingPathComponent("elsewhere", isDirectory: true)
    try FileManager.default.createDirectory(at: elsewhere, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: directory.deletingLastPathComponent(), withIntermediateDirectories: true)
    try FileManager.default.createSymbolicLink(at: directory, withDestinationURL: elsewhere)
    let outcomes = launcher().launch([launch()])
    guard case .failed(_, let reason) = outcomes.first else {
      Issue.record("expected failure")
      return
    }
    #expect(reason.contains("not a folder"))
    #expect(opener.opened.isEmpty)
    #expect(try FileManager.default.contentsOfDirectory(atPath: elsewhere.path).isEmpty)
  }

  @Test func tightensAnExistingFolderToOwnerOnly() throws {
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o755])
    _ = launcher().launch([launch()])
    #expect(try mode(directory) == 0o700)
  }

  @Test func clearsScriptsTerminalNeverRan() throws {
    let now = Date()
    _ = launcher(now: now).launch([launch("old")])
    let old = directory.appendingPathComponent("old.command")
    try FileManager.default.setAttributes([.modificationDate: now.addingTimeInterval(-2 * TerminalLauncher.staleAge)], ofItemAtPath: old.path)
    _ = launcher(now: now).launch([launch("new")])
    #expect(try FileManager.default.contentsOfDirectory(atPath: directory.path) == ["new.command"])
  }
}

struct TerminalLaunchThrottleTests {
  @Test func allowsOneMessagePerInterval() {
    var throttle = TerminalLaunchThrottle()
    let start = Date()
    // A clock that went backwards does not lock it.
    let answers = [0, 0.5, TerminalLaunchThrottle.interval, -10].map { throttle.allow(at: start.addingTimeInterval($0)) }
    #expect(answers == [true, false, true, true])
  }
}

struct ServerAppURLCommandTests {
  @Test func onlyTheExactStartURLIsACommand() {
    #expect(ServerAppURLCommand.start.url.absoluteString == "hivemind-server://start")
    #expect(ServerAppURLCommand(string: "hivemind-server://start") == .start)
    #expect(ServerAppURLCommand(string: "HIVEMIND-SERVER://START/") == .start)
    for other in ["hivemind-server://stop", "hivemind-server://start?port=1", "hivemind-server://start/x",
                  "hivemind-server://start#x", "hivemind-server://u@start", "hivemind-server://start:80",
                  "http://start", "hivemind://start", "hivemind-server:start", ""] {
      #expect(ServerAppURLCommand(string: other) == nil, "\(other)")
    }
  }
}
