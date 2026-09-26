import Darwin
import Foundation

/// Everything the server app does with its server, minus AppKit: settings,
/// the supervisor, server.json, the log, and the "previous server" left
/// behind when the app itself crashed. The menu is a view over this.
@MainActor
public final class ServerAppController {
  /// The seams tests replace; `live()` is what the app runs with.
  public struct Dependencies {
    public var launcher: any ProcessLaunching
    public var scheduler: any Scheduling
    public var probe: any PortProbing
    public var lockOwner: (URL) -> InstanceLockOwner?
    public var isAlive: (Int32) -> Bool
    /// When a process started, to tell our orphan from a recycled pid.
    public var processStart: (Int32) -> Date?
    public var signal: (Int32, Int32) -> Void
    public var baseEnvironment: [String: String]
    public var backoff: BackoffPolicy
    public var stopTimeout: TimeInterval

    public init(
      launcher: any ProcessLaunching, scheduler: any Scheduling, probe: any PortProbing,
      lockOwner: @escaping (URL) -> InstanceLockOwner?, isAlive: @escaping (Int32) -> Bool,
      processStart: @escaping (Int32) -> Date?, signal: @escaping (Int32, Int32) -> Void,
      baseEnvironment: [String: String], backoff: BackoffPolicy = .default, stopTimeout: TimeInterval = 10
    ) {
      self.launcher = launcher
      self.scheduler = scheduler
      self.probe = probe
      self.lockOwner = lockOwner
      self.isAlive = isAlive
      self.processStart = processStart
      self.signal = signal
      self.baseEnvironment = baseEnvironment
      self.backoff = backoff
      self.stopTimeout = stopTimeout
    }

    // The live launcher wraps Foundation.Process, which iOS lacks; the iOS
    // app builds HivemindKit but never runs a server.
    #if os(macOS)
    @MainActor public static func live() -> Dependencies {
      Dependencies(
        launcher: FoundationProcessLauncher(), scheduler: MainQueueScheduler(), probe: LoopbackPortProbe(),
        lockOwner: { InstanceLockOwner.live(dataHome: $0) }, isAlive: ProcessLiveness.isAlive,
        processStart: ProcessLiveness.startDate, signal: { _ = Darwin.kill($0, $1) },
        baseEnvironment: ProcessInfo.processInfo.environment)
    }
    #endif
  }

  public let paths: HivemindPaths
  public let server: BundledServer?
  public let version: String
  public private(set) var settings: ServerAppSettings
  public var onChange: (@MainActor () -> Void)?

  private let store: ServerAppSettingsStore
  private let deps: Dependencies
  private let discovery: DiscoveryStore
  private let log: RotatingLog
  /// What the current child was launched with; settings may have moved on since.
  private var active: ServerLaunchSettings?
  /// The port the child announced, which is the truth once it is ready.
  private var announcedPort: ServerPort?
  /// The secret the current child was started with (InstanceProof), new for
  /// every launch, restarts included. Never logged.
  private var activeSecret: InstanceSecret?
  private var preflightFailure: PreflightFailure?
  private var readyWaiters: [@MainActor (ServerEndpoint) -> Void] = []
  private var stoppingPrevious: Int32?

  private lazy var supervisor: ProcessSupervisor = {
    let supervisor = ProcessSupervisor(
      configuration: .init(
        spec: { [unowned self] in self.nextLaunchSpec() },
        preflight: { [unowned self] in self.runPreflight() },
        isReadyLine: { ServerOutput.listeningPort(in: $0) != nil },
        isFatalLine: ServerOutput.isFatal,
        isErrorLine: ServerOutput.isError,
        backoff: deps.backoff,
        stopTimeout: deps.stopTimeout),
      launcher: deps.launcher, scheduler: deps.scheduler)
    supervisor.onOutput = { [unowned self] channel, line in self.handleOutput(channel, line) }
    supervisor.onStateChange = { [unowned self] state in self.handleStateChange(state) }
    return supervisor
  }()

  private lazy var publisher = DiscoveryPublisher(
    store: discovery, version: version, settings: { [unowned self] in self.publishedSettings },
    secret: { [unowned self] in self.activeSecret })

  public init(
    paths: HivemindPaths, server: BundledServer?, version: String, store: ServerAppSettingsStore,
    log: RotatingLog, dependencies: Dependencies
  ) {
    self.paths = paths
    self.server = server
    self.version = version
    self.store = store
    self.settings = store.load()
    self.log = log
    self.deps = dependencies
    self.discovery = DiscoveryStore(paths: paths)
  }

  // MARK: State

  public var state: SupervisorState { supervisor.state }
  public var lastErrorLine: String? { supervisor.lastErrorLine }

