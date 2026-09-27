import Foundation

// argv for every tmux call the broker makes, and the parser for what
// list-sessions prints. Pure: nothing here runs tmux. Every call goes to
// Hivemind's own tmux server (-L hivemind, with its own config), so the
// user's own tmux server and sessions are never touched, and every value
// travels as its own argv element: no shell is ever built from strings here.

/// A launch as tmux will run it.
public struct TmuxNewSession: Equatable, Sendable {
  public let name: SessionName
  public let cwd: String
  public let command: String
  public let title: String
  public let project: String
  public let agent: String?
  /// Files the script reads the launch's secrets from (LaunchSecretStore).
  /// Only their paths are in argv; the values never are.
  public let secretFiles: [LaunchSecretFile]

  public init(name: SessionName, launch: BrokerLaunch, secretFiles: [LaunchSecretFile] = []) {
    self.name = name
    self.cwd = launch.cwd
    self.command = launch.command
    self.title = launch.title
    self.project = launch.project
    self.agent = launch.agent
    self.secretFiles = secretFiles
  }
}

public struct TmuxCommand: Equatable, Sendable {
  /// The tmux binary (TmuxLocator).
  public let executable: String
  /// The config file the broker writes (HivemindPaths.tmuxConfig).
  public let configPath: String

  /// `tmux -L hivemind`: a server socket of its own, in tmux's per-user
  /// socket folder, so it never meets the user's default server.
  public static let socketName = "hivemind"
  /// The shell every session runs, as a login shell so PATH is the user's.
  public static let shell = "/bin/zsh"
  /// Session options holding what the launch was for; list-sessions reads them back.
  public static let projectOption = "@hivemind_project"
  public static let agentOption = "@hivemind_agent"
  /// TERM for the tmux client the broker runs in a PTY (what xterm.js emulates).
  public static let clientTerm = "xterm-256color"

  /// tmux hands a command to its server in one message of at most 16 KiB
  /// (MAX_IMSGSIZE, header included) and refuses a longer one with a
  /// confusing "command too long". The broker refuses a new-session whose
  /// arguments would come near that itself, before running tmux. Every
  /// launch within BrokerLimits fits (TmuxTests checks the largest).
  public static let maxCommandLineBytes = 15 * 1024

  /// The bytes tmux packs for `arguments`: each one and its NUL.
  public static func commandLineBytes(_ arguments: [String]) -> Int {
    arguments.reduce(0) { $0 + $1.utf8.count + 1 }
  }

  public init(executable: String, configPath: String) {
    self.executable = executable
    self.configPath = configPath
  }

  /// Arguments every call starts with. `-u`: the client is UTF-8 whatever
  /// the broker's locale, so tmux does not replace non-ASCII with "_".
  public var baseArguments: [String] { ["-u", "-L", Self.socketName, "-f", configPath] }

  /// Starts the session detached, then records project and agent on it.
  /// tmux runs `/bin/zsh -lic <script>` directly (argv, no shell of ours): a login
  /// *interactive* shell, so ~/.zshrc (aliases, nvm, rbenv…) applies as in a terminal.
  /// Precondition: has-session said it does not exist, and the broker
  /// checked that `cwd` is a directory.
  ///
  /// Two tmux rules shape this. tmux expands formats (`#{…}`, and `#(…)`,
  /// which runs a shell command) in some new-session values such as -c, so
  /// the folder is not passed with -c but cd'ed to, single-quoted, by the
  /// script, and the window name loses its "#"s. And tmux ends a command at
  /// any argument ending in ";", so every free-form argument goes through
  /// `argument(_:)`.
  public func newSession(_ spec: TmuxNewSession) -> [String] {
    var arguments = baseArguments + [
      "new-session", "-d",
      "-s", spec.name.rawValue,
      "-n", Self.argument(Self.windowName(spec.title)),
      "-e", "\(SessionName.environmentVariable)=\(spec.name.rawValue)",
      "--",
      Self.shell, "-lic", Self.argument(Self.script(cwd: spec.cwd, command: spec.command, secretFiles: spec.secretFiles)),
    ]
    // ";" as its own argument chains tmux commands in one call. set-option
    // takes a pane target, which needs "=name:" (SessionName.windowTarget).
    arguments += [";", "set-option", "-t", spec.name.windowTarget, Self.projectOption, Self.argument(spec.project)]
    if let agent = spec.agent {
      arguments += [";", "set-option", "-t", spec.name.windowTarget, Self.agentOption, Self.argument(agent)]
    }
    return arguments
  }

  /// A value tmux reads back unchanged from the command line: one ending in
  /// ";" gets a backslash before that ";" (tmux turns a trailing "\;" into
  /// ";" instead of ending the command there).
  public static func argument(_ value: String) -> String {
    guard value.hasSuffix(";") else { return value }
    return String(value.dropLast()) + "\\;"
  }

  public func hasSession(_ name: SessionName) -> [String] {
    baseArguments + ["has-session", "-t", name.target]
  }

  public func listSessions() -> [String] {
    baseArguments + ["list-sessions", "-F", Self.listFormat]
  }

