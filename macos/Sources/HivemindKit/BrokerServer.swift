import Foundation

/// The terminal broker's logic: authentication, the tmux calls behind every
/// request, the session list poll, and each stream's PTY with its output
/// batching and backpressure. It owns no socket, process or PTY itself:
/// those come in through BrokerIO's seams, so all of it is tested with
/// fakes. Hivemind Server.app runs one, on the main actor, for the life of
/// the app. docs/terminal-broker.md describes the protocol it serves.
@MainActor
public final class TerminalBroker {
  /// The seams tests replace; Hivemind Server.app passes the real ones.
  public struct Dependencies {
    public var tmux: any TmuxRunning
    public var terminals: any BrokerTerminalSpawning
    public var scheduler: any Scheduling
    /// TmuxLocator().locate in the app.
    public var locateTmux: () -> String?
    /// Whether a launch's folder exists and is a directory.
    public var isDirectory: (String) -> Bool
    /// The app's own environment, which BrokerEnvironment trims for tmux.
    public var environment: [String: String]
    /// How often the session list is polled while nobody subscribes (for the
    /// menu's count); `BrokerLimits.sessionsPollInterval` while somebody does.
    public var idlePollInterval: TimeInterval
    /// Where launch secrets and environment variables go on their way to a
    /// session's shell; nil: a launch that carries any fails, rather than
    /// start without them.
    public var secrets: LaunchSecretStore?
    /// Where worker template secrets are kept (the Keychain in the app); nil:
    /// secrets.* requests are answered with an error.
    public var templateSecrets: (any TemplateSecretVault)?
    /// The Mac's home, which a launch's `~/` account paths are expanded with.
    public var home: String
    /// Builds an account's own directory before a session runs under it;
    /// NoShadowHomes by default; Server.app gives FileShadowHomes (docs/accounts.md).
    public var shadowHomes: any ShadowHomePreparing
    /// Where a Claude launch with an account records its status line (docs/accounts.md, "Claude status-line tap");
    /// nil by default: no tap, and the launch runs as before. Server.app gives HivemindPaths.accounts.
    public var claudeTap: ClaudeStatusTap?
    /// A process's start time as `TZ=UTC LC_ALL=C ps -o lstart=` prints it, which tells a live Claude session from a
    /// reused pid (ClaudeLiveSessions.systemProcessStart unless a test says otherwise).
    public var processStart: (Int32) -> String?
    /// The remote hosts (docs/remote-hosts.md#launch): launches with a `host` go there, and their sessions are listed
    /// and killed there. Nil by default: no host, and the broker does exactly what it did before hosts. Server.app
    /// gives HostsService.
    public var remoteHosts: (any BrokerRemoteHosts)?
    /// The `origin` of a project folder on this Mac (`git remote get-url origin`), which a host that lacks the folder
    /// clones; nil when it has none. Asked only for a launch on a host.
    public var originURL: @MainActor (String) async -> String?
    /// Where the host scripts look for tmux (RemoteTmuxLookup.standard; the tests give a fake).
    public var remoteTmux: RemoteTmuxLookup
    /// This Mac's side of the same-account check of a launch or a Prepare on a host (docs/remote-hosts.md#accounts);
    /// nil: an account cannot launch on a host. Server.app gives LocalAccountIdentity.
    public var accountIdentity: (any AccountIdentityReading)?
    /// How a host runs `codex app-server` for that check (RemoteCodexLookup.standard; the tests give a fake).
    public var remoteCodex: RemoteCodexLookup
    /// Never given a secret or a variable's value: the broker logs names,
    /// counts and paths only.
    public var log: (String) -> Void

    public init(
      tmux: any TmuxRunning, terminals: any BrokerTerminalSpawning, scheduler: any Scheduling,
      locateTmux: @escaping () -> String?, isDirectory: @escaping (String) -> Bool,
      environment: [String: String], idlePollInterval: TimeInterval = 15, secrets: LaunchSecretStore? = nil,
      templateSecrets: (any TemplateSecretVault)? = nil, home: String = HivemindPaths.userHome.path,
      shadowHomes: any ShadowHomePreparing = NoShadowHomes(), claudeTap: ClaudeStatusTap? = nil,
      processStart: @escaping (Int32) -> String? = ClaudeLiveSessions.systemProcessStart,
      remoteHosts: (any BrokerRemoteHosts)? = nil, originURL: @escaping @MainActor (String) async -> String? = { _ in nil },
      remoteTmux: RemoteTmuxLookup = .standard, accountIdentity: (any AccountIdentityReading)? = nil,
      remoteCodex: RemoteCodexLookup = .standard, log: @escaping (String) -> Void = { _ in }
    ) {
      self.tmux = tmux
      self.terminals = terminals
      self.scheduler = scheduler
      self.locateTmux = locateTmux
      self.isDirectory = isDirectory
      self.environment = environment
      self.idlePollInterval = idlePollInterval
      self.secrets = secrets
      self.templateSecrets = templateSecrets
      self.home = home
      self.shadowHomes = shadowHomes
      self.claudeTap = claudeTap
      self.processStart = processStart
      self.remoteHosts = remoteHosts
      self.originURL = originURL
      self.remoteTmux = remoteTmux
      self.accountIdentity = accountIdentity
      self.remoteCodex = remoteCodex
      self.log = log
    }
  }

  public let token: BrokerToken
  /// HivemindPaths.tmuxConfig, which BrokerFiles wrote.
  public let configPath: String
  /// Called after anything the menu shows changed.
  public var onChange: (@MainActor () -> Void)?
  /// Server.app signs a Human's native approval after the verified page or
  /// paired device sends it through this broker. Nil in tests/other hosts.
  public var launcherDecision: (@MainActor (String, TemplateID?, Bool) async -> Result<Void, BrokerProtocolError>)?

  public private(set) var isRunning = false
  /// Where tmux was found last; looked up again on every hello.
  public private(set) var tmuxPath: String?
  /// The last good session list; nil until the first one.
  public private(set) var sessions: [BrokerSession]?

