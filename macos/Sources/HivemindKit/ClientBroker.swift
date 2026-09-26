import Foundation

// A client of the terminal broker (docs/terminal-broker.md): connects over a
// BrokerConnecting transport, says hello with the token, matches replies to
// requests by id, hands everything else on as pushed events, and reconnects
// with backoff for as long as it runs. Hivemind.app keeps one per window;
// an iOS client will reuse it over its own transport.

/// Where a client stands with the broker.
public struct BrokerClientStatus: Equatable, Sendable {
  public enum Connection: String, Equatable, Sendable {
    /// Not started, or stopped.
    case idle
    /// The first attempt since start is under way.
    case connecting
    /// Said hello and got welcome.
    case connected
    /// The last attempt failed (Hivemind Server is not running, say); the
    /// client keeps retrying.
    case unavailable
  }

  public var connection: Connection
  /// welcome.tmuxPath while connected: nil when tmux is not installed.
  public var tmuxPath: String?
  /// Why the last attempt failed, for the log.
  public var reason: String?

  public init(connection: Connection, tmuxPath: String? = nil, reason: String? = nil) {
    self.connection = connection
    self.tmuxPath = tmuxPath
    self.reason = reason
  }

  /// The page's terminal-status.
  public var bridgeEvent: BridgeTerminalEvent {
    switch connection {
    case .connected: .status(tmux: tmuxPath == nil ? .missing : .available, broker: .connected)
    case .idle, .connecting: .status(tmux: .unknown, broker: .connecting)
    case .unavailable: .status(tmux: .unknown, broker: .unavailable)
    }
  }
}

/// What a terminal router needs of a broker client; the tests' fake is one.
@MainActor
public protocol BrokerClienting: AnyObject {
  var status: BrokerClientStatus { get }
  var onStatusChange: (@MainActor (BrokerClientStatus) -> Void)? { get set }
  /// Events that answer no request of ours: sessions pushes, output, exit,
  /// stream errors. Also an `exit` for every stream a lost connection took.
  var onEvent: (@MainActor (BrokerEvent) -> Void)? { get set }
  func start()
  func stop()
  /// Retry now instead of at the next backoff step; also reconnects when
  /// the broker had no tmux, since it looks tmux up again on every hello.
  func retryNow()
  /// With a reply, the request carries an id and `reply` gets its answer:
  /// the matching event, or an `error` (the broker's, or the client's own
  /// when it is not connected or the connection was lost). Without one,
  /// the request is sent only while connected and otherwise dropped.
  func send(_ request: BrokerRequest, reply: (@MainActor (BrokerEvent) -> Void)?)
  /// Whether this connection subscribes to sessions; kept across reconnects.
  func setSessionsSubscribed(_ subscribed: Bool)
  /// Stops (false) or resumes (true) reading from the broker: the page is
  /// behind on output (TerminalOutputFlow). Kept across reconnects.
  func setReading(_ reading: Bool)
}

@MainActor
public final class BrokerClient: BrokerClienting {
  public struct Configuration {
    public var connector: any BrokerConnecting
    /// Read before every connection (the broker writes a new one on each start).
    public var token: @MainActor () -> BrokerToken?
    /// hello.client, for the broker's log.
    public var clientLabel: String
    public var backoff: BackoffPolicy
    /// How long a connection may take to be welcomed.
    public var helloTimeout: TimeInterval
    /// Requests with a reply held while connecting, and awaiting answers.
    public var maxPendingRequests: Int

    public init(
      connector: any BrokerConnecting,
      token: @escaping @MainActor () -> BrokerToken?,
      clientLabel: String,
      backoff: BackoffPolicy = BrokerClient.defaultBackoff,
      helloTimeout: TimeInterval = BrokerLimits.helloTimeout,
      maxPendingRequests: Int = 64
    ) {
      self.connector = connector
      self.token = token
      self.clientLabel = clientLabel
      self.backoff = backoff
      self.helloTimeout = helloTimeout
      self.maxPendingRequests = maxPendingRequests
    }
  }

  /// Short and never giving up: Hivemind Server may be started at any time,
  /// and terminals should come up within seconds of it.
  public nonisolated static let defaultBackoff = BackoffPolicy(initial: 0.5, multiplier: 2, maximum: 5, stableAfter: 0, maxAttempts: .max)

