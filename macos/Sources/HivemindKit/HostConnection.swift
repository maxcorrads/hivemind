import Foundation

// The host connection (docs/remote-hosts.md#host-connection): one supervised SSH master per host. It carries the agent
// forward and the host's extra forwards, and every other SSH action reuses it through its control socket, so each one is
// a new channel, not a new login. The SSH side is a seam: SSHTransport builds the commands, ProcessLaunching runs the
// master and SSHRunning the short commands, so the whole state machine runs on fakes and a fake `ssh` in the tests.

/// What a short SSH command printed and how it ended.
public struct SSHResult: Equatable, Sendable {
  /// The status `launchFailed` stands for a command that could not run or ran past its timeout.
  public static let launchFailed: Int32 = -1

  public var status: Int32
  public var stdout: String
  public var stderr: String

  public init(status: Int32, stdout: String = "", stderr: String = "") {
    self.status = status
    self.stdout = stdout
    self.stderr = stderr
  }

  public var succeeded: Bool { status == 0 }

  /// The last line of stderr worth showing, at most 200 characters; ssh puts its reason there.
  public var reason: String? { SSHTransport.reason(in: stderr.split(whereSeparator: \.isNewline).map(String.init)) }
}

/// Runs one short command (SSHProcessRunner in the app, a fake in the tests).
@MainActor public protocol SSHRunning {
  /// Runs `spec` until it exits or `timeout` passes, then ends it. With `input`, that local command runs alongside and
  /// its stdout is `spec`'s stdin (the runtime's `tar`); a failed `input` fails the run. Without it, stdin is empty.
  func run(_ spec: LaunchSpec, input: LaunchSpec?, timeout: TimeInterval) async -> SSHResult
}

/// The `ssh` command lines of a host connection. Every one runs with `BatchMode=yes` (a password or passphrase prompt
/// fails instead of waiting) and `StrictHostKeyChecking=yes` (an unknown or changed host key refuses the connection,
/// with no prompt), and names the host's private control socket with `-S`, which takes the path as one argument.
public struct SSHTransport: Equatable, Sendable {
  public static let defaultExecutable = URL(fileURLWithPath: "/usr/bin/ssh")
  /// Seconds between keepalives, and how many may go unanswered before the master gives up (45 s).
  public static let aliveInterval = 15
  public static let aliveCountMax = 3
  /// Seconds the master waits for the TCP connection.
  public static let connectTimeout = 10
  /// ssh binds the control socket at its path plus a 17-byte random suffix, then renames it.
  static let socketSuffixBytes = 17

  public var executable: URL
  /// The environment ssh runs with: the app's, so `SSH_AUTH_SOCK` reaches the agent that holds the keys.
  public var environment: [String: String]
  /// The private folder of the control sockets (0700).
  public var controlFolder: URL

  public init(executable: URL = Self.defaultExecutable, environment: [String: String], controlFolder: URL) {
    self.executable = executable
    self.environment = environment
    self.controlFolder = controlFolder
  }

  /// The control folder for `paths`: `hostSockets`, or, when a socket there would not fit in a sockaddr_un (a very long
  /// home path) or ssh would expand a `%` in it, `/tmp/hivemind-ssh-<uid>`, which BrokerFiles.preparePrivateFolder
  /// refuses when another user made it.
  public static func controlFolder(paths: HivemindPaths) -> URL {
    let preferred = paths.hostSockets
    let longest = preferred.path.utf8.count + 1 + socketNameBytes + socketSuffixBytes
    if longest <= BrokerPaths.maxSocketPathBytes, !preferred.path.contains("%") { return preferred }
    return URL(fileURLWithPath: "/tmp/hivemind-ssh-\(getuid())", isDirectory: true)
  }

  static let socketNameBytes = 16

  /// The host's control socket: the first 16 hex digits of its id's SHA-256, so the name is short and fixed.
  public func controlPath(for host: RemoteHost) -> URL {
    controlFolder.appendingPathComponent(String(SHA256Hash.hex(Data(host.id.utf8)).prefix(Self.socketNameBytes)))
  }

  private func common(_ host: RemoteHost) -> [String] {
    ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-S", controlPath(for: host).path]
  }

  private func spec(_ arguments: [String]) -> LaunchSpec {
    LaunchSpec(executable: executable, arguments: arguments, environment: environment)
  }