  let deps: Dependencies
  let tmuxEnvironment: [String: String]
  let attachEnvironment: [String: String]
  private var connections: [BrokerConnection] = []
  private var pollTimer: (any Cancellable)?
  private var polling: Task<Result<[BrokerSession], BrokerProtocolError>, Never>?
  private var pollAgain = false
  private var tasks: [Int: Task<Void, Never>] = [:]
  private var nextTaskID = 0
  /// The launch running now, which the next one waits for (`launching`).
  private var lastLaunch: Task<Void, Never>?
  /// Every Claude account a launch, a Prepare or the catalog (`learnClaudeAccounts`) named since the broker started,
  /// newest last, one per directory. The broker never reads the catalog itself, so these are the shadows whose live
  /// sessions it can see (ClaudeLiveSessions); after a restart an account counts again from the usage probe's first
  /// read of the catalog, or its next launch or Prepare.
  private(set) var claudeAccounts: [LaunchAccount] = []
  /// More than the catalog holds (8 per driver), so an edited path keeps its old directory for a while.
  static let maxClaudeAccounts = 32
  /// Each remote host's last probe and sessions, by host id (BrokerRemote.swift).
  var remoteListings: [String: RemoteListing] = [:]
  /// Each remote host's list running now, by host id (`listInBackground`).
  var remoteProbes: [String: RemoteProbeTask] = [:]
  var nextRemoteProbe = 0
  /// The Codex accounts found the same on a host and here, with the two login files' stamps then: a new login on
  /// either side asks `account/read` again (docs/remote-hosts.md#accounts).
  var matchedCodexLogins: [String: String] = [:]

  public init(token: BrokerToken, configPath: String, dependencies: Dependencies) {
    self.token = token
    self.configPath = configPath
    self.deps = dependencies
    tmuxEnvironment = BrokerEnvironment.tmux(from: dependencies.environment)
    attachEnvironment = BrokerEnvironment.attach(from: dependencies.environment)
  }

  // MARK: Lifecycle

  public func start() {
    guard !isRunning else { return }
    isRunning = true
    _ = relocateTmux()
    deps.log("[broker] started; tmux: \(tmuxPath ?? "not found")")
    sweepSecrets()
    refreshSoon()
    onChange?()
  }

  /// Closes every connection and hangs up every PTY child. tmux and its
  /// sessions keep running: the agents in them are not the app's to stop.
  public func stop() {
    guard isRunning else { return }
    isRunning = false
    pollTimer?.cancel()
    pollTimer = nil
    for connection in connections { connection.close() }
    connections.removeAll()
    deps.log("[broker] stopped")
    onChange?()
  }

  /// A new client. Nil (and the transport closed) when the broker is not
  /// running or already serves `BrokerLimits.maxConnections`.
  @discardableResult
  public func accept(_ transport: any BrokerTransport) -> BrokerConnection? {
    guard isRunning, connections.count < BrokerLimits.maxConnections else {
      transport.close()
      return nil
    }
    let connection = BrokerConnection(broker: self, transport: transport)
    connections.append(connection)
    return connection
  }

  public var connectionCount: Int { connections.count }
  public var streamCount: Int { connections.reduce(0) { $0 + $1.streamCount } }

  public var status: BrokerStatus {
    BrokerStatus(state: isRunning ? .listening : .stopped, tmuxPath: tmuxPath,
                 sessionCount: sessions?.count, streamCount: streamCount)
  }

  /// Waits until nothing the broker started is still running: for tests,
  /// whose fakes answer at once.
  public func settle() async {
    while let task = tasks.values.first { await task.value }
  }

  // MARK: For connections

  var tmux: TmuxCommand? { tmuxPath.map { TmuxCommand(executable: $0, configPath: configPath) } }

  func relocateTmux() -> String? {
    let found = deps.locateTmux()
    if found != tmuxPath {
      tmuxPath = found
      onChange?()
    }
    return found
  }

  func run(_ tmux: TmuxCommand, _ arguments: [String]) async -> TmuxResult {
    await deps.tmux.run(executable: tmux.executable, arguments: arguments, environment: tmuxEnvironment)
  }

  /// Runs `work` as a task `settle()` waits for.
  @discardableResult
  func track(_ work: @escaping @MainActor () async -> Void) -> Task<Void, Never> {
    let id = nextTaskID
    nextTaskID += 1
    // The task cannot start before this returns: both are on the main actor.
    let task = Task { @MainActor [weak self] in
      await work()
      self?.tasks[id] = nil
    }
    tasks[id] = task
    return task
  }

  /// Runs `work` once every launch before it, from any connection, is done.
  /// A launch lists the sessions, picks names (the lowest free
  /// hm-<project>-new-<n>) and creates them; two at once would pick the same
  /// name, and the second would take the first one's session as its own.
  func launching(_ work: @escaping @MainActor () async -> Void) async {
    let previous = lastLaunch
    let task = Task { @MainActor in
      await previous?.value
      await work()
    }
    lastLaunch = task
    await task.value
    if lastLaunch == task { lastLaunch = nil }
  }

  /// Remembers the catalog's Claude accounts for the live-session check, as a launch or a Prepare would: Hivemind
  /// Server.app's usage probe passes them at start and on each refresh (UsageProbeService). Any other account is ignored.
  public func learnClaudeAccounts(_ accounts: [LaunchAccount]) {
    for account in accounts { noteClaudeAccount(account) }
  }

  /// Remembers a Claude account's directory for the live-session check; any other account is ignored.
  func noteClaudeAccount(_ account: LaunchAccount) {
    guard account.driver == .claude else { return }
    let directory = ClaudeLiveSessions.directory(of: account, home: deps.home)
    claudeAccounts.removeAll { ClaudeLiveSessions.directory(of: $0, home: deps.home) == directory }
    claudeAccounts.append(account)
    if claudeAccounts.count > Self.maxClaudeAccounts { claudeAccounts.removeFirst(claudeAccounts.count - Self.maxClaudeAccounts) }
  }

  /// Deletes launch secret files no session read within LaunchSecretStore.maxAge.
  func sweepSecrets() {
    guard let store = deps.secrets else { return }
    let removed = store.sweep()
    if removed > 0 { deps.log("[broker] removed \(removed) unread launch secret file(s)") }
  }

  func removed(_ connection: BrokerConnection) {
    let before = connections.count
    connections.removeAll { $0 === connection }
    if connections.count != before { onChange?() }
  }

  /// A stream came or went: tmux's attached counts moved.
  func streamsChanged() {
    onChange?()
    refreshSoon()
  }

  func subscriptionsChanged() {
    schedulePoll()
  }

  // MARK: Sessions

  /// Every Hivemind session, or why tmux could not list them. No tmux server
  /// yet means no sessions, and so does no tmux at all. With remote hosts, each
  /// ready host's sessions follow, as current as `remote` asks (the poll's are
  /// the last lists, so a slow host never holds up this Mac's).
  func listSessions(remote: RemoteListingNeed = .cached) async -> Result<[BrokerSession], BrokerProtocolError> {
    let local = await listLocalSessions()
    guard deps.remoteHosts != nil, case .success(let sessions) = local else { return local }
    return .success((sessions + (await remoteSessions(remote))).sorted { $0.name < $1.name })
  }

  /// This Mac's sessions.
  func listLocalSessions() async -> Result<[BrokerSession], BrokerProtocolError> {
    guard let tmux else { return .success([]) }
    let result = await run(tmux, tmux.listSessions())
    if result.succeeded { return .success(TmuxCommand.parseSessions(result.stdout)) }
    if TmuxCommand.isNoServer(stderr: result.stderr) { return .success([]) }
    return .failure(BrokerProtocolError(.tmuxFailed, result.firstErrorLine))
  }