  public nonisolated static let notConnectedMessage = "Hivemind Server is not running. Start Hivemind Server to use terminals."
  public nonisolated static let lostConnectionMessage = "Lost the connection to Hivemind Server."

  public typealias Reply = @MainActor (BrokerEvent) -> Void

  private enum Phase {
    case stopped
    /// Connecting or waiting for welcome.
    case attempting
    case ready
    /// Waiting for the next retry.
    case backingOff
  }

  public private(set) var status = BrokerClientStatus(connection: .idle) {
    didSet { if status != oldValue { onStatusChange?(status) } }
  }
  public var onStatusChange: (@MainActor (BrokerClientStatus) -> Void)?
  public var onEvent: (@MainActor (BrokerEvent) -> Void)?

  private let configuration: Configuration
  private let scheduler: any Scheduling
  private var phase = Phase.stopped
  /// Bumped for every connection, so a late callback of an old one is ignored.
  private var generation = 0
  private var transport: (any BrokerTransportConnection)?
  private var reader = BrokerLineReader(limit: BrokerLimits.maxEventBytes)
  private var failures = 0
  private var retryJob: (any Cancellable)?
  private var helloJob: (any Cancellable)?
  private var nextID = 0
  private var pending: [String: Reply] = [:]
  private var queued: [(request: BrokerRequest, reply: Reply)] = []
  /// Streams attached on this connection and not yet exited.
  public private(set) var streams: Set<BrokerStreamID> = []
  private var sessionsSubscribed = false
  /// setReading's last word.
  public private(set) var isReading = true

  public init(configuration: Configuration, scheduler: any Scheduling) {
    self.configuration = configuration
    self.scheduler = scheduler
  }

  // MARK: Lifecycle

  public func start() {
    guard case .stopped = phase else { return }
    failures = 0
    status = BrokerClientStatus(connection: .connecting)
    attempt()
  }

  /// Closes the connection; nothing is called back, not even pending replies.
  public func stop() {
    phase = .stopped
    reset()
    pending = [:]
    queued = []
    streams = []
    sessionsSubscribed = false
    isReading = true
    status = BrokerClientStatus(connection: .idle)
  }

  public func retryNow() {
    switch phase {
    case .backingOff:
      failures = 0
      attempt()
    case .ready where status.tmuxPath == nil:
      // No tmux at the last hello: a new hello looks again.
      dropConnection(reason: nil)
      attempt()
    case .stopped, .attempting, .ready:
      break
    }
  }

  private func attempt() {
    reset()
    phase = .attempting
    let generation = generation
    helloJob = scheduler.schedule(after: configuration.helloTimeout) { [weak self] in
      guard let self, self.generation == generation, case .attempting = self.phase else { return }
      self.fail("Hivemind Server did not answer")
    }
    guard let token = configuration.token() else { return fail("No broker token: Hivemind Server has not started its broker") }
    let transport = configuration.connector.connection(handlers: BrokerTransportHandlers(
      onOpen: { [weak self] in
        guard let self, self.generation == generation else { return }
        self.opened(token: token)
      },
      onData: { [weak self] data in
        guard let self, self.generation == generation else { return }
        self.received(data)
      },
      onClose: { [weak self] reason in
        guard let self, self.generation == generation else { return }
        self.fail(reason ?? "Hivemind Server closed the connection")
      }))
    self.transport = transport
    if !isReading { transport.setReading(false) }
    transport.start()
  }

  /// Forgets the connection: late callbacks of it are ignored from here on.
  private func reset() {
    generation += 1
    retryJob?.cancel()
    retryJob = nil
    helloJob?.cancel()
    helloJob = nil
    transport?.close()
    transport = nil
    reader = BrokerLineReader(limit: BrokerLimits.maxEventBytes)
  }

  /// The connection is gone: its streams are over and its requests unanswered.
  private func dropConnection(reason: String?) {
    reset()
    let lost = streams.sorted()
    streams = []
    let replies = Array(pending.values) + queued.map(\.reply)
    pending = [:]
    queued = []
    for stream in lost { onEvent?(.exit(stream: stream, status: nil)) }
    for reply in replies { reply(.error(code: .internal, message: Self.lostConnectionMessage, stream: nil)) }
  }

