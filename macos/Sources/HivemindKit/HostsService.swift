import Foundation

// Hivemind Server.app's hosts (docs/remote-hosts.md#hosts): hosts.json, one HostConnection per host for the life of
// the app, the agent listener's port while at least one host exists, and the host catalog the server holds. The
// catalog (id, label, online) goes to the server over the signed launcher channel, as the usage probe's snapshots do;
// the SSH destination and the forwards never leave this app. With no host there is no connection, no agent listener
// and no catalog request: the app behaves as it did before hosts.

/// One host as the server's catalog holds it (`PUT /api/launcher/hosts`, src/shared/hosts.ts).
public struct HostCatalogEntry: Codable, Equatable, Sendable {
  public let id: String
  public let label: String
  /// The master answers and the remote runtime is this app's: the host can take launches.
  public let online: Bool

  public init(id: String, label: String, online: Bool) {
    self.id = id
    self.label = label
    self.online = online
  }
}

/// One host's line in the Hosts menu, and its detail.
public struct HostStatus: Equatable, Sendable {
  public let title: String
  public let detail: String?

  /// What the menu says of `connection`'s host at `now`.
  @MainActor public init(_ connection: HostConnection, now: Date) {
    let label = connection.host.label
    switch connection.state {
    case .stopped:
      title = "\(label) — off"
      detail = nil
    case .connecting:
      title = "\(label) — connecting…"
      detail = connection.lastError.map { "Last error: \($0)" }
    case .waitingToReconnect(_, let at, let reason):
      title = "\(label) — offline"
      let seconds = max(0, Int(at.timeIntervalSince(now).rounded(.up)))
      detail = "\(reason). Retrying in \(seconds) s."
    case .online:
      switch connection.runtime {
      case .unknown, .checking:
        title = "\(label) — online, checking the runtime…"
        detail = nil
      case .installing:
        title = "\(label) — online, installing the runtime…"
        detail = nil
      case .ready:
        title = "\(label) — online"
        detail = nil
      case .failed(let message):
        title = "\(label) — online, runtime failed"
        detail = message
      }
    }
  }
}

@MainActor
public final class HostsService {
  /// The agent listener's port on this Mac, and the forward's on each host (docs/remote-hosts.md#agent-listener).
  nonisolated public static let defaultAgentPort = ServerPort(7422)!
  nonisolated public static let catalogPath = "/api/launcher/hosts"
  /// The most hosts the catalog takes.
  nonisolated public static let maxHosts = 16

  /// The seams tests replace; `live` is what the app runs with.
  public struct Dependencies {
    public var transport: SSHTransport
    public var launcher: any ProcessLaunching
    public var runner: any SSHRunning
    public var scheduler: any Scheduling
    public var installer: any RemoteRuntimeInstalling
    public var http: any LauncherHTTP
    public var backoff: BackoffPolicy
    public var now: @Sendable () -> Date

    public init(transport: SSHTransport, launcher: any ProcessLaunching, runner: any SSHRunning, scheduler: any Scheduling,
                installer: any RemoteRuntimeInstalling, http: any LauncherHTTP, backoff: BackoffPolicy = HostConnection.backoff,
                now: @escaping @Sendable () -> Date = Date.init) {
      self.transport = transport; self.launcher = launcher; self.runner = runner; self.scheduler = scheduler
      self.installer = installer; self.http = http; self.backoff = backoff; self.now = now
    }

    #if os(macOS)
    /// `/usr/bin/ssh` with the app's environment (the server's secrets and HIVEMIND_* left out), the control sockets
    /// under `paths`, and the runtime of `server` as the copy each host gets.
    @MainActor public static func live(paths: HivemindPaths, server: BundledServer?) -> Dependencies {
      let environment = ProcessInfo.processInfo.environment.filter { !ServerLaunchSettings.dropped.contains($0.key) }
      let transport = SSHTransport(environment: environment, controlFolder: SSHTransport.controlFolder(paths: paths))
      let runner = SSHProcessRunner()
      return Dependencies(transport: transport, launcher: FoundationProcessLauncher(), runner: runner,
                          scheduler: MainQueueScheduler(),
                          installer: RemoteRuntimeInstaller(runtime: { RemoteRuntime(server: server) }, transport: transport, runner: runner),
                          http: URLSessionLauncherHTTP())
    }
    #endif
  }