  /// Lists the sessions now (joining a list already running) and pushes the
  /// list to every subscriber when it changed.
  func refresh() async -> Result<[BrokerSession], BrokerProtocolError> {
    if let polling { return await polling.value }
    let task = Task { @MainActor [weak self] () -> Result<[BrokerSession], BrokerProtocolError> in
      guard let self else { return .success([]) }
      if self.tmuxPath == nil { _ = self.relocateTmux() }
      let result = await self.listSessions()
      if case .success(let list) = result { self.publish(list) }
      if case .failure(let error) = result { self.deps.log("[broker] list-sessions failed: \(error.message)") }
      return result
    }
    polling = task
    let result = await task.value
    polling = nil
    if pollAgain {
      pollAgain = false
      refreshSoon()
    } else {
      schedulePoll()
    }
    return result
  }

  /// A refresh after something changed the sessions (a launch, a kill, a
  /// stream). One already running may have listed too early, so it runs again.
  func refreshSoon() {
    guard isRunning else { return }
    if polling != nil {
      pollAgain = true
      return
    }
    track { [weak self] in _ = await self?.refresh() }
  }

  private func publish(_ list: [BrokerSession]) {
    guard list != sessions else { return }
    sessions = list
    for connection in connections where connection.isSubscribed { connection.push(list) }
    onChange?()
  }

  private func schedulePoll() {
    guard isRunning else { return }
    pollTimer?.cancel()
    let interval = connections.contains(where: \.isSubscribed) ? BrokerLimits.sessionsPollInterval : deps.idlePollInterval
    pollTimer = deps.scheduler.schedule(after: interval) { [weak self] in
      self?.pollTimer = nil
      self?.refreshSoon()
    }
  }
}

/// Whether a Codex thread is open in another process (docs/accounts.md, "Live sessions"). An open thread holds an
/// exclusive flock on `<shared home>/thread-writer-locks/<id>.lock`; the probe is Codex's own, under its
/// `.coordination.lock`. Only `resume <id>` in a Codex launch is checked: `--last` and names are not, and `fork` never is.
/// Codex refuses a second writer by itself, so this only makes the refusal clearer.
public struct CodexThreadLock {
  /// The folder Codex keeps its writer locks in.
  public let directory: String

  public init(home: String) {
    directory = home + "/thread-writer-locks"
  }

  /// The thread a launch command resumes by id (`codex resume <uuid>`, `codex exec resume <uuid>`), or nil. The command
  /// must name Codex: `claude --resume <uuid>` is not checked.
  public static func resumedThread(in command: String) -> String? {
    let words = command.split(whereSeparator: \.isWhitespace)
    guard words.contains(where: { $0 == "codex" || $0.hasSuffix("/codex") }) else { return nil }
    let uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/
    return zip(words, words.dropFirst()).first { $0.0 == "resume" && $0.1.wholeMatch(of: uuid) != nil }.map { String($0.1) }
  }

  /// The shared Codex home a launch's threads live in: its Codex account's `homePath` (empty: ~/.codex), with a leading
  /// `~/` expanded with `home`, compared by scalar as LaunchAccount does. A launch with no Codex account uses ~/.codex.
  public static func sharedHome(for account: LaunchAccount?, home: String) -> String {
    var path = LaunchAccount.Driver.codex.defaultHome
    if let account, account.driver == .codex, !account.homePath.isEmpty { path = account.homePath }
    guard path.unicodeScalars.starts(with: "~/".unicodeScalars) else { return path }
    return (home.hasSuffix("/") ? String(home.dropLast()) : home) + String(path.unicodeScalars.dropFirst())
  }

  /// True while another process holds the thread's lock. False when none does, or when the folder is missing (no thread
  /// is open in it). Throws when a file cannot be opened or locked, so the launch is refused rather than run unchecked.
  /// Both files are close-on-exec: a child spawned meanwhile must not inherit, and keep, either lock.
  public func isOpen(_ id: String) throws -> Bool {
    let coordinationPath = directory + "/.coordination.lock"
    let coordination = open(coordinationPath, O_RDWR | O_CREAT | O_CLOEXEC, 0o600)
    if coordination < 0 {
      if errno == ENOENT { return false }
      throw Self.failure(coordinationPath, errno)
    }
    defer { close(coordination) }
    guard flock(coordination, LOCK_EX) == 0 else { throw Self.failure(coordinationPath, errno) }
    let threadPath = directory + "/\(id).lock"
    let thread = open(threadPath, O_RDWR | O_CLOEXEC)
    if thread < 0 {
      if errno == ENOENT { return false }
      throw Self.failure(threadPath, errno)
    }
    defer { close(thread) }
    if flock(thread, LOCK_EX | LOCK_NB) == 0 {
      flock(thread, LOCK_UN)
      return false
    }
    guard errno == EWOULDBLOCK else { throw Self.failure(threadPath, errno) }
    return true
  }

  private static func failure(_ path: String, _ code: Int32) -> BrokerProtocolError {
    BrokerProtocolError(.internal, "Cannot check `\(path)`: \(String(cString: strerror(code)))")
  }
}

/// One client of the broker, whatever transport carries it. The transport
/// reports its bytes here; everything the broker answers goes back through
/// the transport's `send`.
///
/// Requests that run tmux (list, subscribe, launch, attach, kill) are taken
/// one at a time in the order they came, so their answers do too. `hello`,
/// `input`, `resize` and `detach` are handled at once: keystrokes never wait
/// behind a slow launch.
@MainActor
public final class BrokerConnection {
  private weak var broker: TerminalBroker?
  private let transport: any BrokerTransport
  public private(set) var isOpen = true
  public private(set) var isAuthenticated = false
  public private(set) var isSubscribed = false
  /// The label the client gave in hello.
  public private(set) var client: String?

  private var reader = BrokerLineReader(limit: BrokerLimits.maxRequestBytes)
  private var output = BrokerOutputBuffer()
  private var streams: [BrokerStreamID: Stream] = [:]
  private var nextStream: BrokerStreamID = 1
  private var helloTimer: (any Cancellable)?
  private var flushTimer: (any Cancellable)?
  private var queue: Task<Void, Never>?
  private var waiting = 0

  /// Requests waiting their turn; more are refused rather than queued.
  public static let maxWaitingRequests = 64
  /// Unsent bytes past which the client is taken to have stopped reading
  /// and is closed. Output stops at `BrokerLimits.maxOutboundBytes`; this
  /// bounds everything else.
  public static let maxUnsentBytes = BrokerLimits.maxOutboundBytes + 2 * BrokerLimits.maxEventBytes

