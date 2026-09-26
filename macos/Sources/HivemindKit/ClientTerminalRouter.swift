import Foundation

// One window's terminals: relays the page's terminal messages
// (BridgeMessage, already origin-gated and parsed by the window) to its
// broker client, and the broker's answers and pushes back to the page as
// BridgeTerminalEvents. It owns the streams its page attached: another
// page load in the window detaches them, and closing the window closes the
// connection. Terminal.app windows are opened through the existing .command
// machinery, attached to tmux; nothing here runs an agent's command outside
// tmux any more.
//
// Output reaches the page one terminal-output per stream per frame
// (`outputInterval`), and the page acks what it drew (terminal-ack). While
// more than `TerminalOutputFlow.pauseAboveBytes` is not acked, the client
// stops reading the broker, whose own backpressure then stops reading the
// PTYs; it reads again at `resumeAtBytes`.

/// A window's terminal output the page has not acked yet, per stream, and
/// whether reading from the broker is paused for it
/// (docs/terminal-broker.md#flow-control-to-the-page). Each change returns
/// the new pause state when it flipped, or nil.
public struct TerminalOutputFlow: Equatable, Sendable {
  /// Unacked bytes (decoded) past which the app stops reading the broker.
  public static let pauseAboveBytes = 1 << 20
  /// And at or below which it reads again.
  public static let resumeAtBytes = 256 << 10

  public private(set) var pending: [BrokerStreamID: Int] = [:]
  public private(set) var paused = false

  public init() {}

  public var total: Int { pending.values.reduce(0, +) }

  /// `bytes` of `stream` went to the page (or wait to go this frame).
  public mutating func sent(_ bytes: Int, on stream: BrokerStreamID) -> Bool? {
    pending[stream, default: 0] += bytes
    return update()
  }

  /// The page drew `bytes` of `stream`. An ack never takes a stream below
  /// zero, and one for a stream with nothing pending is ignored.
  public mutating func acked(_ bytes: Int, on stream: BrokerStreamID) -> Bool? {
    guard let waiting = pending[stream] else { return nil }
    pending[stream] = max(0, waiting - bytes)
    return update()
  }

  /// The stream is over, or the page stopped wanting it: nothing more of it
  /// will be acked.
  public mutating func forget(_ stream: BrokerStreamID) -> Bool? {
    guard pending.removeValue(forKey: stream) != nil else { return nil }
    return update()
  }

  public mutating func reset() -> Bool? {
    pending = [:]
    return update()
  }

  private mutating func update() -> Bool? {
    let total = total
    if !paused, total > Self.pauseAboveBytes {
      paused = true
      return true
    }
    if paused, total <= Self.resumeAtBytes {
      paused = false
      return false
    }
    return nil
  }
}

@MainActor
public final class TerminalBridgeRouter {
  public struct Environment {
    /// Stands in for "~" and a missing folder in terminal-launch.
    public var home: String
    /// HivemindPaths.tmuxConfig, for the Terminal.app attach line.
    public var tmuxConfigPath: String
    public var now: @MainActor () -> Date
    /// Dispatches an event to the page.
    public var deliver: @MainActor (BridgeTerminalEvent) -> Void
    /// Opens Terminal.app windows (TerminalLauncher) and reports failures.
    public var openTerminals: @MainActor ([TerminalLaunch]) -> Void
    /// Times the output frames.
    public var scheduler: any Scheduling

    @MainActor
    public init(
      home: String, tmuxConfigPath: String, now: @escaping @MainActor () -> Date = Date.init,
      deliver: @escaping @MainActor (BridgeTerminalEvent) -> Void,
      openTerminals: @escaping @MainActor ([TerminalLaunch]) -> Void,
      scheduler: any Scheduling = MainQueueScheduler()
    ) {
      self.home = home
      self.tmuxConfigPath = tmuxConfigPath
      self.now = now
      self.deliver = deliver
      self.openTerminals = openTerminals
      self.scheduler = scheduler
    }
  }