  /// Why the server can never start from this copy of the app.
  public var unavailableReason: String? {
    server == nil ? "Node.js is not bundled; build the app with macos/build.sh" : nil
  }

  public var status: ServerAppStatus {
    if let pid = stoppingPrevious {
      return ServerAppStatus(kind: .busy, title: "Stopping the previous server (pid \(pid))…", detail: nil,
                             canStart: false, canStop: false, canRestart: false)
    }
    return ServerAppStatus(state: state, lastErrorLine: lastErrorLine, port: endpoint.port, unavailable: unavailableReason)
  }

  /// Where the server is (while it has a child) or will be.
  public var endpoint: ServerEndpoint {
    if state.pid != nil, let active { return ServerEndpoint(port: announcedPort ?? active.port) }
    return ServerEndpoint(port: settings.port)
  }

  public var dataHome: URL { settings.launchSettings(paths: paths).dataHome }

  // MARK: Lifecycle

  /// App launch: clear a server.json whose server is gone, then start.
  public func launch() {
    if let stale = discovery.read(), !deps.isAlive(stale.pid) { discovery.remove(ifOwnedBy: stale.pid) }
    log.append("[app] Hivemind Server \(version) launched")
    start()
  }

  public func start() {
    guard unavailableReason == nil, stoppingPrevious == nil else { changed(); return }
    supervisor.start()
  }

  public func stop(completion: (@MainActor () -> Void)? = nil) {
    readyWaiters.removeAll()
    supervisor.stop(completion: completion)
  }

  public func restart() {
    guard unavailableReason == nil, stoppingPrevious == nil else { return }
    supervisor.restart()
  }

  /// Quit: stop the child (SIGTERM, then SIGKILL) and take server.json down.
  public func shutdown(completion: @escaping @MainActor () -> Void) {
    log.append("[app] quitting")
    stop { [weak self] in
      self?.publisher.withdraw()
      completion()
    }
  }

  /// Whether quitting has to wait for a child to exit.
  public var hasChild: Bool { state.pid != nil }

  /// Runs `work` once the server is reachable, or at once if waiting makes no
  /// sense (it failed, e.g. something else holds the port). A user stop drops it.
  public func whenReady(_ work: @escaping @MainActor (ServerEndpoint) -> Void) {
    switch state {
    case .running, .failed, .stopped: work(endpoint)
    case .starting, .waitingToRestart, .stopping: readyWaiters.append(work)
    }
  }

  // MARK: Settings

  /// Saves `new`; a server that is not deliberately stopped is (re)started on
  /// it, so a port change on a failed "port in use" start retries at once.
  public func update(_ new: ServerAppSettings) {
    var new = new
    // The default folder picked by hand stays "the default".
    if new.dataHome?.standardizedFileURL == paths.defaultDataHome.standardizedFileURL { new.dataHome = nil }
    guard new != settings else { return }
    let wasLaunchable = settings.launchSettings(paths: paths)
    settings = new
    store.save(new)
    log.append("[app] settings: port \(new.port), data folder \(dataHome.path)")
    defer { changed() }
    guard new.launchSettings(paths: paths) != wasLaunchable else { return }
    switch state {
    case .stopped, .stopping: break
    case .starting, .running: restart()
    case .waitingToRestart, .failed: start()
    }
  }

  // MARK: A previous server of ours

  /// A server this app started before it crashed or was force-quit: it still
  /// holds the data folder (or port) the next start needs. Offered to the
  /// user only when server.json, the lock (or port) and the process start
  /// time all agree, so a recycled pid is never signalled.
  public var previousServer: ServerDiscovery? {
    guard stoppingPrevious == nil, case .failed = state, let failure = preflightFailure,
          let live = discovery.readLive(isAlive: deps.isAlive) else { return nil }
    switch failure {
    case .dataFolderInUse(let pid, let home):
      guard live.pid == pid, URL(fileURLWithPath: live.home).standardizedFileURL.path == home else { return nil }
    case .portInUse(let port):
      guard live.port == port else { return nil }
    }
    // The process must be at least as old as its "ready" record.
    guard let started = deps.processStart(live.pid), started <= live.startedAt.addingTimeInterval(1) else { return nil }
    return live
  }

  /// SIGTERM the previous server, SIGKILL it after the stop timeout, then start ours.
  public func stopPreviousServer() {
    guard let previous = previousServer else { return }
    let pid = previous.pid
    stoppingPrevious = pid
    log.append("[app] stopping the previous server (pid \(pid))")
    deps.signal(pid, SIGTERM)
    changed()
    waitForPrevious(pid, deadline: deps.scheduler.now().addingTimeInterval(deps.stopTimeout), killed: false)
  }

