import Foundation

// The remote gateway's logic (docs/remote-access.md): every connection a
// listener accepted, the pairing window, the device sessions, the Human
// capability it holds for the Node server, and revocation. The listeners,
// TLS and Bonjour are Hivemind Server.app's (Network.framework); they hand
// each connection to `accept` with its two addresses. Everything here runs
// on the main actor and reaches the network only through GatewayStream,
// GatewayUpstreamConnecting and BrokerConnecting.

@MainActor
public final class GatewayServer {
  public struct Configuration: Sendable {
    /// The Mac's name, sent back on pairing (PairResponse.name).
    public var macName: String
    /// The gateway's TCP port: every Host must name it.
    public var port: Int
    /// The Mac's Bonjour names ("studio.local"), also accepted in Host.
    public var hostNames: [String]
    /// The Mac user's home folder, sent with every device session
    /// (SessionResponse.home): what "~" means in a launch from a device.
    public var home: String?

    public init(macName: String, port: Int, hostNames: [String], home: String? = nil) {
      self.macName = macName
      self.port = port
      self.hostNames = hostNames
      self.home = home
    }
  }

  public struct Dependencies {
    public var scheduler: any Scheduling
    public var upstream: any GatewayUpstreamConnecting
    public var broker: any BrokerConnecting
    /// broker.token, read before every broker connection; nil when no
    /// broker runs.
    public var brokerToken: @MainActor () -> BrokerToken?
    /// The Node server Hivemind Server.app runs, while it runs: its port and
    /// the secret it was started with (docs/remote-access.md#verified-server).
    public var server: @MainActor () -> GatewayUpstreamServer?
    /// Proves that server is the one Hivemind Server.app started.
    public var verifier: any GatewayServerVerifying
    public var log: @MainActor (String) -> Void

    public init(
      scheduler: any Scheduling, upstream: any GatewayUpstreamConnecting, broker: any BrokerConnecting,
      brokerToken: @escaping @MainActor () -> BrokerToken?, server: @escaping @MainActor () -> GatewayUpstreamServer?,
      verifier: any GatewayServerVerifying, log: @escaping @MainActor (String) -> Void
    ) {
      self.scheduler = scheduler
      self.upstream = upstream
      self.broker = broker
      self.brokerToken = brokerToken
      self.server = server
      self.verifier = verifier
      self.log = log
    }
  }

  public let configuration: Configuration
  public let devices: GatewayDeviceStore
  let deps: Dependencies
  /// Pairing, sessions and devices changed (for the windows and the menu).
  public var onChange: (@MainActor () -> Void)?

  public private(set) var pairing = GatewayPairing()
  private(set) var sessions = GatewaySessionStore()
  private var pairLimiter = GatewayRateLimiter(limit: GatewayLimits.pairingAttemptsPerMinute)
  private var sessionLimiter = GatewayRateLimiter(limit: GatewayLimits.sessionAttemptsPerMinute)
  private var connections: [ObjectIdentifier: GatewayConnection] = [:]
  private var stopped = false

  private var capability: (server: GatewayUpstreamServer, value: HumanCapability)?
  private var bootstrap: CapabilityBootstrap?
  private(set) var trust = GatewayServerTrust.unchecked
  private var check: GatewayServerCheck?

  /// How long the Human bootstrap may take before the waiting requests get
  /// server-unavailable.
  static let bootstrapTimeout: TimeInterval = 10
  /// How long the instance check may take (InstanceVerifier gives up sooner).
  static let verificationTimeout: TimeInterval = 10
  /// A server that failed the check is refused this long before it is
  /// checked again, so a flood of requests does not become a flood of checks.
  static let recheckAfterFailure: TimeInterval = 5

  public init(configuration: Configuration, devices: GatewayDeviceStore, dependencies: Dependencies) {
    self.configuration = configuration
    self.devices = devices
    deps = dependencies
  }

  var now: Date { deps.scheduler.now() }

  // MARK: Connections

  public var connectionCount: Int { connections.count }

