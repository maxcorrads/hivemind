import Foundation

public enum SupervisorState: Equatable, Sendable {
  case stopped
  /// Launched; not yet reported ready.
  case starting(pid: Int32)
  case running(pid: Int32, since: Date)
  /// Crashed; restart number `attempt` is scheduled at `at`.
  case waitingToRestart(attempt: Int, at: Date)
  case stopping(pid: Int32)
  /// Refused to start, could not launch, or gave up restarting.
  case failed(String)

  public var pid: Int32? {
    switch self {
    case .starting(let pid), .running(let pid, _), .stopping(let pid): pid
    default: nil
    }
  }
}

/// Why a start was refused before anything was launched.
public enum PreflightFailure: Error, Equatable, Sendable, CustomStringConvertible {
  /// Another live server holds the data folder's server.lock.
  case dataFolderInUse(pid: Int32, dataHome: String)
  case portInUse(ServerPort)

  public var description: String {
    switch self {
    case .dataFolderInUse(let pid, let home): "Another Hivemind server (pid \(pid)) is already using \(home)"
    case .portInUse(let port): "Port \(port) is already in use"
    }
  }
}

/// Keeps one child alive: start/stop/restart, restart with backoff after a
/// crash, SIGTERM then SIGKILL on stop. Knows nothing about Hivemind beyond
/// what `Configuration` tells it, so the whole state machine runs on fakes.
@MainActor
public final class ProcessSupervisor {
  public struct Configuration {
    public var spec: @MainActor () -> LaunchSpec
    /// Checked before every launch, restarts included.
    public var preflight: @MainActor () -> PreflightFailure?
    /// A line that means the child is serving.
    public var isReadyLine: @Sendable (String) -> Bool
    /// A line after which a crash is not worth retrying (the same error would recur).
    public var isFatalLine: @Sendable (String) -> Bool
    /// A line worth showing the user as "the last error".
    public var isErrorLine: @Sendable (String) -> Bool
    public var backoff: BackoffPolicy
    /// How long stop() waits after SIGTERM before SIGKILL.
    public var stopTimeout: TimeInterval

    public init(
      spec: @escaping @MainActor () -> LaunchSpec,
      preflight: @escaping @MainActor () -> PreflightFailure? = { nil },
      isReadyLine: @escaping @Sendable (String) -> Bool = { _ in true },
      isFatalLine: @escaping @Sendable (String) -> Bool = { _ in false },
      isErrorLine: @escaping @Sendable (String) -> Bool = { !$0.isEmpty },
      backoff: BackoffPolicy = .default,
      stopTimeout: TimeInterval = 10
    ) {
      self.spec = spec
      self.preflight = preflight
      self.isReadyLine = isReadyLine
      self.isFatalLine = isFatalLine
      self.isErrorLine = isErrorLine
      self.backoff = backoff
      self.stopTimeout = stopTimeout
    }
  }

  public private(set) var state: SupervisorState = .stopped {
    didSet { if state != oldValue { onStateChange?(state) } }
  }
  /// The last stderr line `isErrorLine` accepted, cleared when a run becomes ready.
  public private(set) var lastErrorLine: String?

  public var onStateChange: (@MainActor (SupervisorState) -> Void)?
  /// Every output line, for the log file.
  public var onOutput: (@MainActor (OutputChannel, String) -> Void)?

  public let configuration: Configuration
  private let launcher: any ProcessLaunching
  private let scheduler: any Scheduling

  private var process: (any SupervisedProcess)?
  /// Distinguishes callbacks of the current child from those of a previous one.
  private var generation = 0
  private var launchedAt: Date?
  private var attempts = 0
  private var sawFatalLine = false
  private var pendingRestart: (any Cancellable)?
  private var pendingKill: (any Cancellable)?
  private var stopWaiters: [@MainActor () -> Void] = []
  private var restartAfterStop = false

  public init(configuration: Configuration, launcher: any ProcessLaunching, scheduler: any Scheduling) {
    self.configuration = configuration
    self.launcher = launcher
    self.scheduler = scheduler
  }