  private static let pollInterval: TimeInterval = 0.25

  private func waitForPrevious(_ pid: Int32, deadline: Date, killed: Bool) {
    if !deps.isAlive(pid) {
      discovery.remove(ifOwnedBy: pid)
      stoppingPrevious = nil
      start()
      changed()
      return
    }
    var killed = killed
    var deadline = deadline
    if deps.scheduler.now() >= deadline {
      guard !killed else {
        stoppingPrevious = nil
        log.append("[app] the previous server (pid \(pid)) did not exit")
        changed()
        return
      }
      deps.signal(pid, SIGKILL)
      killed = true
      deadline = deps.scheduler.now().addingTimeInterval(2)
    }
    deps.scheduler.schedule(after: Self.pollInterval) { [weak self] in
      self?.waitForPrevious(pid, deadline: deadline, killed: killed)
    }
  }

  // MARK: Supervisor callbacks

  private var publishedSettings: ServerLaunchSettings {
    var current = active ?? settings.launchSettings(paths: paths)
    if let announcedPort { current.port = announcedPort }
    return current
  }

  private func runPreflight() -> PreflightFailure? {
    let failure = settings.launchSettings(paths: paths).preflight(probe: deps.probe, lockOwner: deps.lockOwner)
    preflightFailure = failure
    return failure
  }

  private func nextLaunchSpec() -> LaunchSpec {
    let launch = settings.launchSettings(paths: paths)
    active = launch
    announcedPort = nil
    let secret = InstanceSecret.generate()
    activeSecret = secret
    // Process refuses a missing working directory; the server would create it anyway.
    try? FileManager.default.createDirectory(
      at: launch.dataHome, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
    log.append("[app] starting hivemind serve on port \(launch.port), data folder \(launch.dataHome.path)")
    let bundled = server ?? BundledServer(contents: URL(fileURLWithPath: "/nonexistent/Contents"))
    var spec = launch.spec(server: bundled, baseEnvironment: deps.baseEnvironment, home: paths.home, secret: secret)
    // --port wins over it on the server; set anyway so anything the server
    // spawns sees the same port.
    spec.environment["HIVEMIND_PORT"] = launch.port.description
    return spec
  }

  private func handleOutput(_ channel: OutputChannel, _ line: String) {
    log.append(line, channel: channel)
    if let port = ServerOutput.listeningPort(in: line) { announcedPort = port }
  }

  private func handleStateChange(_ state: SupervisorState) {
    publisher.update(for: state)
    switch state {
    case .starting(let pid):
      preflightFailure = nil
      log.append("[app] server process \(pid) started")
    case .running:
      log.append("[app] server ready on \(endpoint.baseURL.absoluteString)")
      flushReadyWaiters()
    case .waitingToRestart(let attempt, let at):
      let delay = max(0, at.timeIntervalSince(deps.scheduler.now()))
      log.append("[app] server exited unexpectedly; restart \(attempt) in \(String(format: "%.0f", delay)) s")
    case .stopping(let pid):
      log.append("[app] stopping server process \(pid)")
    case .stopped:
      active = nil
      announcedPort = nil
      activeSecret = nil
      log.append("[app] server stopped")
    case .failed(let message):
      active = nil
      activeSecret = nil
      log.append("[app] \(message)")
      flushReadyWaiters()
    }
    changed()
  }

  private func flushReadyWaiters() {
    let waiters = readyWaiters
    readyWaiters.removeAll()
    let endpoint = self.endpoint
    waiters.forEach { $0(endpoint) }
  }

  private func changed() { onChange?() }
}

/// What "Open Hivemind" does: the UI app when it is installed, else the UI in
/// the default browser.
public enum OpenHivemindAction: Equatable, Sendable {
  case launchApp(URL)
  case openInBrowser(URL)

  public static func decide(uiApp: URL?, endpoint: ServerEndpoint) -> OpenHivemindAction {
    if let uiApp { return .launchApp(uiApp) }
    return .openInBrowser(endpoint.baseURL)
  }
}

extension ProcessLiveness {
  /// When `pid` started, from the kernel's process table; nil when it is gone.
  public static func startDate(_ pid: Int32) -> Date? {
    var info = kinfo_proc()
    var size = MemoryLayout<kinfo_proc>.stride
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
    guard sysctl(&mib, u_int(mib.count), &info, &size, nil, 0) == 0, size > 0, info.kp_proc.p_pid == pid else {
      return nil
    }
    let start = info.kp_proc.p_un.__p_starttime
    return Date(timeIntervalSince1970: TimeInterval(start.tv_sec) + TimeInterval(start.tv_usec) / 1_000_000)
  }
}