  /// The master: no remote command (`-N`), the control socket (`ControlMaster=yes`, and `ControlPersist=no` so a
  /// `~/.ssh/config` default never sends it to the background), keepalives, `ExitOnForwardFailure` (a taken remote
  /// port fails the connection loudly instead of running without its forward), the agent forward from the host's
  /// loopback to the agent listener here, then the host's extra forwards as they were entered.
  public func masterSpec(_ host: RemoteHost, agentPort: ServerPort, remoteAgentPort: ServerPort) -> LaunchSpec {
    spec(["-N"] + common(host) + [
      "-o", "ControlMaster=yes", "-o", "ControlPersist=no",
      "-o", "ServerAliveInterval=\(Self.aliveInterval)", "-o", "ServerAliveCountMax=\(Self.aliveCountMax)",
      "-o", "ConnectTimeout=\(Self.connectTimeout)", "-o", "ExitOnForwardFailure=yes",
      "-R", "\(ServerEndpoint.host):\(remoteAgentPort):\(ServerEndpoint.host):\(agentPort)",
    ] + host.forwardArguments + [host.ssh])
  }

  /// Whether the master answers on its control socket.
  public func checkSpec(_ host: RemoteHost) -> LaunchSpec { spec(common(host) + ["-O", "check", host.ssh]) }

  /// Asks a master on the control socket to exit: one a previous run of the app left behind still holds the forwards.
  public func exitSpec(_ host: RemoteHost) -> LaunchSpec { spec(common(host) + ["-O", "exit", host.ssh]) }

  /// `command` on the host over the master, with no terminal: one argument, which ssh hands to the host user's login
  /// shell as `$SHELL -c`. `ControlMaster=no` keeps a command from becoming a master itself.
  public func commandSpec(_ host: RemoteHost, command: String) -> LaunchSpec {
    spec(common(host) + ["-o", "ControlMaster=no", "-T", host.ssh, command])
  }

  /// The last of `lines` worth showing as the reason a connection failed, at most 200 characters: not empty, not a
  /// debug or banner line.
  static func reason(in lines: [String]) -> String? {
    lines.reversed().lazy.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
      .first { !$0.isEmpty && !$0.hasPrefix("debug") }
      .map { String($0.prefix(200)) }
  }
}

/// Where one host's connection is.
public enum HostConnectionState: Equatable, Sendable {
  case stopped
  /// A master is being started, or has started and does not answer on its control socket yet.
  case connecting
  case online(since: Date)
  /// The master exited (or never answered); connection number `attempt` is scheduled at `at`. `reason` is ssh's last
  /// line, or its exit.
  case waitingToReconnect(attempt: Int, at: Date, reason: String)

  public var isOnline: Bool { if case .online = self { true } else { false } }
}

/// Where the remote runtime of an online host is (RemoteRuntimeInstalling).
public enum RemoteRuntimeState: Equatable, Sendable {
  /// Not checked on this connection yet.
  case unknown
  case checking
  case installing
  case ready
  case failed(String)
}

/// Checks the remote runtime over a live master and installs or replaces it when it is not this app's.
@MainActor public protocol RemoteRuntimeInstalling {
  /// Called once per connection, when the master answers. `installing` runs before a copy starts.
  func ensure(on host: RemoteHost, installing: @escaping @MainActor () -> Void) async -> Result<Void, BrokerFiles.Failure>
}

/// One host's supervised master (docs/remote-hosts.md#host-connection). `start` clears a master a previous run left on
/// the control socket, launches a new one, and polls `ssh -O check` until it answers: the host is then online and the
/// runtime is checked. If the master exits, or does not answer within `connectTimeout`, the host is offline and a new
/// master starts after the backoff's delay; a connection that stayed up `backoff.stableAfter` resets the count. It
/// never gives up: a host that sleeps or leaves the network comes back on its own.
@MainActor
public final class HostConnection {
  /// How long a new master has to answer on its control socket, and how often it is asked.
  public static let connectTimeout: TimeInterval = 30
  public static let checkInterval: TimeInterval = 0.5
  /// The longest a `-O check` or `-O exit` may take.
  static let controlTimeout: TimeInterval = 10
  /// Reconnect delays: 2 s doubling to a minute, forever.
  nonisolated public static let backoff = BackoffPolicy(initial: 2, multiplier: 2, maximum: 60, stableAfter: 30, maxAttempts: .max)