  /// Starts unless a child is already alive. A user start resets the crash count.
  public func start() {
    switch state {
    case .starting, .running, .stopping: return
    case .waitingToRestart: pendingRestart?.cancel(); pendingRestart = nil
    case .stopped, .failed: break
    }
    attempts = 0
    launch()
  }

  /// SIGTERM, then SIGKILL after `stopTimeout`. `completion` runs once no child is left.
  public func stop(completion: (@MainActor () -> Void)? = nil) {
    stop(thenRestart: false, completion: completion)
  }

  /// Stops, then starts once the child is gone.
  public func restart() {
    guard state.pid != nil else { start(); return }
    stop(thenRestart: true, completion: nil)
  }

  private func stop(thenRestart: Bool, completion: (@MainActor () -> Void)?) {
    // Set before terminate(): a child may exit inside it.
    restartAfterStop = thenRestart
    switch state {
    case .starting(let pid), .running(let pid, _):
      if let completion { stopWaiters.append(completion) }
      state = .stopping(pid: pid)
      // Arm the SIGKILL first: a child may exit inside terminate().
      let generation = self.generation
      pendingKill = scheduler.schedule(after: configuration.stopTimeout) { [weak self] in
        guard let self, self.generation == generation else { return }
        self.process?.kill()
      }
      process?.terminate()
    case .stopping:
      if let completion { stopWaiters.append(completion) }
    case .waitingToRestart:
      pendingRestart?.cancel()
      pendingRestart = nil
      state = .stopped
      completion?()
    case .stopped, .failed:
      state = .stopped
      completion?()
    }
  }

  private func launch() {
    if let failure = configuration.preflight() {
      state = .failed(failure.description)
      return
    }
    generation += 1
    let generation = self.generation
    sawFatalLine = false
    do {
      let child = try launcher.launch(
        configuration.spec(),
        onOutput: { [weak self] channel, line in self?.handleOutput(channel, line, generation: generation) },
        onExit: { [weak self] exit in self?.handleExit(exit, generation: generation) })
      process = child
      launchedAt = scheduler.now()
      state = .starting(pid: child.pid)
    } catch {
      process = nil
      state = .failed("Could not launch: \(error.localizedDescription)")
    }
  }

  private func handleOutput(_ channel: OutputChannel, _ line: String, generation: Int) {
    onOutput?(channel, line)
    guard generation == self.generation else { return }
    if case .starting(let pid) = state, configuration.isReadyLine(line) {
      lastErrorLine = nil
      state = .running(pid: pid, since: scheduler.now())
      return
    }
    guard channel == .stderr else { return }
    if configuration.isFatalLine(line) { sawFatalLine = true }
    if configuration.isErrorLine(line) { lastErrorLine = line }
  }

  private func handleExit(_ exit: ProcessExit, generation: Int) {
    guard generation == self.generation else { return }
    process = nil
    pendingKill?.cancel()
    pendingKill = nil
    let uptime = launchedAt.map { scheduler.now().timeIntervalSince($0) } ?? 0
    launchedAt = nil

    if case .stopping = state {
      state = .stopped
      let waiters = stopWaiters
      stopWaiters.removeAll()
      waiters.forEach { $0() }
      if restartAfterStop {
        restartAfterStop = false
        start()
      }
      return
    }

    // Unrequested exit: a crash, even with status 0 — the server never exits on its own.
    let reason = lastErrorLine ?? "Server \(exit)"
    if sawFatalLine {
      state = .failed(reason)
      return
    }
    if configuration.backoff.isStable(uptime: uptime) { attempts = 0 }
    attempts += 1
    guard let delay = configuration.backoff.delay(forAttempt: attempts) else {
      state = .failed(reason)
      return
    }
    state = .waitingToRestart(attempt: attempts, at: scheduler.now().addingTimeInterval(delay))
    pendingRestart = scheduler.schedule(after: delay) { [weak self] in
      guard let self, case .waitingToRestart = self.state else { return }
      self.pendingRestart = nil
      self.launch()
    }
  }
}