  public private(set) var hosts: [RemoteHost] = []
  /// Why hosts.json could not be read: no host is connected, and none can be added or removed until it is moved away.
  public private(set) var loadError: String?
  public var onChange: (@MainActor () -> Void)?
  /// The agent port went from nil to a port or back: the server must restart with or without its agent listener.
  public var onAgentPortChange: (@MainActor () -> Void)?

  private let store: RemoteHostStore
  private let server: @MainActor () -> LauncherService.Server?
  private let deps: Dependencies
  private let port: ServerPort
  private let log: (@MainActor (String) -> Void)?
  private var connections: [String: HostConnection] = [:]
  private var running = false
  /// The server the catalog went to last, and what it holds: nil until a catalog reached it.
  private var postedServer: LauncherService.Server?
  private var postedCatalog: [HostCatalogEntry]?
  private var posting: Task<Void, Never>?
  private var postAgain = false
  /// The wait before a retry, and the server it retries: a new server ends it at once.
  private var retryWait: (server: LauncherService.Server, task: Task<Void, Never>)?

  public init(store: RemoteHostStore, server: @escaping @MainActor () -> LauncherService.Server?, dependencies: Dependencies,
              agentPort: ServerPort = HostsService.defaultAgentPort, log: (@MainActor (String) -> Void)? = nil) {
    self.store = store
    self.server = server
    self.deps = dependencies
    self.port = agentPort
    self.log = log
    do {
      hosts = try store.load()
    } catch {
      loadError = error.message
      log?("[hosts] \(error.message)")
    }
    for host in hosts { connections[host.id] = connection(for: host) }
  }

  // MARK: State

  /// The port the server's agent listener binds: only while at least one host is configured.
  public var agentPort: ServerPort? { hosts.isEmpty ? nil : port }

  public var canAdd: Bool { loadError == nil && hosts.count < Self.maxHosts }

  public func status(of host: RemoteHost) -> HostStatus? {
    connections[host.id].map { HostStatus($0, now: deps.scheduler.now()) }
  }

  public func connection(_ id: String) -> HostConnection? { connections[id] }

  /// The menu's summary line, or nil with no host.
  public var summary: String? {
    guard !hosts.isEmpty else { return nil }
    let online = hosts.filter { connections[$0.id]?.isReady == true }.count
    return hosts.count == 1 ? "Host \(hosts[0].label): \(online == 1 ? "online" : "offline")" : "Hosts: \(online) of \(hosts.count) online"
  }

  /// What the server's catalog should hold, in the order of hosts.json.
  public var catalog: [HostCatalogEntry] {
    hosts.map { HostCatalogEntry(id: $0.id, label: $0.label, online: connections[$0.id]?.isReady == true) }
  }

  // MARK: Lifecycle

  /// Connects every host; added hosts connect at once from now on.
  public func start() {
    running = true
    for host in hosts { connections[host.id]?.start() }
  }

  /// Ends every master. `completion` runs once all are gone.
  public func stop(completion: (@MainActor () -> Void)? = nil) {
    running = false
    posting?.cancel()
    let all = Array(connections.values)
    var left = all.count
    guard left > 0 else { completion?(); return }
    for connection in all {
      connection.stop {
        left -= 1
        if left == 0 { completion?() }
      }
    }
  }

  /// The supervisor's state changed: a new server holds no catalog yet, so it gets the current one.
  public func serverChanged() {
    if let retryWait, retryWait.server != server() { retryWait.task.cancel() }
    schedulePost()
  }

  // MARK: Changes

  /// Saves `host` and connects it. The first host turns the agent listener on.
  public func add(_ host: RemoteHost) throws(BrokerFiles.Failure) {
    if let loadError { throw .init(loadError) }
    try host.validate()
    guard hosts.count < Self.maxHosts else { throw .init("Hivemind takes at most \(Self.maxHosts) hosts") }
    guard !hosts.contains(where: { $0.id == host.id }) else { throw .init("This host is already configured") }
    let wasEmpty = hosts.isEmpty
    try store.save(hosts + [host])
    hosts.append(host)
    log?("[hosts] added \(host.label)")
    let connection = connection(for: host)
    connections[host.id] = connection
    if running { connection.start() }
    if wasEmpty { onAgentPortChange?() }
    changed()
  }