  /// A connection a listener accepted. It is served only when both of its
  /// addresses are private, and within the connection limits; otherwise it
  /// is closed at once.
  @discardableResult
  public func accept(_ stream: any GatewayStream, local: IPAddress, remote: IPAddress) -> Bool {
    guard !stopped, RemoteAddressPolicy.accepts(local: local, remote: remote) else {
      deps.log("[gateway] refused \(remote) → \(local): not a private address")
      stream.close()
      return false
    }
    let key = Self.addressKey(remote)
    guard connections.count < GatewayLimits.maxConnections,
          connections.values.filter({ $0.remoteKey == key }).count < GatewayLimits.maxConnectionsPerAddress
    else {
      deps.log("[gateway] refused \(remote): too many connections")
      stream.close()
      return false
    }
    let connection = GatewayConnection(stream: stream, local: local, remote: remote, remoteKey: key, server: self)
    connections[ObjectIdentifier(connection)] = connection
    connection.start()
    return true
  }

  func removed(_ connection: GatewayConnection) {
    connections[ObjectIdentifier(connection)] = nil
  }

  func brokerConnections(of deviceId: UUID) -> Int {
    connections.values.filter { $0.deviceId == deviceId && $0.isBroker }.count
  }

  /// Remote access turned off (or the app quits): every connection closes.
  /// Devices stay paired; sessions are forgotten with this object.
  public func stop() {
    stopped = true
    pairing.close()
    for connection in Array(connections.values) { connection.terminate() }
    connections.removeAll()
    bootstrap?.finish(nil)
    bootstrap = nil
    capability = nil
    check?.finish(.unavailable)
    check = nil
    trust = .unchecked
  }

  static func addressKey(_ address: IPAddress) -> String {
    var bare = address.unmapped
    if case .v6(let bytes, _) = bare { bare = .v6(bytes, zone: nil) }
    return bare.description
  }

  // MARK: Devices

  /// Revokes a device: its record goes, its sessions end, and every
  /// connection it has open (HTTP, /ws, the broker) closes now.
  public func revoke(_ id: UUID) throws {
    defer { disconnect(id) }
    try devices.remove(id: id)
  }

  public func revokeAll() throws {
    let ids = devices.devices.map(\.id)
    defer { ids.forEach(disconnect) }
    try devices.removeAll()
  }

  private func disconnect(_ id: UUID) {
    sessions.revoke(deviceId: id)
    for connection in connections.values where connection.deviceId == id { connection.terminate() }
    onChange?()
  }

  // MARK: Pairing

  /// "Pair a device…": a fresh code, replacing any other.
  @discardableResult
  public func openPairing(code: PairingCode = .generate()) -> GatewayPairingWindow {
    let window = pairing.open(now: now, code: code)
    onChange?()
    return window
  }

  public func closePairing() {
    pairing.close()
    onChange?()
  }

  /// POST /_hivemind/pair (docs/remote-access.md#pairing).
  func pair(_ head: HTTPRequestHead, body: Data, remote: IPAddress) -> GatewayReply {
    guard pairLimiter.allow(Self.addressKey(remote), now: now) else {
      return .error(GatewayError(.rateLimited, "Too many pairing attempts. Wait a minute."))
    }
    guard Self.isJSON(head) else { return .error(GatewayError(.badRequest, "Content-Type must be application/json")) }
    let code: PairingCode, name: String, platform: DevicePlatform
    do {
      let request = try JSONDecoder().decode(PairRequest.self, from: body)
      (code, name) = try request.validated()
      platform = request.platform
    } catch let error as GatewayError {
      return .error(error)
    } catch {
      return .error(GatewayError(.badRequest, "The body must be {code, deviceName, platform}"))
    }
    switch pairing.attempt(code, now: now) {
    case .refused(let reason):
      onChange?()
      deps.log("[gateway] pairing refused (\(reason.rawValue)) from \(remote)")
      return .error(GatewayError(reason, Self.pairingMessage(reason)))
    case .accepted:
      break
    }
    guard !devices.registry.isFull else {
      return .error(GatewayError(.tooManyDevices, "This Mac has \(GatewayLimits.maxDevices) paired devices. Revoke one first."))
    }
    let token = DeviceToken.generate()
    let record = DeviceRecord(name: name, platform: platform, tokenHash: token.hash, createdAt: now)
    do {
      guard try devices.add(record) else { return .error(GatewayError(.tooManyDevices, "No room for another device.")) }
    } catch {
      deps.log("[gateway] cannot save devices.json: \(error.localizedDescription)")
      return .error(GatewayError(.internal, "The Mac could not save the device."))
    }
    pairing.completed(deviceName: name)
    deps.log("[gateway] paired \(name) (\(platform.rawValue)) from \(remote)")
    onChange?()
    return .json(PairResponse(deviceId: record.id, token: token, name: configuration.macName))
  }