  private func fail(_ reason: String) {
    guard phase != .stopped else { return }
    dropConnection(reason: reason)
    phase = .backingOff
    failures += 1
    status = BrokerClientStatus(connection: .unavailable, reason: reason)
    let delay = configuration.backoff.delay(forAttempt: failures) ?? configuration.backoff.maximum
    let generation = generation
    retryJob = scheduler.schedule(after: delay) { [weak self] in
      guard let self, self.generation == generation, case .backingOff = self.phase else { return }
      self.attempt()
    }
  }

  // MARK: Wire

  private func opened(token: BrokerToken) {
    write(BrokerRequestFrame(.hello(version: BrokerProtocol.version, token: token.value, client: configuration.clientLabel)))
  }

  private func received(_ data: Data) {
    let lines: [Data]
    do { lines = try reader.append(data) } catch {
      return fail("The broker sent a message over \(BrokerLimits.maxEventBytes) bytes")
    }
    let generation = generation
    for line in lines {
      // A line that does not decode (a newer broker's event, say) is
      // skipped; only an oversized one ends the connection.
      let frame: BrokerEventFrame
      do { frame = try BrokerEventFrame.decode(line) } catch {
        if error.code == .tooLarge { return fail(error.message) }
        continue
      }
      handle(frame)
      // A handler may have ended (or replaced) this connection.
      guard self.generation == generation else { return }
    }
  }

  private func handle(_ frame: BrokerEventFrame) {
    switch phase {
    case .attempting:
      switch frame.event {
      case .welcome(let version, let tmuxPath):
        guard (BrokerProtocol.minimumVersion...BrokerProtocol.version).contains(version) else {
          return fail("The broker speaks protocol version \(version); this app speaks \(BrokerProtocol.version)")
        }
        welcomed(tmuxPath: tmuxPath)
      case .error(let code, let message, _):
        fail("\(code.rawValue): \(message)")
      default:
        break
      }
    case .ready:
      dispatch(frame)
    case .stopped, .backingOff:
      break
    }
  }

  private func welcomed(tmuxPath: String?) {
    helloJob?.cancel()
    helloJob = nil
    phase = .ready
    failures = 0
    status = BrokerClientStatus(connection: .connected, tmuxPath: tmuxPath)
    if sessionsSubscribed { write(BrokerRequestFrame(.sessionsSubscribe)) }
    let waiting = queued
    queued = []
    for item in waiting { send(item.request, reply: item.reply) }
  }

  private func dispatch(_ frame: BrokerEventFrame) {
    switch frame.event {
    case .attached(let stream, _): streams.insert(stream)
    case .exit(let stream, _): streams.remove(stream)
    default: break
    }
    if let id = frame.id, let reply = pending.removeValue(forKey: id) {
      reply(frame.event)
    } else {
      onEvent?(frame.event)
    }
  }

  // MARK: Requests

  public func send(_ request: BrokerRequest, reply: Reply?) {
    switch phase {
    case .ready:
      guard let reply else { return write(BrokerRequestFrame(request)) }
      guard pending.count < configuration.maxPendingRequests else {
        return reply(.error(code: .internal, message: "Too many requests waiting for Hivemind Server", stream: nil))
      }
      nextID += 1
      let id = "c\(nextID)"
      pending[id] = reply
      write(BrokerRequestFrame(id: id, request), failing: id)
    case .attempting:
      guard let reply else { return }
      guard queued.count < configuration.maxPendingRequests else {
        return reply(.error(code: .internal, message: "Too many requests waiting for Hivemind Server", stream: nil))
      }
      queued.append((request, reply))
    case .stopped, .backingOff:
      reply?(.error(code: .internal, message: Self.notConnectedMessage, stream: nil))
    }
  }

  public func setReading(_ reading: Bool) {
    guard reading != isReading else { return }
    isReading = reading
    transport?.setReading(reading)
  }

  public func setSessionsSubscribed(_ subscribed: Bool) {
    guard subscribed != sessionsSubscribed else { return }
    sessionsSubscribed = subscribed
    if case .ready = phase { write(BrokerRequestFrame(subscribed ? .sessionsSubscribe : .sessionsUnsubscribe)) }
  }

  /// A frame too large to send is answered with the error, if it had a reply.
  private func write(_ frame: BrokerRequestFrame, failing id: String? = nil) {
    do {
      transport?.send(try frame.line())
    } catch {
      if let id, let reply = pending.removeValue(forKey: id) { reply(.error(error)) }
    }
  }
}
