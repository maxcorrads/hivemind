import Foundation

// The seams between the terminal broker's logic (TerminalBroker) and the
// operating system: the transport a client talks over, the tmux binary, and
// the pseudo-terminals streams run in. Hivemind Server.app supplies the real
// ones (a Unix socket, Foundation.Process, forkpty); tests supply fakes, so
// no test ever runs tmux, opens a PTY or binds a socket.

// MARK: - Transport

/// One client's byte stream, whatever carries it (a Unix socket now, TLS for
/// an iOS client later). The transport reports what happens on it to the
/// `BrokerConnection` that `TerminalBroker.accept` returned for it:
/// `received(_:)`, `wrote(_:)` and `closed()`.
@MainActor
public protocol BrokerTransport: AnyObject {
  /// Queues bytes to write. The transport later reports every byte it
  /// actually wrote with `BrokerConnection.wrote(_:)`: that is how the broker
  /// knows how far behind the client is.
  func send(_ data: Data)
  /// Writes what is queued (within a short grace period), then closes. The
  /// broker calls it at most once and ignores the transport afterwards.
  func close()
}

// MARK: - tmux

/// What one tmux call printed and how it ended.
public struct TmuxResult: Equatable, Sendable {
  /// The exit status; `launchFailed` when tmux could not be run at all.
  public var status: Int32
  public var stdout: String
  public var stderr: String

  public static let launchFailed: Int32 = -1

  public init(status: Int32, stdout: String = "", stderr: String = "") {
    self.status = status
    self.stdout = stdout
    self.stderr = stderr
  }

  public var succeeded: Bool { status == 0 }

  /// The first stderr line, cut to fit an error message.
  public var firstErrorLine: String {
    let line = stderr.split(whereSeparator: \.isNewline).first.map(String.init)?.trimmingCharacters(in: .whitespaces) ?? ""
    let text = line.isEmpty ? "tmux exited with status \(status)" : line
    return text.count > 200 ? String(text.prefix(199)) + "…" : text
  }
}

/// Runs one short tmux command (never `attach`, which runs in a PTY) and
/// returns what it printed. The real one kills a call that hangs.
@MainActor
public protocol TmuxRunning {
  func run(executable: String, arguments: [String], environment: [String: String]) async -> TmuxResult
}

// MARK: - Pseudo-terminals

/// A process to run on the slave side of a new pseudo-terminal.
public struct BrokerTerminalSpec: Equatable, Sendable {
  public var executable: String
  /// argv after argv[0], which is the executable.
  public var arguments: [String]
  public var environment: [String: String]
  public var size: TerminalSize

  public init(executable: String, arguments: [String], environment: [String: String], size: TerminalSize) {
    self.executable = executable
    self.arguments = arguments
    self.environment = environment
    self.size = size
  }
}

/// One running PTY child: a `tmux attach-session` client for one stream.
@MainActor
public protocol BrokerTerminal: AnyObject {
  /// Queues bytes for the terminal's input. False when they were dropped
  /// because the child has not read what came before.
  func write(_ data: Data) -> Bool
  /// TIOCSWINSZ; the kernel then sends the child SIGWINCH.
  func resize(_ size: TerminalSize)
  /// Stops or resumes reading the PTY: the broker's backpressure. While not
  /// read, the child blocks on write and tmux keeps the output meanwhile.
  func setReading(_ reading: Bool)
  /// Hangs the child up (SIGHUP: a tmux client detaches) and closes the PTY.
  /// Neither callback is called afterwards. The session keeps running.
  func terminate()
}

/// Opens PTYs. `onOutput` receives what the child printed, in order, and
/// `onExit` comes once, after all output, with the exit status (nil when the
/// child was killed by a signal). Both arrive on the main actor, never from
/// inside `spawn` itself.
@MainActor
public protocol BrokerTerminalSpawning {
  func spawn(
    _ spec: BrokerTerminalSpec,
    onOutput: @escaping @MainActor @Sendable (Data) -> Void,
    onExit: @escaping @MainActor @Sendable (Int?) -> Void
  ) throws -> any BrokerTerminal
}

// MARK: - Environment

/// The environment tmux runs with. The first tmux call starts Hivemind's
/// tmux server, which hands its environment on to every session, so this is
/// also what an agent's shell starts from (before its login profile).
public enum BrokerEnvironment {
  /// Dropped from the app's own environment. $TMUX would make tmux refuse
  /// to attach ("sessions should be nested with care") when the app was
  /// started from inside a tmux pane; the terminal variables describe
  /// whatever terminal started the app, not the session's.
  public static let dropped: Set<String> = [
    "TMUX", "TMUX_PANE", SessionName.environmentVariable,
    "TERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "TERM_SESSION_ID", "COLORTERM",
  ]

  /// Apps started by launchd get /usr/bin:/bin:/usr/sbin:/sbin; the login
  /// shell a session runs adds the user's own PATH on top.
  public static let homebrewPaths = ["/opt/homebrew/bin", "/usr/local/bin"]
  public static let defaultPath = "/usr/bin:/bin:/usr/sbin:/sbin"

  /// For every short tmux call and the server it may start.
  public static func tmux(from base: [String: String]) -> [String: String] {
    var environment = base.filter { !dropped.contains($0.key) }
    var path = (environment["PATH"] ?? "").split(separator: ":").map(String.init)
    if path.isEmpty { path = defaultPath.split(separator: ":").map(String.init) }
    for entry in homebrewPaths.reversed() where !path.contains(entry) { path.insert(entry, at: 0) }
    environment["PATH"] = path.joined(separator: ":")
    if environment["LANG"]?.isEmpty ?? true { environment["LANG"] = "en_US.UTF-8" }
    return environment
  }

  /// For a stream's `tmux attach-session` client: TERM is what xterm.js
  /// emulates (TmuxCommand.clientTerm), with 24-bit colour.
  public static func attach(from base: [String: String]) -> [String: String] {
    var environment = tmux(from: base)
    environment["TERM"] = TmuxCommand.clientTerm
    environment["COLORTERM"] = "truecolor"
    return environment
  }
}