  static func pairingMessage(_ code: GatewayErrorCode) -> String {
    switch code {
    case .pairingClosed: "No pairing code is shown on the Mac. Choose Pair a Device… in Hivemind Server."
    case .pairingLocked: "Too many wrong codes. Show a new code on the Mac."
    default: "The pairing code is wrong or has expired. Show a new code on the Mac."
    }
  }

  /// POST /_hivemind/session (docs/remote-access.md#device-sessions).
  func session(_ head: HTTPRequestHead, remote: IPAddress) -> GatewayReply {
    guard sessionLimiter.allow(Self.addressKey(remote), now: now) else {
      return .error(GatewayError(.rateLimited, "Too many session attempts. Wait a minute."))
    }
    let authorizations = head.headers.values(GatewayHeader.authorization)
    guard authorizations.count == 1, let token = GatewayHeader.deviceToken(fromAuthorization: authorizations[0]),
          let device = devices.registry.device(tokenHash: token)
    else { return .error(GatewayError(.deviceRevoked, "This device is not paired with this Mac.")) }
    let session = sessions.create(for: device.id, now: now)
    devices.touch(id: device.id, at: now)
    onChange?()
    return .json(SessionResponse(token: session.token, expiresAt: session.expiresAt, home: configuration.home),
                 extra: ["Set-Cookie": DeviceSessionCookie.setCookie(session.token)])
  }

  /// The device a request's session cookie belongs to, if it is live and the
  /// device is still paired.
  func authenticate(_ head: HTTPRequestHead) -> DeviceRecord? {
    guard let token = GatewayPolicy.sessionToken(head), let id = sessions.device(for: token, now: now) else { return nil }
    return devices.registry.device(id: id)
  }

  static func isJSON(_ head: HTTPRequestHead) -> Bool {
    let values = head.headers.values("Content-Type")
    guard values.count == 1 else { return false }
    return values[0].split(separator: ";", maxSplits: 1)[0].trimmingCharacters(in: .whitespaces).lowercased() == "application/json"
  }

  // MARK: The verified server

  /// Whether the last check proved `server` is Hivemind Server.app's own.
  public var isVerified: Bool {
    guard let current = deps.server(), case .verified(let known) = trust else { return false }
    return known == current
  }

  /// Runs `work` once `server` is known to be verified, or not
  /// (docs/remote-access.md#verified-server). A server verified before is
  /// taken as it is unless `fresh` (every WebSocket upgrade, /ws and the
  /// broker, checks again); one that failed is refused for
  /// recheckAfterFailure. Concurrent callers share one check.
  func withVerifiedServer(
    _ server: GatewayUpstreamServer, fresh: Bool = false, _ work: @escaping @MainActor (GatewayServerVerdict) -> Void
  ) {
    switch trust {
    case .verified(let known) where known == server && !fresh:
      return work(.verified)
    case .failed(let known, let at) where known == server && now.timeIntervalSince(at) < Self.recheckAfterFailure:
      return work(.unverified)
    default:
      break
    }
    if let check, check.server == server {
      check.waiters.append(work)
      return
    }
    // A check of a server that is no longer the one running answers nobody.
    check?.finish(.unavailable)
    let check = GatewayServerCheck(server: server)
    check.waiters.append(work)
    self.check = check
    check.timer = deps.scheduler.schedule(after: Self.verificationTimeout) { [weak self, weak check] in
      guard let self, let check, self.check === check else { return }
      self.check = nil
      self.deps.log("[gateway] the server on port \(server.port) did not answer the instance check in time")
      check.finish(.unavailable)
    }
    deps.verifier.verify(server) { [weak self, weak check] result in
      guard let self, let check, self.check === check else { return }
      self.check = nil
      check.finish(self.settle(result, for: server))
    }
  }