  private final class Stream {
    let session: SessionName
    let terminal: any BrokerTerminal
    init(session: SessionName, terminal: any BrokerTerminal) {
      self.session = session
      self.terminal = terminal
    }
  }

  init(broker: TerminalBroker, transport: any BrokerTransport) {
    self.broker = broker
    self.transport = transport
    helloTimer = broker.deps.scheduler.schedule(after: BrokerLimits.helloTimeout) { [weak self] in
      guard let self, self.isOpen, !self.isAuthenticated else { return }
      self.fail(BrokerProtocolError(.unauthorized, "no hello within \(Int(BrokerLimits.helloTimeout)) s"))
    }
  }

  public var streamCount: Int { streams.count }
  public var bufferedBytes: Int { output.buffered }
  public var isReadingPaused: Bool { output.paused }

  // MARK: Transport events

  /// Bytes the client sent.
  public func received(_ data: Data) {
    guard isOpen else { return }
    let lines: [Data]
    do { lines = try reader.append(data) } catch {
      fail(error)
      return
    }
    for line in lines {
      guard isOpen else { return }
      let frame: BrokerRequestFrame
      do { frame = try BrokerRequestFrame.decode(line) } catch {
        if !isAuthenticated {
          fail(BrokerProtocolError(.unauthorized, "the first message must be a valid hello"))
        } else if error.closesConnection {
          fail(error)
        } else {
          send(.error(error))
        }
        continue
      }
      handle(frame)
    }
  }

  /// The transport wrote `count` of the bytes it was given.
  public func wrote(_ count: Int) {
    guard isOpen else { return }
    output.wrote(count)
    applyBackpressure()
  }

  /// The client went away (or the transport failed). Its streams are
  /// detached; the sessions keep running.
  public func closed() {
    shutDown(closeTransport: false)
  }

  /// Closes from the broker's side, after what is queued is written.
  public func close() {
    shutDown(closeTransport: true)
  }

  // MARK: Requests

  private func handle(_ frame: BrokerRequestFrame) {
    let id = frame.id
    guard isAuthenticated else {
      guard case .hello(let version, let token, let client) = frame.request else {
        fail(BrokerProtocolError(.unauthorized, "the first message must be hello"), id: id)
        return
      }
      hello(version: version, token: token, client: client, id: id)
      return
    }
    switch frame.request {
    case .hello:
      send(.error(BrokerProtocolError(.badMessage, "hello: already said")), id: id)
    case .input(let stream, let data):
      input(stream, data, id: id)
    case .resize(let stream, let size):
      guard let entry = streams[stream] else { return noSuchStream(stream, id: id) }
      entry.terminal.resize(size)
    case .detach(let stream):
      detach(stream, id: id)
    case .secretsList(let template):
      templateSecrets(template, id: id) { _ in }
    case .secretsSet(let template, let name, let value):
      templateSecrets(template, id: id) { vault throws(BrokerProtocolError) in
        let names = try Self.vaultCall { () throws(BrokerFiles.Failure) in try vault.names(for: template) }
        guard names.contains(name) || names.count < TemplateSecrets.maxNames else {
          throw BrokerProtocolError.invalid("name", "a template holds at most \(TemplateSecrets.maxNames) secrets")
        }
        try Self.vaultCall { () throws(BrokerFiles.Failure) in try vault.set(value, name: name, for: template) }
        broker?.deps.log("[broker] template \(template): set secret \(name)")
      }
    case .secretsDelete(let template, let name):
      templateSecrets(template, id: id) { vault throws(BrokerProtocolError) in
        try Self.vaultCall { () throws(BrokerFiles.Failure) in try vault.delete(name: name, for: template) }
        broker?.deps.log("[broker] template \(template): deleted \(name.map { "secret \($0)" } ?? "every secret")")
      }
    case .accountPrepare(let account, nil):
      prepareAccount(account, id: id)
    case .accountPrepare(let account, let host?):
      // Over SSH, maybe with a copy of plugins: in a task of its own, so this connection's other requests go on.
      guard let broker else { return }
      broker.track { [weak self, weak broker] in
        guard let broker else { return }
        let preparation = await broker.prepareOnHost(account, host: host)
        self?.send(.accountPrepared(preparation), id: id)
      }
    case .conversationsFind(let host, let agents):
      guard let broker else { return }
      broker.track { [weak self, weak broker] in
        guard let broker else { return }
        self?.reply(await broker.conversationsOnHost(host, agents: agents).map { .conversations($0) }, id: id)
      }
    case .sessionsList, .sessionsSubscribe, .sessionsUnsubscribe, .launch, .attach, .kill, .attachCommand,
         .launcherApprove, .launcherReject:
      enqueue(frame)
    }
  }

  /// Runs `change` on the vault, then answers with the template's names (or the error, which never holds a value).
  private func templateSecrets(
    _ template: TemplateID, id: String?, _ change: (any TemplateSecretVault) throws(BrokerProtocolError) -> Void
  ) {
    guard let vault = broker?.deps.templateSecrets else {
      return send(.error(BrokerProtocolError(.internal, "this broker cannot keep template secrets")), id: id)
    }
    do {
      try change(vault)
      let names = try Self.vaultCall { () throws(BrokerFiles.Failure) in try vault.names(for: template) }
      send(.secrets(template: template, names: names), id: id)
    } catch {
      if error.code == .internal { broker?.deps.log("[broker] template \(template): \(error.message)") }
      send(.error(error), id: id)
    }
  }

  /// The Accounts sheet's Prepare, answered at once (it runs no tmux): the
  /// account's directory is built before its login, and the answer says
  /// whether it is logged in, or names what is wrong and its fix.
  private func prepareAccount(_ account: LaunchAccount, id: String?) {
    guard let broker else { return }
    broker.noteClaudeAccount(account)
    let preparation = broker.deps.shadowHomes.prepareForLogin(account, home: broker.deps.home)
    let outcome = preparation.error ?? (preparation.loggedIn ? "ready" : "not logged in")
    broker.deps.log("[broker] account \(account.id) (\(account.driver.rawValue)): prepare: \(outcome)")
    send(.accountPrepared(preparation), id: id)
  }

  private static func vaultCall<T>(_ work: () throws(BrokerFiles.Failure) -> T) throws(BrokerProtocolError) -> T {
    do { return try work() } catch { throw BrokerProtocolError(.internal, error.message) }
  }

  private func enqueue(_ frame: BrokerRequestFrame) {
    guard let broker else { return }
    guard waiting < Self.maxWaitingRequests else {
      send(.error(BrokerProtocolError(.internal, "too many requests waiting; try again")), id: frame.id)
      return
    }
    waiting += 1
    let previous = queue
    queue = broker.track { [weak self] in
      await previous?.value
      guard let self else { return }
      defer { self.waiting -= 1 }
      guard self.isOpen else { return }
      await self.perform(frame)
    }
  }

