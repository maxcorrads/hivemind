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
    public var log: (String) -> Void

    public init(
      tmux: any TmuxRunning, terminals: any BrokerTerminalSpawning, scheduler: any Scheduling,
      locateTmux: @escaping () -> String?, isDirectory: @escaping (String) -> Bool,
      environment: [String: String], idlePollInterval: TimeInterval = 15, log: @escaping (String) -> Void = { _ in }
    ) {
      self.tmux = tmux
      self.terminals = terminals
      self.scheduler = scheduler
      self.locateTmux = locateTmux
      self.isDirectory = isDirectory
      self.environment = environment
      self.idlePollInterval = idlePollInterval
      self.log = log
    }
  }

  public let token: BrokerToken
  /// HivemindPaths.tmuxConfig, which BrokerFiles wrote.
  public let configPath: String
  /// Called after anything the menu shows changed.
  public var onChange: (@MainActor () -> Void)?

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
  /// yet means no sessions, and so does no tmux at all.
  func listSessions() async -> Result<[BrokerSession], BrokerProtocolError> {
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
    case .sessionsList, .sessionsSubscribe, .sessionsUnsubscribe, .launch, .attach, .kill:
      enqueue(frame)
    }
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
    case .hello, .input, .resize, .detach:
      break
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

  private func launch(_ launches: [BrokerLaunch], id: String?) async {
    guard let broker else { return }
    await broker.launching { [weak self] in await self?.launchNow(launches, id: id) }
  }

  /// One launch, never alongside another (TerminalBroker.launching).
  private func launchNow(_ launches: [BrokerLaunch], id: String?) async {
    guard isOpen, let broker else { return }
    guard let tmux = broker.tmux else { return send(.error(Self.tmuxMissing), id: id) }
    let running: [BrokerSession]
    switch await broker.listSessions() {
    case .success(let list): running = list
    case .failure(let error): return send(.error(error), id: id)
    }
    var existing = Set(running.map(\.name))
    let names = BrokerLaunch.sessionNames(for: launches, existing: existing)
    var results: [SessionName?] = []
    var created: [SessionName] = []
    var errors: [BrokerLaunchFailure] = []
    for (index, (launch, name)) in zip(launches, names).enumerated() {
      if existing.contains(name) {
        results.append(name)
        continue
      }
      guard broker.deps.isDirectory(launch.cwd) else {
        results.append(nil)
        errors.append(BrokerLaunchFailure(index: index, code: .cwdMissing, message: "launches[\(index)].cwd: not a folder"))
        continue
      }
      let result = await broker.run(tmux, tmux.newSession(TmuxNewSession(name: name, launch: launch)))
      let started = result.succeeded ? true : await broker.run(tmux, tmux.hasSession(name)).succeeded
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

  private func attach(_ session: SessionName, size: TerminalSize, id: String?) async {
    guard let broker else { return }
    guard let tmux = broker.tmux else { return send(.error(Self.tmuxMissing), id: id) }
    guard streams.count < BrokerLimits.maxStreamsPerClient else { return send(.error(Self.tooManyStreams), id: id) }
    let check = await broker.run(tmux, tmux.hasSession(session))
    guard isOpen else { return }
    guard check.succeeded else {
      if check.status == TmuxResult.launchFailed { return send(.error(code: .tmuxFailed, message: check.firstErrorLine, stream: nil), id: id) }
      return send(.error(code: .noSuchSession, message: "no session \(session)", stream: nil), id: id)
    }
    guard streams.count < BrokerLimits.maxStreamsPerClient else { return send(.error(Self.tooManyStreams), id: id) }
    let stream = nextStream
    let spec = BrokerTerminalSpec(
      executable: tmux.executable, arguments: tmux.attach(session), environment: broker.attachEnvironment, size: size)
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

  private func kill(_ session: SessionName, id: String?) async {
    guard let broker else { return }
    guard let tmux = broker.tmux else { return send(.error(Self.tmuxMissing), id: id) }
    let result = await broker.run(tmux, tmux.killSession(session))
    if result.succeeded {
      broker.deps.log("[broker] killed \(session)")
      send(.killed(session: session), id: id)
      broker.refreshSoon()
    } else if result.status != TmuxResult.launchFailed,
              TmuxCommand.isNoServer(stderr: result.stderr) || result.stderr.contains("can't find session") {
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