  private func settle(_ result: InstanceVerification, for server: GatewayUpstreamServer) -> GatewayServerVerdict {
    switch result {
    case .verified:
      if trust != .verified(server) { deps.log("[gateway] verified the server on port \(server.port)") }
      trust = .verified(server)
      return .verified
    case .failed(.unreachable(let reason)):
      trust = .unchecked
      deps.log("[gateway] the server on port \(server.port) did not answer the instance check (\(reason))")
      return .unavailable
    case .failed(let failure):
      if case .failed(let known, _) = trust, known == server {} else {
        deps.log("[gateway] refusing devices: the server on port \(server.port) could not be verified: \(failure.logText)")
      }
      trust = .failed(server, at: now)
      // Nothing more goes to it: not the Human capability, not a request,
      // not a WebSocket, not the terminals.
      capability = nil
      bootstrap?.finish(nil)
      bootstrap = nil
      for connection in Array(connections.values) where connection.isForwarding { connection.terminate() }
      return .unverified
    }
  }

  /// Hivemind Server.app's supervisor saw its server exit or leave `.running`
  /// (stopping, restarting, crashed), or a new one become ready
  /// (docs/remote-access.md#verified-server). Nothing that belongs to a
  /// server other than the current one is used again: its verification, its
  /// Human capability, a check or a bootstrap in flight (whose requests get
  /// server-unavailable), and every proxied request and `/ws` to it, which
  /// close now. Requests from here on wait for the next server to prove
  /// itself. Terminal bridges stay: the broker is this app's own, not the
  /// Node server's. Called on every supervisor state change; nothing happens
  /// while the current server is the one the gateway already knows.
  public func serverChanged() {
    let current = deps.server()
    var dropped = false
    switch trust {
    case .verified(let known) where known != current, .failed(let known, _) where known != current:
      trust = .unchecked
      dropped = true
    default:
      break
    }
    if let held = capability, held.server != current {
      capability = nil
      dropped = true
    }
    if let pending = check, pending.server != current {
      check = nil
      pending.finish(.unavailable)
      dropped = true
    }
    if let pending = bootstrap, pending.server != current {
      bootstrap = nil
      pending.finish(nil)
      dropped = true
    }
    var closed = 0
    for connection in Array(connections.values) where connection.serverGone(keeping: current) { closed += 1 }
    guard dropped || closed > 0 else { return }
    let what = current.map { "the server on port \($0.port) is new" } ?? "the server stopped"
    deps.log("[gateway] \(what): forwarding nothing until it is verified (\(closed) forwarded connection(s) ended)")
  }

  /// A loopback connection to the server failed, or it closed without an
  /// answer: whatever answers next is checked again first.
  func upstreamLost() {
    if case .verified = trust { trust = .unchecked }
  }

  // MARK: Human capability

  /// The Human capability for `server`, once it is verified and bootstrapping
  /// the capability first when the gateway has none
  /// (docs/remote-access.md#proxy). Concurrent callers share one bootstrap.
  func withCapability(
    _ server: GatewayUpstreamServer, fresh: Bool = false, _ work: @escaping @MainActor (GatewayUpstreamAccess) -> Void
  ) {
    withVerifiedServer(server, fresh: fresh) { [weak self] verdict in
      guard let self else { return work(.unavailable) }
      switch verdict {
      case .unavailable: work(.unavailable)
      case .unverified: work(.unverified)
      case .verified: self.capability(for: server) { value in work(value.map(GatewayUpstreamAccess.capability) ?? .unavailable) }
      }
    }
  }