  private func perform(_ frame: BrokerRequestFrame) async {
    let id = frame.id
    switch frame.request {
    case .sessionsList:
      // A one-off list (the launcher's among them) waits for hosts whose last list is old; the poll never does.
      if let broker, broker.deps.remoteHosts != nil { _ = await broker.remoteSessions(.due) }
      guard let result = await broker?.refresh() else { return }
      reply(result.map { .sessions($0) }, id: id)
    case .sessionsSubscribe:
      guard let result = await broker?.refresh() else { return }
      reply(result.map { .sessions($0) }, id: id)
      // Only now, so the refresh above did not push the same list first.
      if isOpen, !isSubscribed {
        isSubscribed = true
        broker?.subscriptionsChanged()
      }
    case .sessionsUnsubscribe:
      if isSubscribed {
        isSubscribed = false
        broker?.subscriptionsChanged()
      }
    case .launch(let launches):
      await launch(launches, id: id)
    case .attach(let session, let size):
      await attach(session, size: size, id: id)
    case .kill(let session):
      await kill(session, id: id)
    case .attachCommand(let session):
      await attachCommand(session, id: id)
    case .launcherApprove(let requestId, let templateId):
      await decide(requestId: requestId, templateId: templateId, approve: true, id: id)
    case .launcherReject(let requestId):
      await decide(requestId: requestId, templateId: nil, approve: false, id: id)
    case .hello, .input, .resize, .detach, .secretsList, .secretsSet, .secretsDelete, .accountPrepare, .conversationsFind:
      break
    }
  }

  private func decide(requestId: String, templateId: TemplateID?, approve: Bool, id: String?) async {
    guard let decision = broker?.launcherDecision else {
      return send(.error(BrokerProtocolError(.internal, "launcher approval is unavailable")), id: id)
    }
    switch await decision(requestId, templateId, approve) {
    case .success:
      send(.launcherDecided(requestId: requestId, action: approve ? "approve" : "reject"), id: id)
    case .failure(let error):
      send(.error(error), id: id)
    }
  }

  private func hello(version: Int, token: String, client: String?, id: String?) {
    guard let broker else { return }
    guard broker.token.matches(token) else {
      broker.deps.log("[broker] refused a client: wrong token")
      fail(BrokerProtocolError(.unauthorized, "wrong token"), id: id)
      return
    }
    guard let spoken = BrokerProtocol.negotiate(clientVersion: version) else {
      fail(BrokerProtocolError(
        .unsupportedVersion, "this broker speaks versions \(BrokerProtocol.minimumVersion)–\(BrokerProtocol.version)"), id: id)
      return
    }
    isAuthenticated = true
    helloTimer?.cancel()
    helloTimer = nil
    self.client = client
    let tmuxPath = broker.relocateTmux()
    broker.deps.log("[broker] client \(client ?? "(unnamed)") connected, protocol \(spoken)")
    send(.welcome(version: spoken, tmuxPath: tmuxPath), id: id)
  }

  static func tooLongForTmux(index: Int, bytes: Int) -> String {
    "launches[\(index)]: too long for tmux: its command, folder and title come to \(bytes) bytes, "
      + "more than the \(TmuxCommand.maxCommandLineBytes) a tmux command may take"
  }

  /// Why a Claude launch's folder overrides the account's login, or nil (docs/accounts.md, "Claude shadow"). Only
  /// `apiKeyHelper` and the key names of `env` are read, from `<cwd>/.claude/settings.json` and then
  /// `settings.local.json`; a missing or unreadable file is no check, and no value is read out. An `env` name counts
  /// when it matches one of the account's controlled names without case, as environmentConflict matches a launch's own.
  static func projectOverride(of account: LaunchAccount, cwd: String) -> String? {
    guard account.driver == .claude else { return nil }
    let settings = projectSettingsFiles(cwd: cwd).compactMap { path -> RemoteFacts.ProjectSettings? in
      guard let data = FileManager.default.contents(atPath: path),
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
      return RemoteFacts.ProjectSettings(path: path, apiKeyHelper: json["apiKeyHelper"].map { !($0 is NSNull) } ?? false,
                                         env: (json["env"] as? [String: Any])?.keys.sorted() ?? [])
    }
    return projectOverride(of: account, settings: settings)
  }

  /// The project's Claude settings files, in the order they are checked.
  static func projectSettingsFiles(cwd: String) -> [String] {
    ["settings.json", "settings.local.json"].map { (cwd.hasSuffix("/") ? String(cwd.dropLast()) : cwd) + "/.claude/" + $0 }
  }

  /// The same check on what was read of each settings file that parses, here or on a remote host
  /// (RemoteHostScripts.factsProgram): `apiKeyHelper` when it is set, else the first `env` name the account controls.
  static func projectOverride(of account: LaunchAccount, settings: [RemoteFacts.ProjectSettings]) -> String? {
    guard account.driver == .claude else { return nil }
    let controlled = Set(account.controlledNames)
    for file in settings {
      if let key = file.apiKeyHelper ? "apiKeyHelper" : file.env.first(where: { controlled.contains($0.uppercased()) }) {
        return "`\(file.path)` sets `\(key)`, which overrides the account `\(account.label)`. Remove it from that file."
      }
    }
    return nil
  }

  private func launch(_ launches: [BrokerLaunch], id: String?) async {
    guard let broker else { return }
    await broker.launching { [weak self] in await self?.launchNow(launches, id: id) }
  }

