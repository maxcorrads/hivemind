import Foundation
import Testing
@testable import HivemindKit

// tmux argv, list-sessions parsing, config, locator, paths and token. Pure:
// nothing here runs tmux, a shell or a PTY.

private let tmux = TmuxCommand(executable: "/opt/homebrew/bin/tmux", configPath: "/Users/me/Library/Application Support/Hivemind/tmux.conf")
private let base = ["-u", "-L", "hivemind", "-f", "/Users/me/Library/Application Support/Hivemind/tmux.conf"]
private let atlas = SessionName("hm-acme-atlas")!

private func spec(agent: String? = "Atlas", title: String = "Acme - Atlas", cwd: String = "/Users/me/My Acme",
                  command: String = "claude --model opus\n") throws -> TmuxNewSession {
  let launch = try BrokerLaunch(project: "acme", agent: agent, title: title, cwd: cwd, command: command)
  return TmuxNewSession(name: BrokerLaunch.sessionNames(for: [launch], existing: []).first!, launch: launch)
}

struct TmuxCommandTests {
  @Test func everyCallGoesToHivemindsOwnServer() {
    #expect(tmux.hasSession(atlas) == base + ["has-session", "-t", "=hm-acme-atlas"])
    #expect(tmux.killSession(atlas) == base + ["kill-session", "-t", "=hm-acme-atlas"])
    #expect(tmux.attach(atlas) == base + ["attach-session", "-t", "=hm-acme-atlas"])
    #expect(tmux.listSessions() == base + ["list-sessions", "-F",
      "#{session_name}|#{session_created}|#{session_attached}|#{pane_dead}|#{@hivemind_project}|#{@hivemind_agent}"])
  }

  @Test func startsADetachedLoginShellWithItsSessionNameInTheEnvironment() throws {
    #expect(tmux.newSession(try spec()) == base + [
      "new-session", "-d", "-s", "hm-acme-atlas", "-n", "Acme - Atlas",
      "-e", "HIVEMIND_TMUX_SESSION=hm-acme-atlas",
      "--", "/bin/zsh", "-lc", "cd -- '/Users/me/My Acme' || exit 1\nclaude --model opus\n\nexec /bin/zsh -l",
      ";", "set-option", "-t", "=hm-acme-atlas", "@hivemind_project", "acme",
      ";", "set-option", "-t", "=hm-acme-atlas", "@hivemind_agent", "Atlas",
    ])
    let fresh = tmux.newSession(try spec(agent: nil))
    #expect(fresh.contains("hm-acme-new-1"))
    #expect(!fresh.contains("@hivemind_agent"))
  }

  @Test func noValueCanEndATmuxCommandOrExpandAFormat() throws {
    let arguments = tmux.newSession(try spec(agent: "Evil;", title: "#(touch /tmp/x) #{pane_pid};", cwd: "/tmp/#(id);",
                                             command: "claude; rm -rf ~ #"))
    // The only arguments ending in ";" are the separators themselves.
    #expect(arguments.filter { $0.hasSuffix(";") && $0 != ";" }.allSatisfy { $0.hasSuffix("\\;") })
    #expect(arguments.filter { $0 == ";" }.count == 2)
    // The folder is never a tmux argument of its own (-c expands formats).
    #expect(!arguments.contains("-c"))
    #expect(!arguments.contains { $0.contains("#(") && !$0.hasPrefix("cd -- ") })
    let name = arguments[arguments.firstIndex(of: "-n")! + 1]
    #expect(!name.contains("#"))
    #expect(arguments.last == "Evil\\;")
    #expect(TmuxCommand.argument("a;") == "a\\;")
    #expect(TmuxCommand.argument("a\\;") == "a\\\\;")
    #expect(TmuxCommand.argument("a") == "a")
    #expect(TmuxCommand.argument(";") == "\\;")
  }

  @Test func theLargestValidLaunchFitsInOneTmuxCommand() throws {
    #expect(TmuxCommand.commandLineBytes(["ab", "é"]) == 3 + 3)
    // Every field at its limit, in the widest encoding: 4-byte characters
    // and a folder of quotes, each of which single-quoting makes 4 bytes.
    let wide = "😀"
    let launch = try BrokerLaunch(
      project: String(repeating: "p", count: 32), agent: String(repeating: wide, count: BrokerLimits.maxAgentCharacters),
      title: String(repeating: wide, count: BrokerLimits.maxTitleCharacters),
      cwd: "/" + String(repeating: "'", count: BrokerLimits.maxCwdBytes - 1),
      command: String(repeating: "x", count: BrokerLimits.maxCommandBytes))
    let name = BrokerLaunch.sessionNames(for: [launch], existing: []).first!
    // A config path as long as the broker socket's limit allows.
    let longest = TmuxCommand(executable: "/opt/homebrew/bin/tmux", configPath: "/" + String(repeating: "c", count: BrokerPaths.maxSocketPathBytes))
    let bytes = TmuxCommand.commandLineBytes(longest.newSession(TmuxNewSession(name: name, launch: launch)))
    #expect(bytes <= TmuxCommand.maxCommandLineBytes, "\(bytes)")
    #expect(TmuxCommand.maxCommandLineBytes < 16 * 1024, "below tmux's own message limit")
  }

  @Test func theScriptCdsQuotedAndStaysOpen() throws {
    #expect(TmuxCommand.script(cwd: "/Users/me/it's", command: "echo hi \\\n\n") == "cd -- '/Users/me/it'\\''s' || exit 1\necho hi \\\n\nexec /bin/zsh -l")
  }

  @Test func windowNamesAreOneShortLine() {
    #expect(TmuxCommand.windowName("Acme\n- \u{1B}[31mAtlas") == "Acme - [31mAtlas")
    #expect(TmuxCommand.windowName(String(repeating: "x", count: 100)).count == 60)
    #expect(TmuxCommand.windowName("#{a}") == "{a}")
  }

  @Test func terminalAppAttachesWithAQuotedExecLine() {
    let spaced = TmuxCommand(executable: "/opt/home brew/tmux", configPath: "/a b/tmux.conf")
    #expect(spaced.attachShellLine(atlas)
      == "exec '/opt/home brew/tmux' '-u' '-L' 'hivemind' '-f' '/a b/tmux.conf' 'attach-session' '-t' '=hm-acme-atlas'")
  }

  @Test func parsesListSessions() {
    let output = """
      hm-acme-atlas|1790000000|1|0|acme|Atlas
      hm-acme-new-1|1790000001|0|1|acme|
      hm-beta-bea|1790000002|2|0|beta|Bea|with|pipes
      scratch|1790000003|0|0||
      hm-bad|x|0|0||
      hm-short|1
      hm-a|1|0|0|NotASlug|

      """
    let sessions = TmuxCommand.parseSessions(output)
    #expect(sessions == [
      BrokerSession(name: SessionName("hm-a")!, project: nil, agent: nil, alive: true, attached: 0, createdAt: 1000),
      BrokerSession(name: atlas, project: "acme", agent: "Atlas", alive: true, attached: 1, createdAt: 1_790_000_000_000),
      BrokerSession(name: SessionName("hm-acme-new-1")!, project: "acme", agent: nil, alive: false, attached: 0, createdAt: 1_790_000_001_000),
      BrokerSession(name: SessionName("hm-beta-bea")!, project: "beta", agent: "Bea|with|pipes", alive: true, attached: 2, createdAt: 1_790_000_002_000),
    ])
    #expect(TmuxCommand.parseSessions("") == [])
  }

  @Test func noServerIsAnEmptyList() {
    #expect(TmuxCommand.isNoServer(stderr: "no server running on /private/tmp/tmux-501/hivemind\n"))
    #expect(TmuxCommand.isNoServer(stderr: "error connecting to /private/tmp/tmux-501/hivemind (No such file or directory)"))
    #expect(!TmuxCommand.isNoServer(stderr: "can't find session: hm-x"))
  }

  @Test func theConfigIsHivemindsOwn() {
    let config = TmuxCommand.configText
    for line in ["set -g window-size latest", "set -g history-limit 50000", "set -g mouse on", "set -g status off",
                 #"set -g default-terminal "tmux-256color""#] {
      #expect(config.contains(line + "\n"), "\(line)")
    }
    #expect(config.hasSuffix("\n"))
    #expect(!config.contains("run-shell"))
  }
}