  /// How long output is gathered before it goes to the page: one frame.
  public nonisolated static let outputInterval: TimeInterval = 1.0 / 60
  /// The most output (decoded) one terminal-output carries; more is split,
  /// and a stream that gathers this much goes at once.
  public nonisolated static let maxOutputEventBytes = 256 << 10

  private let client: any BrokerClienting
  private let environment: Environment
  // Each of these can start or end sessions or open windows: at most one a
  // second each per window, as the old direct launch was.
  private var launchThrottle = TerminalLaunchThrottle()
  private var openThrottle = TerminalLaunchThrottle()
  private var killThrottle = TerminalLaunchThrottle()
  /// Bumped on every page load: answers to an earlier page are not delivered.
  private var page = 0
  /// Streams this page attached and has not seen exit.
  public private(set) var streams: Set<BrokerStreamID> = []
  public private(set) var subscribed = false
  /// Whether this page has sent a terminal message (and so hears status).
  private var pageUsesTerminals = false
  private var clientStarted = false
  private var lastStatus: BridgeTerminalEvent?
  /// Streams the page detached and whose exit has not come yet: their output
  /// is dropped, since the page no longer draws (or acks) it.
  private var detaching: Set<BrokerStreamID> = []
  public private(set) var flow = TerminalOutputFlow()
  /// This frame's output, per stream, in the order the streams first spoke.
  private var outputOrder: [BrokerStreamID] = []
  private var outputBuffer: [BrokerStreamID: Data] = [:]
  private var outputJob: (any Cancellable)?

  public init(client: any BrokerClienting, environment: Environment) {
    self.client = client
    self.environment = environment
    client.onStatusChange = { [weak self] status in self?.statusChanged(status) }
    client.onEvent = { [weak self] event in self?.pushed(event) }
  }

  // MARK: Page → broker

  /// Handles a terminal message; any other message is ignored.
  public func handle(_ message: BridgeMessage) {
    switch message {
    case .terminalLaunch(let id, let launches, let openInTerminal):
      guard launchThrottle.allow(at: environment.now()) else { return throttled(id: id) }
      begin()
      launch(id: id, launches: launches, openInTerminal: openInTerminal)
    case .terminalOpen(let session):
      guard openThrottle.allow(at: environment.now()) else { return throttled(id: nil) }
      begin()
      open(session)
    case .terminalAttach(let id, let session, let size):
      begin()
      attach(id: id, session: session, size: size)
    case .terminalInput(let stream, let data):
      guard streams.contains(stream) else { return }
      client.send(.input(stream: stream, data: data), reply: nil)
    case .terminalResize(let stream, let size):
      guard streams.contains(stream) else { return }
      client.send(.resize(stream: stream, size: size), reply: nil)
    case .terminalDetach(let stream):
      // The stream stays ours until its exit, which the page gets.
      guard streams.contains(stream) else { return }
      client.send(.detach(stream: stream), reply: nil)
      detaching.insert(stream)
      dropOutput(stream)
      applyFlow(flow.forget(stream))
    case .terminalAck(let stream, let bytes):
      guard streams.contains(stream), !detaching.contains(stream) else { return }
      applyFlow(flow.acked(bytes, on: stream))
    case .terminalKill(let id, let session):
      guard killThrottle.allow(at: environment.now()) else { return throttled(id: id) }
      begin()
      kill(id: id, session: session)
    case .sessionsSubscribe:
      begin()
      subscribed = true
      client.setSessionsSubscribed(true)
      // The page (re)opened a terminal view: a good moment not to wait for
      // the next retry, or to look for a newly installed tmux.
      client.retryNow()
      lastStatus = client.status.bridgeEvent
      deliver(client.status.bridgeEvent)
    case .sessionsUnsubscribe:
      guard subscribed else { return }
      subscribed = false
      client.setSessionsSubscribed(false)
    default:
      break
    }
  }