  /// One launch, never alongside another (TerminalBroker.launching).
  private func launchNow(_ launches: [BrokerLaunch], id: String?) async {
    guard isOpen, let broker else { return }
    // Launches that all go to remote hosts need no tmux here (docs/remote-hosts.md#launch).
    let localTmux = broker.tmux
    guard localTmux != nil || launches.allSatisfy({ $0.host != nil }) else { return send(.error(Self.tmuxMissing), id: id) }
    let running: [BrokerSession]
    // Names are unique across hosts, and an offline host's last sessions still count. Launches on a host list every
    // host now; launches all on this Mac take the last lists (each host's own launches and kills are in them), so a
    // slow host does not hold them up.
    switch await broker.listSessions(remote: launches.contains { $0.host != nil } ? .fresh : .asked) {
    case .success(let list): running = list + broker.offlineRemoteSessions
    case .failure(let error): return send(.error(error), id: id)
    }
    broker.sweepSecrets()
    var existing = Set(running.map(\.name))
    let names = BrokerLaunch.sessionNames(for: launches, existing: running)
    var results: [SessionName?] = []
    var created: [SessionName] = []
    var errors: [BrokerLaunchFailure] = []
    for (index, (launch, name)) in zip(launches, names).enumerated() {
      if existing.contains(name) {
        // Reused: nothing runs, so its secrets and variables (if any) are never written. A session on a host is
        // reused where it runs, whatever host the launch named.
        results.append(name)
        continue
      }
      if let host = launch.host {
        let outcome = await broker.launchOnHost(host, launch, name: name, index: index)
        results.append(outcome.started ? name : nil)
        if outcome.started { existing.insert(name) }
        if outcome.created { created.append(name) }
        if let failure = outcome.failure { errors.append(failure) }
        continue
      }
      guard let tmux = localTmux else {
        results.append(nil)
        errors.append(BrokerLaunchFailure(index: index, code: .tmuxMissing, message: TmuxLocator.installHint))
        continue
      }
      // With an account, a Codex thread another process has open is not resumed here (docs/accounts.md, "Live
      // sessions"); without one the launch runs as it always did. Checked before the launch file is written, so a
      // refused item leaves no secrets behind.
      if launch.account != nil, let thread = CodexThreadLock.resumedThread(in: launch.command) {
        do {
          let lock = CodexThreadLock(home: CodexThreadLock.sharedHome(for: launch.account, home: broker.deps.home))
          if try lock.isOpen(thread) {
            results.append(nil)
            let message = "Codex thread `\(thread)` is already open in another process. Close it there, or start a new session."
            errors.append(BrokerLaunchFailure(index: index, code: .internal, message: "launches[\(index)].command: \(message)"))
            continue
          }
        } catch {
          results.append(nil)
          errors.append(BrokerLaunchFailure(index: index, code: .internal, message: "launches[\(index)].command: \(error.localizedDescription)"))
          continue
        }
      }
      // Nor, with an account, is a Claude transcript (docs/accounts.md, "Live sessions"). Claude keeps its live sessions per config
      // directory, so every directory of the launch's shared tree the broker knows is read, this launch's own included.
      if let account = launch.account { broker.noteClaudeAccount(account) }
      if launch.account != nil, let resume = ClaudeLiveSessions.resumed(in: launch.command) {
        do {
          let directories = ClaudeLiveSessions.directories(for: launch.account, known: broker.claudeAccounts, home: broker.deps.home)
          if let holder = try ClaudeLiveSessions(processStart: broker.deps.processStart).holder(of: resume, cwd: launch.cwd, in: directories) {
            results.append(nil)
            let message = "Claude session `\(holder.sessionID)` is already open in another process (account `\(holder.label)`)."
            errors.append(BrokerLaunchFailure(index: index, code: .internal, message: "launches[\(index)].command: \(message)"))
            continue
          }
        } catch {
          results.append(nil)
          errors.append(BrokerLaunchFailure(index: index, code: .internal, message: "launches[\(index)].command: \(error.localizedDescription)"))
          continue
        }
      }
      // The account the session runs under (docs/accounts.md): its variables join the launch file, and the controlled
      // names it does not set are unset by the script. A conflict or a shadow that cannot be built fails only this item.
      var accountVariables: [(name: String, value: String)] = []
      var fileEnvironment = launch.environment
      var unsetNames: [String] = []
      // A Claude account's session records its status line (docs/accounts.md, "Claude status-line tap"). Its settings
      // file is written once every check has passed, below, and its variable goes in the launch file.
      let tap = launch.account?.driver == .claude && broker.deps.secrets != nil ? broker.deps.claudeTap : nil
      if let account = launch.account {
        if let message = account.environmentConflict(in: launch.environment, secretNames: launch.secrets?.names ?? []) {
          results.append(nil)
          errors.append(BrokerLaunchFailure(index: index, code: .badMessage, message: "launches[\(index)].account: \(message)"))
          continue
        }
        // A project's own settings outrank the login the same way (docs/accounts.md, "Claude shadow"). Checked before
        // anything is written, so a refused item leaves no launch file behind.
        if let message = Self.projectOverride(of: account, cwd: launch.cwd) {
          results.append(nil)
          errors.append(BrokerLaunchFailure(index: index, code: .badMessage, message: "launches[\(index)].account: \(message)"))
          continue
        }
        accountVariables = account.environment(home: broker.deps.home)
        unsetNames = account.controlledNames.filter { controlled in !accountVariables.contains { $0.name == controlled } }
        if !accountVariables.isEmpty {
          var values = launch.environment?.dictionary ?? [:]
          for variable in accountVariables { values[variable.name] = variable.value }
          do { fileEnvironment = try LaunchEnvironment(values) } catch {
            results.append(nil)
            errors.append(BrokerLaunchFailure(index: index, code: .badMessage, message: "launches[\(index)].account: \(error.message)"))
            continue
          }
        }
      }
      var environmentFile: LaunchEnvironmentFile?
      if launch.handsVariables || !accountVariables.isEmpty || tap != nil {
        guard let store = broker.deps.secrets else {
          results.append(nil)
          let message = launch.secrets != nil ? "launches[\(index)].secrets: this broker cannot pass secrets"
            : launch.environment != nil ? "launches[\(index)].environment: this broker cannot pass environment variables"
            : launch.template != nil ? "launches[\(index)].template: this broker cannot pass template secrets"
            : "launches[\(index)].account: this broker cannot pass account variables"
          errors.append(BrokerLaunchFailure(index: index, code: .internal, message: message))
          continue
        }
        environmentFile = store.file()
      }
      let arguments = tmux.newSession(TmuxNewSession(
        name: name, launch: launch, environmentFile: environmentFile, unsetNames: unsetNames))
      let bytes = TmuxCommand.commandLineBytes(arguments)
      guard bytes <= TmuxCommand.maxCommandLineBytes else {
        results.append(nil)
        errors.append(BrokerLaunchFailure(index: index, code: .badMessage, message: Self.tooLongForTmux(index: index, bytes: bytes)))
        continue
      }
      guard broker.deps.isDirectory(launch.cwd) else {
        results.append(nil)
        errors.append(BrokerLaunchFailure(index: index, code: .cwdMissing, message: "launches[\(index)].cwd: not a folder"))
        continue
      }
      // The template's secrets come from the vault here, never from the client.
      var templateSecrets: [String: String] = [:]
      if let template = launch.template, let vault = broker.deps.templateSecrets {
        do { templateSecrets = try vault.values(for: template) } catch {
          broker.deps.log("[broker] \(name): cannot read template \(template)'s secrets: \(error.message)")
          results.append(nil)
          errors.append(BrokerLaunchFailure(index: index, code: .internal, message: "launches[\(index)].template: \(error.message)"))
          continue
        }
        if !templateSecrets.isEmpty { broker.deps.log("[broker] \(name): template secrets \(templateSecrets.keys.sorted())") }
      }
      // The vault's names are known only now; the shadow is built once every check has passed.
      if let account = launch.account {
        if let message = account.environmentConflict(in: nil, secretNames: templateSecrets.keys.sorted()) {
          results.append(nil)
          errors.append(BrokerLaunchFailure(index: index, code: .badMessage, message: "launches[\(index)].account: \(message)"))
          continue
        }
        do { try broker.deps.shadowHomes.prepare(account, home: broker.deps.home) } catch {
          results.append(nil)
          errors.append(BrokerLaunchFailure(index: index, code: .internal, message: "launches[\(index)].account: \(error.localizedDescription)"))
          continue
        }
        // Usage is not worth a launch: a tap that cannot be written leaves the session with no `--settings`, and so
        // with its own status line.
        if let tap {
          do {
            var values = fileEnvironment?.dictionary ?? [:]
            values[ClaudeStatusTap.variable] = try tap.install(for: account, home: broker.deps.home)
            fileEnvironment = try LaunchEnvironment(values, field: "account", brokerNames: [ClaudeStatusTap.variable])
          } catch {
            broker.deps.log("[broker] \(name): no Claude status-line tap: \(error.localizedDescription)")
          }
        }
      }
      if let file = environmentFile, let store = broker.deps.secrets {
        do { try store.write(environment: fileEnvironment, secrets: launch.secrets, templateSecrets: templateSecrets, to: file) } catch {
          broker.deps.log("[broker] \(name): cannot write its launch file: \(error.message)")
          results.append(nil)
          let field = launch.secrets != nil ? "secrets" : launch.environment != nil ? "environment" : launch.template != nil ? "template" : "account"
          errors.append(BrokerLaunchFailure(index: index, code: .internal, message: "launches[\(index)].\(field): \(error.message)"))
          continue
        }
      }
      let result = await broker.run(tmux, arguments)
      let started = result.succeeded ? true : await broker.run(tmux, tmux.hasSession(name)).succeeded
      // Our shell never ran (tmux failed, or the name was another launch's
      // session): nobody will read the launch file, so it goes now. When it
      // did run, it deletes it itself; sweepSecrets catches any it missed.
      if !started || result.stderr.contains("duplicate session") { broker.deps.secrets?.remove(environmentFile) }
      if started {
        // A failure after the session started (setting its options) still
        // leaves a session to use; "duplicate session" is another launch's.
        existing.insert(name)
        results.append(name)
        if !result.stderr.contains("duplicate session") { created.append(name) }
        if !result.succeeded { broker.deps.log("[broker] \(name): \(result.firstErrorLine)") }
      } else {
        results.append(nil)
        let code: BrokerErrorCode = result.status == TmuxResult.launchFailed ? .internal : .tmuxFailed
        errors.append(BrokerLaunchFailure(index: index, code: code, message: result.firstErrorLine))
      }
    }
    broker.deps.log("[broker] launch: started \(created.map(\.rawValue)), reused \(results.compactMap { $0 }.filter { !created.contains($0) }.map(\.rawValue)), \(errors.count) failed")
    send(.launched(names: results, created: created, errors: errors), id: id)
    if !created.isEmpty { broker.refreshSoon() }
  }