  public func killSession(_ name: SessionName) -> [String] {
    baseArguments + ["kill-session", "-t", name.target]
  }

  /// What the broker runs in a PTY (forkpty) for one stream, and what the
  /// Terminal.app .command file execs. Several clients may attach one session.
  public func attach(_ name: SessionName) -> [String] {
    baseArguments + ["attach-session", "-t", name.target]
  }

  /// The .command line for "Open in Terminal": the executable and every
  /// argument single-quoted.
  public func attachShellLine(_ name: SessionName) -> String {
    "exec " + ([executable] + attach(name)).map(TerminalScript.shellQuoted).joined(separator: " ")
  }

  /// The script zsh -lic runs: first each secret read from its file into
  /// its exported variable and the file deleted (`secretLine`), then cd to
  /// the folder (single-quoted), the command as the sheet built it, then an
  /// interactive login shell so the session outlives the agent. Joined by a
  /// blank line, not "; ", so a trailing comment or backslash in the command
  /// cannot swallow the exec.
  public static func script(cwd: String, command: String, secretFiles: [LaunchSecretFile] = []) -> String {
    var command = command
    while command.hasSuffix("\n") || command.hasSuffix("\r") { command.removeLast() }
    return secretFiles.filter { LaunchSecrets.allowedNames.contains($0.name) }.map(secretLine).joined()
      + "cd -- \(TerminalScript.shellQuoted(cwd)) || exit 1\n" + command + "\n\nexec \(shell) -l"
  }

  /// One secret, from its file into the shell's environment, before anything
  /// else runs: the value itself is never in the script, only the file's
  /// single-quoted path. A file that cannot be read (or is empty) leaves the
  /// variable unset. /bin/cat and /bin/rm, because ~/.zshrc aliases apply in
  /// this interactive shell. The variable lives in the shell and what it
  /// starts, never in tmux's global or session environment.
  static func secretLine(_ file: LaunchSecretFile) -> String {
    let path = TerminalScript.shellQuoted(file.path)
    let name = file.name
    return "if \(name)=\"$(/bin/cat -- \(path) 2>/dev/null)\" && [ -n \"$\(name)\" ]; then export \(name); else unset \(name); fi; "
      + "/bin/rm -f -- \(path)\n"
  }

  /// A tmux window name: one line without control characters or "#" (a
  /// format), at most 60 characters.
  public static func windowName(_ title: String) -> String {
    let name = TerminalScript.displayTitle(title.replacingOccurrences(of: "#", with: " "))
    return String(name.prefix(60)).trimmingCharacters(in: .whitespaces)
  }

  // MARK: list-sessions

  static let separator = "|"

  /// Fields separated by "|". Agent comes last and the parser splits at most
  /// five times, so an agent name with "|" in it still reads back whole.
  public static let listFormat = [
    "#{session_name}", "#{session_created}", "#{session_attached}", "#{pane_dead}",
    "#{\(projectOption)}", "#{\(agentOption)}",
  ].joined(separator: separator)

  /// Every Hivemind session in list-sessions output, sorted by name. Lines
  /// that are not ours (another name, a malformed line) are skipped.
  public static func parseSessions(_ output: String) -> [BrokerSession] {
    output.split(whereSeparator: \.isNewline).compactMap { line in
      let fields = line.split(separator: Character(separator), maxSplits: 5, omittingEmptySubsequences: false).map(String.init)
      guard fields.count == 6,
            let name = SessionName(fields[0]),
            let created = Int64(fields[1]), created >= 0, created < Int64.max / 1000,
            let attached = Int(fields[2]), attached >= 0 else { return nil }
      let project = BrokerLaunch.isProjectSlug(fields[4]) ? fields[4] : nil
      let agent = fields[5].isEmpty || fields[5].count > BrokerLimits.maxAgentCharacters ? nil : fields[5]
      return BrokerSession(
        name: name, project: project, agent: agent, alive: fields[3] != "1", attached: attached, createdAt: created * 1000)
    }
    .sorted { $0.name < $1.name }
  }

  /// list-sessions (and has-session) fail this way when the Hivemind tmux
  /// server is not running yet: that is an empty list, not an error.
  public static func isNoServer(stderr: String) -> Bool {
    let text = stderr.lowercased()
    return text.contains("no server running") || text.contains("error connecting to") || text.contains("no sessions")
  }

  // MARK: Config

  /// ~/Library/Application Support/Hivemind/tmux.conf, written by the broker
  /// (0600) before its first tmux call. Read only when the Hivemind tmux
  /// server starts; the user's ~/.tmux.conf is never read by it.
  public static let configText = """
    # Written by Hivemind Server.app for its own tmux server (tmux -L hivemind).
    # It is rewritten on every broker start; edits here are lost.
    set -g default-terminal "tmux-256color"
    set -as terminal-features ",xterm-256color:RGB"
    set -g history-limit 50000
    set -g mouse on
    set -g window-size latest
    set -g status off
    set -g set-titles on
    set -g set-titles-string "#{session_name}"
    set -g allow-rename off
    set -g focus-events on
    set -s escape-time 10
    set -g remain-on-exit off
    set -g exit-empty on

    """
}