  public nonisolated static let throttledMessage = "Hivemind is still handling the last request. Try again in a moment."

  /// A request over its throttle gets an answer, so the page can say "try
  /// again" instead of waiting for one that never comes.
  private func throttled(id: String?) {
    deliver(.error(id: id, code: .internal, message: Self.throttledMessage, stream: nil))
  }

  private func begin() {
    pageUsesTerminals = true
    guard !clientStarted else { return }
    clientStarted = true
    client.start()
  }

  private func launch(id: String?, launches: [TerminalSessionLaunch], openInTerminal: Bool) {
    var brokerLaunches: [BrokerLaunch] = []
    for (index, launch) in launches.enumerated() {
      guard let brokerLaunch = launch.brokerLaunch(home: environment.home) else {
        return deliver(.error(id: id, code: .badMessage, message: "launches[\(index)].cwd: too long once ~ is expanded", stream: nil))
      }
      brokerLaunches.append(brokerLaunch)
    }
    let titles = launches.map(\.title)
    let page = page
    client.send(.launch(brokerLaunches)) { [weak self] event in
      guard let self else { return }
      // Terminal.app opens even if the page moved on: the user asked for it.
      if openInTerminal, case .launched(let names, _, _) = event {
        self.openTerminals(zip(names, titles).compactMap { name, title in name.map { ($0, title) } })
      }
      if self.page == page { self.deliver(BridgeTerminalEvent(BrokerEventFrame(event), id: id)) }
    }
  }

  private func open(_ session: SessionName) {
    let page = page
    // Only a running session: tmux attach to anything else would just fail
    // in a Terminal window.
    client.send(.sessionsList) { [weak self] event in
      guard let self else { return }
      switch event {
      case .sessions(let items):
        if items.contains(where: { $0.name == session }) {
          self.openTerminals([(session, session.rawValue)])
        } else if self.page == page {
          self.deliver(.error(id: nil, code: .noSuchSession, message: "\(session.rawValue) is not running", stream: nil))
        }
      default:
        if self.page == page { self.deliver(BridgeTerminalEvent(BrokerEventFrame(event))) }
      }
    }
  }

  private func attach(id: String?, session: SessionName, size: TerminalSize) {
    let page = page
    client.send(.attach(session: session, size: size)) { [weak self] event in
      guard let self else { return }
      if case .attached(let stream, _) = event {
        // Attached for a page that is gone: nobody will ever detach it.
        guard self.page == page else { return self.client.send(.detach(stream: stream), reply: nil) }
        self.streams.insert(stream)
      }
      if self.page == page { self.deliver(BridgeTerminalEvent(BrokerEventFrame(event), id: id)) }
    }
  }

  private func kill(id: String?, session: SessionName) {
    let page = page
    client.send(.kill(session: session)) { [weak self] event in
      guard let self, self.page == page else { return }
      self.deliver(BridgeTerminalEvent(BrokerEventFrame(event), id: id))
    }
  }

  /// One Terminal.app window per session, each running `exec tmux attach`.
  private func openTerminals(_ sessions: [(name: SessionName, title: String)]) {
    guard !sessions.isEmpty else { return }
    guard let tmux = client.status.tmuxPath else {
      return deliver(.error(id: nil, code: .tmuxMissing, message: TmuxLocator.installHint, stream: nil))
    }
    let command = TmuxCommand(executable: tmux, configPath: environment.tmuxConfigPath)
    let launches = sessions.compactMap { session in
      TerminalLaunch(title: session.title, cwd: nil, command: command.attachShellLine(session.name))
    }
    environment.openTerminals(launches)
  }

  // MARK: Broker → page