struct TmuxLocatorTests {
  @Test func prefersHomebrewThenPath() {
    let everywhere = TmuxLocator(path: "/usr/bin:/custom/bin/", isExecutable: { _ in true })
    #expect(everywhere.searchPaths == ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux", "/custom/bin/tmux"])
    #expect(everywhere.locate() == "/opt/homebrew/bin/tmux")
    #expect(TmuxLocator(path: nil, isExecutable: { $0 == "/usr/local/bin/tmux" }).locate() == "/usr/local/bin/tmux")
    #expect(TmuxLocator(path: "/x:/opt/homebrew/bin:bin:.", isExecutable: { $0 == "/x/tmux" }).searchPaths
      == ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/x/tmux"])
    #expect(TmuxLocator(path: "/x", isExecutable: { $0 == "/x/tmux" }).locate() == "/x/tmux")
    #expect(TmuxLocator(path: "/usr/bin", isExecutable: { _ in false }).locate() == nil)
    #expect(TmuxLocator.installHint == "Install tmux: brew install tmux")
  }
}

struct BrokerPathsTests {
  let paths = HivemindPaths(home: URL(fileURLWithPath: "/Users/h", isDirectory: true))

  @Test func locations() {
    #expect(paths.brokerSocket.path == "/Users/h/Library/Application Support/Hivemind/broker.sock")
    #expect(paths.brokerToken.path == "/Users/h/Library/Application Support/Hivemind/broker.token")
    #expect(paths.tmuxConfig.path == "/Users/h/Library/Application Support/Hivemind/tmux.conf")
    #expect(BrokerPaths.fitsSocketAddress(paths.brokerSocket))
    let deep = HivemindPaths(home: URL(fileURLWithPath: "/Users/" + String(repeating: "u", count: 60), isDirectory: true))
    #expect(!BrokerPaths.fitsSocketAddress(deep.brokerSocket))
  }
}

struct BrokerTokenTests {
  @Test func generatesDistinctHexTokens() {
    let a = BrokerToken.generate()
    let b = BrokerToken.generate()
    #expect(a != b)
    #expect(a.value.count == 64)
    #expect(BrokerToken(a.value + "\n") == a)
    #expect(!String(describing: a).contains(a.value))
  }

  @Test func acceptsOnlyItsFormat() {
    #expect(BrokerToken(String(repeating: "0", count: 64)) != nil)
    for bad in ["", String(repeating: "0", count: 63), String(repeating: "A", count: 64), String(repeating: "g", count: 64)] {
      #expect(BrokerToken(bad) == nil)
    }
  }

  @Test func matchesOnlyTheSameToken() {
    let token = BrokerToken(String(repeating: "ab", count: 32))!
    #expect(token.matches(String(repeating: "ab", count: 32)))
    #expect(!token.matches(String(repeating: "ab", count: 31) + "ac"))
    #expect(!token.matches(String(repeating: "ab", count: 32) + "a"))
    #expect(!token.matches(""))
  }
}