  /// Forgets the host and ends its master. Agents running there keep running in its tmux, and its runtime stays. The
  /// last host turns the agent listener off.
  public func remove(_ id: String) throws(BrokerFiles.Failure) {
    if let loadError { throw .init(loadError) }
    guard let host = hosts.first(where: { $0.id == id }) else { return }
    let remaining = hosts.filter { $0.id != id }
    try store.save(remaining)
    hosts = remaining
    log?("[hosts] removed \(host.label)")
    connections.removeValue(forKey: id)?.stop()
    if hosts.isEmpty { onAgentPortChange?() }
    changed()
  }

  /// Reconnect in the menu: a new master now, the backoff reset.
  public func reconnect(_ id: String) {
    guard running else { return }
    connections[id]?.reconnect()
  }

  // MARK: Catalog

  /// Sends the catalog when the server's differs: none when there is no host and the server never got one, as before
  /// hosts. Exposed for fake HTTP tests; a live run uses the same path.
  public func postCatalogOnce() async throws {
    guard let current = server() else { return }
    if postedServer != current {
      postedServer = current
      postedCatalog = nil
    }
    let catalog = self.catalog
    guard catalog != postedCatalog, !(catalog.isEmpty && postedCatalog == nil) else { return }
    guard await deps.http.verifies(current), server() == current else { throw BrokerFiles.Failure("hosts server verification failed") }
    struct Body: Encodable { let hosts: [HostCatalogEntry] }
    let body = try JSONEncoder().encode(Body(hosts: catalog))
    let (status, _) = try await deps.http.signed(current, method: "PUT", path: Self.catalogPath, body: body, timeout: 5, now: deps.now())
    guard status == 200 else { throw BrokerFiles.Failure("hosts catalog HTTP \(status)") }
    if postedServer == current { postedCatalog = catalog }
  }

  /// Waits for the catalog post and every connection's steps in flight. For tests.
  public func settle() async {
    repeat {
      for connection in connections.values { await connection.settle() }
      await posting?.value
    } while posting != nil || connections.values.contains { $0.hasPendingWork }
  }

  /// One post at a time; a change while one is out sends again after it. A failed post is retried after 2 s,
  /// doubling to a minute, while the server stays the same; a new server ends the retries and gets the catalog at
  /// once, also when it comes up while a post to the old one is still out. A stop ends them too.
  private func schedulePost() {
    guard posting == nil else { postAgain = true; return }
    posting = Task { [weak self] in
      var delay: Duration = .seconds(2)
      while !Task.isCancelled {
        guard let self else { return }
        self.postAgain = false
        guard let current = self.server() else { break }
        do {
          try await self.postCatalogOnce()
          if !self.postAgain { break }
        } catch {
          if self.server() != current {
            guard self.server() != nil else { break }
            delay = .seconds(2)
            continue
          }
          self.log?("[hosts] the catalog did not reach the server (\(error.localizedDescription)); retrying")
          await self.waitToRetry(delay, server: current)
          delay = self.server() == current ? min(delay * 2, .seconds(60)) : .seconds(2)
        }
      }
      self?.posting = nil
    }
  }

  /// Sleeps `delay` before a retry to `server`, cut short by a new server (serverChanged) or a stop.
  private func waitToRetry(_ delay: Duration, server: LauncherService.Server) async {
    let wait = Task<Void, Never> { try? await Task.sleep(for: delay) }
    retryWait = (server, wait)
    await withTaskCancellationHandler { await wait.value } onCancel: { wait.cancel() }
    retryWait = nil
  }

  private func connection(for host: RemoteHost) -> HostConnection {
    let connection = HostConnection(host: host, transport: deps.transport, launcher: deps.launcher, runner: deps.runner,
                                    scheduler: deps.scheduler, installer: deps.installer, agentPort: port, backoff: deps.backoff)
    connection.onChange = { [weak self] in self?.changed() }
    connection.onLog = { [weak self] in self?.log?($0) }
    return connection
  }

  private func changed() {
    schedulePost()
    onChange?()
  }
}