  private func pushed(_ event: BrokerEvent) {
    switch event {
    case .sessions:
      guard subscribed else { return }
    case .output(let stream, let data):
      guard streams.contains(stream), !detaching.contains(stream) else { return }
      return gather(data, on: stream)
    case .exit(let stream, _):
      guard streams.remove(stream) != nil else { return }
      detaching.remove(stream)
      // Its last output goes first (deliver flushes the frame).
      deliver(BridgeTerminalEvent(BrokerEventFrame(event)))
      applyFlow(flow.forget(stream))
      return
    case .error(_, _, let stream):
      // Errors about a stream of ours; the rest answered nothing of the page's.
      guard let stream, streams.contains(stream) else { return }
    case .welcome, .launched, .attached, .killed:
      return
    }
    deliver(BridgeTerminalEvent(BrokerEventFrame(event)))
  }

  private func statusChanged(_ status: BrokerClientStatus) {
    let event = status.bridgeEvent
    guard event != lastStatus else { return }
    lastStatus = event
    if pageUsesTerminals { deliver(event) }
  }

  /// Every event but output goes through here, after this frame's output,
  /// so the page sees everything in the order the broker sent it.
  private func deliver(_ event: BridgeTerminalEvent?) {
    guard let event else { return }
    flushOutput()
    environment.deliver(event)
  }

  // MARK: Output and flow control

  private func gather(_ data: Data, on stream: BrokerStreamID) {
    guard !data.isEmpty else { return }
    if outputBuffer[stream] == nil {
      outputOrder.append(stream)
      outputBuffer[stream] = data
    } else {
      outputBuffer[stream]!.append(data)
    }
    applyFlow(flow.sent(data.count, on: stream))
    if outputBuffer[stream]!.count >= Self.maxOutputEventBytes {
      flushOutput()
    } else if outputJob == nil {
      outputJob = environment.scheduler.schedule(after: Self.outputInterval) { [weak self] in
        self?.outputJob = nil
        self?.flushOutput()
      }
    }
  }

  /// This frame's output: one terminal-output per stream (split past
  /// `maxOutputEventBytes`).
  private func flushOutput() {
    outputJob?.cancel()
    outputJob = nil
    guard !outputOrder.isEmpty else { return }
    let order = outputOrder
    let buffer = outputBuffer
    outputOrder = []
    outputBuffer = [:]
    for stream in order {
      guard let data = buffer[stream] else { continue }
      var start = data.startIndex
      while start < data.endIndex {
        let end = data.index(start, offsetBy: Self.maxOutputEventBytes, limitedBy: data.endIndex) ?? data.endIndex
        environment.deliver(.output(stream: stream, data: data.subdata(in: start..<end)))
        start = end
      }
    }
  }

  private func dropOutput(_ stream: BrokerStreamID) {
    guard outputBuffer.removeValue(forKey: stream) != nil else { return }
    outputOrder.removeAll { $0 == stream }
  }

  private func dropAllOutput() {
    outputJob?.cancel()
    outputJob = nil
    outputOrder = []
    outputBuffer = [:]
    detaching = []
    applyFlow(flow.reset())
  }

  private func applyFlow(_ paused: Bool?) {
    if let paused { client.setReading(!paused) }
  }

  // MARK: Window

  /// A new document in the window (reload, navigation, the connect screen):
  /// the old page's streams are detached and its subscription ends. The
  /// connection stays for the next page.
  public func pageDidChange() {
    page += 1
    for stream in streams.sorted() { client.send(.detach(stream: stream), reply: nil) }
    streams = []
    dropAllOutput()
    if subscribed {
      subscribed = false
      client.setSessionsSubscribed(false)
    }
    pageUsesTerminals = false
  }

  /// The window closed: closing the connection detaches everything on it.
  public func close() {
    page += 1
    streams = []
    dropAllOutput()
    subscribed = false
    pageUsesTerminals = false
    client.onStatusChange = nil
    client.onEvent = nil
    client.stop()
    clientStarted = false
  }

  /// The app became active or asked Hivemind Server to start.
  public func retry() {
    guard clientStarted else { return }
    client.retryNow()
  }
}