  /// Where a session to attach to runs.
  private enum Placement {
    case here(TmuxCommand)
    case host(BrokerRemoteHost)
    case refused(BrokerProtocolError)
  }

  /// Where `session` runs: the host whose last list has it, else this Mac when its tmux has it, else the host a new
  /// list finds it on (docs/remote-hosts.md#sessions-and-terminals). With no host, this Mac's checks exactly as before
  /// hosts. `streamLimit` refuses a stream past the limit before this Mac's tmux is asked.
  private func place(_ session: SessionName, on broker: TerminalBroker, streamLimit: Bool) async -> Placement {
    if let host = broker.knownRemoteHost(of: session) { return .host(host) }
    guard let tmux = broker.tmux else {
      if let host = await broker.remoteHost(of: session) { return .host(host) }
      return .refused(Self.tmuxMissing)
    }
    if streamLimit, streams.count >= BrokerLimits.maxStreamsPerClient { return .refused(Self.tooManyStreams) }
    let check = await broker.run(tmux, tmux.hasSession(session))
    guard check.succeeded else {
      if check.status == TmuxResult.launchFailed { return .refused(BrokerProtocolError(.tmuxFailed, check.firstErrorLine)) }
      if let host = await broker.remoteHost(of: session) { return .host(host) }
      return .refused(BrokerProtocolError(.noSuchSession, "no session \(session)"))
    }
    return .here(tmux)
  }

  private func attach(_ session: SessionName, size: TerminalSize, id: String?) async {
    guard let broker else { return }
    let placement = await place(session, on: broker, streamLimit: true)
    guard isOpen else { return }
    switch placement {
    case .refused(let error):
      send(.error(error), id: id)
    case .here(let tmux):
      open(session, BrokerTerminalSpec(
        executable: tmux.executable, arguments: tmux.attach(session), environment: broker.attachEnvironment, size: size), id: id)
    case .host(let host):
      // The same stream, its output and input frames unchanged: only what its PTY runs is ssh to the host's tmux.
      guard streams.count < BrokerLimits.maxStreamsPerClient else { return send(.error(Self.tooManyStreams), id: id) }
      let terminal = await broker.terminalOnHost(session, host: host)
      guard isOpen else { return }
      switch terminal {
      case .failure(let error): send(.error(error), id: id)
      case .success(let spec):
        open(session, BrokerTerminalSpec(executable: spec.executable.path, arguments: spec.arguments,
                                         environment: BrokerEnvironment.attach(from: spec.environment), size: size), id: id)
      }
    }
  }

  /// A new stream of `session`, its PTY running `spec`.
  private func open(_ session: SessionName, _ spec: BrokerTerminalSpec, id: String?) {
    guard let broker else { return }
    guard streams.count < BrokerLimits.maxStreamsPerClient else { return send(.error(Self.tooManyStreams), id: id) }
    let stream = nextStream
    let terminal: any BrokerTerminal
    do {
      terminal = try broker.deps.terminals.spawn(
        spec,
        onOutput: { [weak self] data in self?.terminalOutput(stream, data) },
        onExit: { [weak self] status in self?.terminalExited(stream, status: status) })
    } catch {
      broker.deps.log("[broker] cannot open a terminal for \(session): \(error.localizedDescription)")
      return send(.error(code: .internal, message: "cannot open a terminal: \(error.localizedDescription)", stream: nil), id: id)
    }
    nextStream += 1
    streams[stream] = Stream(session: session, terminal: terminal)
    if output.paused { terminal.setReading(false) }
    send(.attached(stream: stream, session: session), id: id)
    broker.streamsChanged()
  }