  public let host: RemoteHost
  public private(set) var state: HostConnectionState = .stopped { didSet { if state != oldValue { changed() } } }
  public private(set) var runtime: RemoteRuntimeState = .unknown { didSet { if runtime != oldValue { changed() } } }
  /// The last reason the host went offline, kept until it is online again.
  public private(set) var lastError: String?
  public var onChange: (@MainActor () -> Void)?
  /// Every line the master printed, and every step, for hosts.log.
  public var onLog: (@MainActor (String) -> Void)?

  private let transport: SSHTransport
  private let launcher: any ProcessLaunching
  private let runner: any SSHRunning
  private let scheduler: any Scheduling
  private let installer: any RemoteRuntimeInstalling
  private let backoffPolicy: BackoffPolicy
  private let agentPort: ServerPort
  private let remoteAgentPort: ServerPort

  private var process: (any SupervisedProcess)?
  /// Tells callbacks of the current attempt from those of a previous one; a stop moves it on too.
  private var generation = 0
  private var attempts = 0
  private var connectedAt: Date?
  private var masterLines: [String] = []
  private var pending: [any Cancellable] = []
  private var stopWaiters: [@MainActor () -> Void] = []
  private var stopping = false
  /// The async steps in flight (clearing, checks, the runtime), so a test can wait for them.
  private var tasks: [UUID: Task<Void, Never>] = [:]

  public init(host: RemoteHost, transport: SSHTransport, launcher: any ProcessLaunching, runner: any SSHRunning,
              scheduler: any Scheduling, installer: any RemoteRuntimeInstalling, agentPort: ServerPort,
              remoteAgentPort: ServerPort? = nil, backoff: BackoffPolicy = HostConnection.backoff) {
    self.host = host
    self.transport = transport
    self.launcher = launcher
    self.runner = runner
    self.scheduler = scheduler
    self.installer = installer
    self.agentPort = agentPort
    self.remoteAgentPort = remoteAgentPort ?? agentPort
    self.backoffPolicy = backoff
  }

  /// Online with its runtime in place: what the server's host catalog calls online.
  public var isReady: Bool { state.isOnline && runtime == .ready }

  /// Connects unless a connection is already up or under way. A user start resets the backoff.
  public func start() {
    switch state {
    case .connecting, .online: return
    case .waitingToReconnect: cancelPending()
    case .stopped: break
    }
    attempts = 0
    connect()
  }

  /// Ends the master (SIGTERM; ssh then removes its socket) and stays offline. `completion` runs once it is gone.
  public func stop(completion: (@MainActor () -> Void)? = nil) {
    generation += 1
    cancelPending()
    runtime = .unknown
    guard let process else {
      state = .stopped
      completion?()
      return
    }
    if let completion { stopWaiters.append(completion) }
    guard !stopping else { return }
    stopping = true
    let generation = self.generation
    log("stopping the connection")
    pending.append(scheduler.schedule(after: 5) { [weak self] in
      guard let self, self.generation == generation else { return }
      self.process?.kill()
    })
    process.terminate()
  }

  /// Drops the connection and opens a new one at once: Reconnect in the menu.
  public func reconnect() {
    stop { [weak self] in self?.start() }
  }

  /// Whether an async step is in flight.
  public var hasPendingWork: Bool { !tasks.isEmpty }

  /// Waits for the async steps started so far, and those they start. For tests.
  public func settle() async {
    while let task = tasks.values.first { await task.value }
  }

  // MARK: Steps

  private func connect() {
    generation += 1
    let generation = self.generation
    state = .connecting
    runtime = .unknown
    masterLines = []
    log("connecting")
    track { [weak self] in
      guard let self else { return }
      // A master the app left behind when it crashed would still hold the agent forward, so the new one would fail.
      _ = await self.runner.run(self.transport.exitSpec(self.host), input: nil, timeout: Self.controlTimeout)
      guard self.generation == generation else { return }
      unlink(self.transport.controlPath(for: self.host).path)
      self.launchMaster(generation)
    }
  }