  private func capability(for server: GatewayUpstreamServer, _ work: @escaping @MainActor (HumanCapability?) -> Void) {
    if let capability, capability.server == server { return work(capability.value) }
    if let bootstrap, bootstrap.server == server {
      bootstrap.waiters.append(work)
      return
    }
    bootstrap?.finish(nil)
    let port = server.port
    let bootstrap = CapabilityBootstrap(server: server, stream: deps.upstream.connect(port: port))
    bootstrap.waiters.append(work)
    self.bootstrap = bootstrap
    bootstrap.onDone = { [weak self, weak bootstrap] value in
      guard let self, let bootstrap, self.bootstrap === bootstrap else { return }
      self.bootstrap = nil
      if let value {
        self.capability = (server, value)
      } else {
        self.deps.log("[gateway] the server on port \(port) gave no Human session")
        self.upstreamLost()
      }
    }
    bootstrap.timer = deps.scheduler.schedule(after: Self.bootstrapTimeout) { [weak bootstrap] in bootstrap?.finish(nil) }
    bootstrap.start()
  }

  /// The server said the capability is stale (it restarted): the next
  /// request verifies the server and bootstraps again. Only the one that was
  /// used is dropped, so a late 401 cannot throw away a newer capability.
  func invalidate(_ used: HumanCapability) {
    guard capability?.value == used else { return }
    capability = nil
    upstreamLost()
  }
}

/// What a proxied request gets before it goes out.
enum GatewayUpstreamAccess {
  case capability(HumanCapability)
  case unavailable
  case unverified
}

/// A reply to a gateway endpoint.
struct GatewayReply {
  let status: Int
  let headers: HTTPHeaders
  let body: Data

  static func json(_ value: some Encodable, extra: HTTPHeaders = HTTPHeaders()) -> GatewayReply {
    let body = (try? JSONEncoder().encode(value)) ?? Data("{}".utf8)
    return GatewayReply(status: 200, headers: extra, body: body)
  }

  static func error(_ error: GatewayError) -> GatewayReply {
    var headers = HTTPHeaders()
    if error.code == .unauthorized { headers.add(GatewayHeader.deviceSession, GatewayHeader.deviceSessionRequired) }
    return GatewayReply(status: error.code.httpStatus, headers: headers, body: (try? JSONEncoder().encode(error)) ?? Data())
  }

  /// The whole response. Gateway replies are never cached and never sniffed.
  func serialized(close: Bool) -> Data {
    var headers = HTTPHeaders([
      HTTPField("Content-Type", "application/json"),
      HTTPField("Cache-Control", "no-store"),
      HTTPField("X-Content-Type-Options", "nosniff"),
      HTTPField("Content-Length", String(body.count)),
    ])
    for field in self.headers.fields { headers.add(field.name, field.value) }
    if close { headers.add("Connection", "close") }
    var out = HTTPResponseHead(status: status, headers: headers).serialized
    out.append(body)
    return out
  }
}

/// One POST /api/ui/session to the Node server, as a native client makes it.
@MainActor
final class CapabilityBootstrap {
  let server: GatewayUpstreamServer
  var port: Int { server.port }
  let stream: any GatewayStream
  var waiters: [@MainActor (HumanCapability?) -> Void] = []
  var onDone: (@MainActor (HumanCapability?) -> Void)?
  var timer: (any Cancellable)?
  private var buffer = Data()
  private var done = false

  init(server: GatewayUpstreamServer, stream: any GatewayStream) {
    self.server = server
    self.stream = stream
  }

  func start() {
    stream.start(handlers: GatewayStreamHandlers(
      onData: { [weak self] data in self?.received(data) },
      onClose: { [weak self] _ in self?.finish(nil) }))
    stream.send(HumanCapability.bootstrapRequest(port: port)) {}
  }

  private func received(_ data: Data) {
    buffer.append(data)
    do {
      guard let (head, _) = try HTTPHeadParser.response(in: buffer) else { return }
      finish(head.status == 200 ? HumanCapability(setCookie: head.headers.values("Set-Cookie"), port: port) : nil)
    } catch {
      finish(nil)
    }
  }

  func finish(_ value: HumanCapability?) {
    guard !done else { return }
    done = true
    timer?.cancel()
    stream.close()
    onDone?(value)
    let waiters = self.waiters
    self.waiters = []
    for waiter in waiters { waiter(value) }
  }
}