  /// The line a Terminal.app window runs to attach to `session` where it runs: this Mac's tmux attach, or ssh to the
  /// host's. Hivemind.app asks only for a host's session; this Mac's it builds from the welcome's tmux, as before hosts.
  private func attachCommand(_ session: SessionName, id: String?) async {
    guard let broker else { return }
    let placement = await place(session, on: broker, streamLimit: false)
    guard isOpen else { return }
    switch placement {
    case .refused(let error):
      send(.error(error), id: id)
    case .here(let tmux):
      send(.attachCommand(session: session, command: tmux.attachShellLine(session)), id: id)
    case .host(let host):
      let terminal = await broker.terminalOnHost(session, host: host)
      guard isOpen else { return }
      switch terminal {
      case .failure(let error): send(.error(error), id: id)
      case .success(let spec):
        let line = "exec " + ([spec.executable.path] + spec.arguments).map(TerminalScript.shellQuoted).joined(separator: " ")
        send(.attachCommand(session: session, command: line), id: id)
      }
    }
  }

  private func kill(_ session: SessionName, id: String?) async {
    guard let broker else { return }
    // A host's session is killed on its host (docs/remote-hosts.md#sessions-and-terminals); with no host, as before.
    if let host = broker.knownRemoteHost(of: session) { return await kill(session, on: host, id: id) }
    // A session no host's last list has is looked for on this Mac first, so this Mac's kills ask no host.
    var local: TmuxResult?
    if let tmux = broker.tmux { local = await broker.run(tmux, tmux.killSession(session)) }
    if local.map(Self.noSuchSession) ?? true, let host = await broker.remoteHost(of: session) {
      return await kill(session, on: host, id: id)
    }
    guard let local else { return send(.error(Self.tmuxMissing), id: id) }
    answerKill(session, local, id: id)
  }

  private func kill(_ session: SessionName, on host: BrokerRemoteHost, id: String?) async {
    guard let broker else { return }
    guard let result = await broker.killOnHost(session, host: host) else {
      return send(.error(code: .internal, message: "cannot reach \(host.label) to end \(session)", stream: nil), id: id)
    }
    answerKill(session, result, id: id)
  }

  /// tmux had no such session (to kill, or to attach to).
  static func noSuchSession(_ result: TmuxResult) -> Bool {
    !result.succeeded && result.status != TmuxResult.launchFailed
      && (TmuxCommand.isNoServer(stderr: result.stderr) || result.stderr.contains("can't find session"))
  }

  private func answerKill(_ session: SessionName, _ result: TmuxResult, id: String?) {
    guard let broker else { return }
    if result.succeeded {
      broker.deps.log("[broker] killed \(session)")
      send(.killed(session: session), id: id)
      broker.refreshSoon()
    } else if Self.noSuchSession(result) {
      send(.error(code: .noSuchSession, message: "no session \(session)", stream: nil), id: id)
    } else {
      send(.error(code: .tmuxFailed, message: result.firstErrorLine, stream: nil), id: id)
    }
  }

  private func input(_ stream: BrokerStreamID, _ data: Data, id: String?) {
    guard let entry = streams[stream] else { return noSuchStream(stream, id: id) }
    if !entry.terminal.write(data) {
      send(.error(code: .internal, message: "input dropped: the terminal is not reading", stream: stream), id: id)
    }
  }

  private func detach(_ stream: BrokerStreamID, id: String?) {
    guard let entry = streams.removeValue(forKey: stream) else { return noSuchStream(stream, id: id) }
    output.discard(stream)
    entry.terminal.terminate()
    send(.exit(stream: stream, status: nil), id: id)
    applyBackpressure()
    broker?.streamsChanged()
  }

  private func noSuchStream(_ stream: BrokerStreamID, id: String?) {
    send(.error(code: .noSuchStream, message: "no stream \(stream) on this connection", stream: stream), id: id)
  }

  private static let tmuxMissing = BrokerProtocolError(.tmuxMissing, TmuxLocator.installHint)
  private static let tooManyStreams = BrokerProtocolError(
    .tooManyStreams, "at most \(BrokerLimits.maxStreamsPerClient) terminals per connection")

  // MARK: Streams

  private func terminalOutput(_ stream: BrokerStreamID, _ data: Data) {
    guard isOpen, streams[stream] != nil, let broker else { return }
    output.append(data, to: stream)
    if flushTimer == nil {
      flushTimer = broker.deps.scheduler.schedule(after: BrokerLimits.outputBatchInterval) { [weak self] in self?.flush() }
    }
    applyBackpressure()
  }

  private func flush() {
    flushTimer = nil
    for chunk in output.takeAll() {
      guard isOpen else { return }
      send(.output(stream: chunk.stream, data: chunk.data))
    }
    applyBackpressure()
  }

  /// The attach client exited: the session ended, was killed, or tmux went
  /// away. Its last output goes first.
  private func terminalExited(_ stream: BrokerStreamID, status: Int?) {
    guard isOpen, streams.removeValue(forKey: stream) != nil else { return }
    for chunk in output.take(stream) { send(.output(stream: chunk.stream, data: chunk.data)) }
    send(.exit(stream: stream, status: status))
    applyBackpressure()
    broker?.streamsChanged()
  }

  private func applyBackpressure() {
    guard let paused = output.updatePause() else { return }
    for entry in streams.values { entry.terminal.setReading(!paused) }
  }

  // MARK: Sending

  func push(_ sessions: [BrokerSession]) {
    send(.sessions(sessions))
  }

  private func reply(_ result: Result<BrokerEvent, BrokerProtocolError>, id: String?) {
    switch result {
    case .success(let event): send(event, id: id)
    case .failure(let error): send(.error(error), id: id)
    }
  }

  private func send(_ event: BrokerEvent, id: String? = nil) {
    guard isOpen else { return }
    let line: Data
    do { line = try BrokerEventFrame(id: id, event).line() } catch {
      broker?.deps.log("[broker] cannot encode \(event.type): \(error.message)")
      return
    }
    output.queued(line.count)
    transport.send(line)
    if output.unsentBytes > Self.maxUnsentBytes {
      broker?.deps.log("[broker] closing client \(client ?? "(unnamed)"): it stopped reading")
      close()
    }
  }

  /// Sends the error, then closes.
  private func fail(_ error: BrokerProtocolError, id: String? = nil) {
    send(.error(error), id: id)
    close()
  }

  private func shutDown(closeTransport: Bool) {
    guard isOpen else { return }
    isOpen = false
    helloTimer?.cancel()
    helloTimer = nil
    flushTimer?.cancel()
    flushTimer = nil
    let hadStreams = !streams.isEmpty
    for entry in streams.values { entry.terminal.terminate() }
    streams.removeAll()
    isSubscribed = false
    if closeTransport { transport.close() }
    broker?.removed(self)
    if hadStreams { broker?.streamsChanged() }
  }
}