  private func launchMaster(_ generation: Int) {
    do {
      try BrokerFiles.preparePrivateFolder(transport.controlFolder)
      let child = try launcher.launch(
        transport.masterSpec(host, agentPort: agentPort, remoteAgentPort: remoteAgentPort),
        onOutput: { [weak self] _, line in self?.masterSaid(line, generation: generation) },
        onExit: { [weak self] exit in self?.masterExited(exit, generation: generation) })
      process = child
      connectedAt = nil
      log("ssh master \(child.pid) started")
      let deadline = scheduler.now().addingTimeInterval(Self.connectTimeout)
      scheduleCheck(generation, deadline: deadline)
    } catch {
      process = nil
      offline("Could not run ssh: \(error.localizedDescription)")
    }
  }

  private func scheduleCheck(_ generation: Int, deadline: Date) {
    pending.append(scheduler.schedule(after: Self.checkInterval) { [weak self] in
      guard let self, self.generation == generation, case .connecting = self.state else { return }
      self.track { [weak self] in
        guard let self else { return }
        let result = await self.runner.run(self.transport.checkSpec(self.host), input: nil, timeout: Self.controlTimeout)
        guard self.generation == generation, case .connecting = self.state else { return }
        if result.succeeded {
          self.online(generation)
        } else if self.scheduler.now() >= deadline {
          self.log("the master did not answer within \(Int(Self.connectTimeout)) s")
          self.masterLines.append("The connection did not come up within \(Int(Self.connectTimeout)) s")
          self.process?.terminate()
        } else {
          self.scheduleCheck(generation, deadline: deadline)
        }
      }
    })
  }

  private func online(_ generation: Int) {
    connectedAt = scheduler.now()
    lastError = nil
    state = .online(since: scheduler.now())
    log("online")
    runtime = .checking
    track { [weak self] in
      guard let self else { return }
      let outcome = await self.installer.ensure(on: self.host, installing: { [weak self] in
        guard let self, self.generation == generation else { return }
        self.runtime = .installing
        self.log("installing the remote runtime")
      })
      guard self.generation == generation, self.state.isOnline else { return }
      switch outcome {
      case .success:
        self.runtime = .ready
        self.log("remote runtime ready")
      case .failure(let failure):
        self.runtime = .failed(failure.message)
        self.log("remote runtime failed: \(failure.message)")
      }
    }
  }

  private func masterSaid(_ line: String, generation: Int) {
    onLog?("[ssh] \(line)")
    guard generation == self.generation || stopping else { return }
    masterLines.append(line)
    if masterLines.count > 20 { masterLines.removeFirst() }
  }

  private func masterExited(_ exit: ProcessExit, generation: Int) {
    guard process != nil else { return }
    process = nil
    let wasStopping = stopping
    stopping = false
    if wasStopping || generation != self.generation {
      cancelPending()
      log("connection closed")
      if wasStopping { state = .stopped }
      let waiters = stopWaiters
      stopWaiters.removeAll()
      waiters.forEach { $0() }
      return
    }
    let uptime = connectedAt.map { scheduler.now().timeIntervalSince($0) } ?? 0
    if backoffPolicy.isStable(uptime: uptime) { attempts = 0 }
    offline(SSHTransport.reason(in: masterLines) ?? "ssh \(exit)")
  }

  private func offline(_ reason: String) {
    cancelPending()
    generation += 1
    connectedAt = nil
    lastError = reason
    runtime = .unknown
    attempts += 1
    let delay = backoffPolicy.delay(forAttempt: attempts) ?? backoffPolicy.maximum
    log("offline: \(reason); reconnecting in \(Int(delay)) s")
    state = .waitingToReconnect(attempt: attempts, at: scheduler.now().addingTimeInterval(delay), reason: reason)
    pending.append(scheduler.schedule(after: delay) { [weak self] in
      guard let self, case .waitingToReconnect = self.state else { return }
      self.connect()
    })
  }

  private func cancelPending() {
    pending.forEach { $0.cancel() }
    pending.removeAll()
  }

  private func track(_ work: @escaping @MainActor @Sendable () async -> Void) {
    let id = UUID()
    tasks[id] = Task { [weak self] in
      await work()
      self?.tasks[id] = nil
    }
  }

  private func log(_ message: String) { onLog?("[\(host.label)] \(message)") }
  private func changed() { onChange?() }
}
