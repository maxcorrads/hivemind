import Foundation

/// How far a window trusts the server its page comes from
/// (docs/macos.md#verifying-the-server).
public enum ServerTrust: Hashable, Sendable {
  /// The discovery file's server answered the instance challenge: the page
  /// gets the whole bridge, terminals included.
  case verified(ServerInstance)
  /// The user chose "Open without terminals" on a server that could not be
  /// verified: the page loads, notifications and the badge work, the
  /// terminal bridge is off.
  case unverified

  public var allowsTerminals: Bool {
    if case .verified = self { true } else { false }
  }

  public var instance: ServerInstance? {
    if case .verified(let instance) = self { instance } else { nil }
  }
}

/// Why a server that answers /api/health was not verified.
public enum UnverifiedReason: Equatable, Sendable {
  /// No live discovery file names this port: a `hivemind serve` started by
  /// hand, or something else answering like Hivemind.
  case notStartedByServerApp
  /// The discovery file names it, but the challenge failed.
  case failed(InstanceVerificationFailure)

  /// A sentence for the connect screen.
  public var explanation: String {
    switch self {
    case .notStartedByServerApp:
      "Hivemind Server did not start it (for example it runs from `hivemind serve`), so the app cannot prove it is Hivemind."
    case .failed(.noSecret):
      "Its discovery file comes from an older Hivemind Server. Restart the server from Hivemind Server."
    case .failed(.notOffered):
      "It does not hold the secret Hivemind Server started its server with."
    case .failed(.wrongProof):
      "It could not prove it is the server Hivemind Server started."
    case .failed(.badAnswer(let status)):
      "It gave no valid proof (HTTP \(status))."
    case .failed(.unreachable(let reason)):
      "It stopped answering while being verified (\(reason))."
    }
  }
}

/// Where a UI window stands with the local server.
public enum UIConnectionState: Equatable, Sendable {
  case checking(ServerEndpoint)
  case connected(ServerEndpoint, ServerTrust)
  /// Something answers like Hivemind but could not be verified: the connect
  /// screen offers "Open without terminals".
  case unverified(ServerEndpoint, UnverifiedReason)
  case unreachable(ServerEndpoint, reason: String)
  /// Something answers on the port but it is not Hivemind.
  case foreign(ServerEndpoint)

  public var endpoint: ServerEndpoint {
    switch self {
    case .checking(let endpoint), .connected(let endpoint, _), .unverified(let endpoint, _), .unreachable(let endpoint, _),
      .foreign(let endpoint): endpoint
    }
  }
}

/// A server to try, and the live discovery file that named it, if any.
public struct UICandidate: Equatable, Sendable {
  public let endpoint: ServerEndpoint
  public let discovery: ServerDiscovery?

  public init(endpoint: ServerEndpoint, discovery: ServerDiscovery?) {
    self.endpoint = endpoint
    self.discovery = discovery
  }
}

/// The decision table for one candidate: health first, then, for a server
/// the discovery file names, the instance challenge. Verification is
/// required for the discovery file's server; one found only on the
/// configured or default port is never verified.
public enum UICandidateOutcome: Equatable, Sendable {
  case verified(ServerInstance)
  case unverified(UnverifiedReason)
  case foreign
  case unreachable(String)

  public static func decide(health: HealthStatus, discovery: ServerDiscovery?, verification: InstanceVerification?) -> UICandidateOutcome {
    switch health {
    case .foreign: return .foreign
    case .unreachable(let reason): return .unreachable(reason)
    case .healthy: break
    }
    guard let discovery else { return .unverified(.notStartedByServerApp) }
    switch verification {
    case .verified?: return .verified(discovery.instance)
    case .failed(let failure)?: return .unverified(.failed(failure))
    case nil: return .unverified(.failed(.noSecret))
    }
  }
}

/// Finds a server the UI can load. Like ServerLocator, but it health-checks
/// every candidate in turn, so a discovery file whose server is still binding
/// does not hide a CLI `hivemind serve` on the configured or default port.
/// A server is `connected` only once verified; one that answers but is not
/// verified is `unverified`, which the window may open without terminals.
public struct UIServerLocator: Sendable {
  private let discovery: DiscoveryStore
  private let health: HealthChecker
  private let verifier: InstanceVerifier
  private let isAlive: @Sendable (Int32) -> Bool

  public init(
    discovery: DiscoveryStore, health: HealthChecker = HealthChecker(), verifier: InstanceVerifier = InstanceVerifier(),
    isAlive: @escaping @Sendable (Int32) -> Bool = ProcessLiveness.isAlive
  ) {
    self.discovery = discovery
    self.health = health
    self.verifier = verifier
    self.isAlive = isAlive
  }

  /// The live discovery file's server, for noticing a restart or a change.
  public func liveInstance() -> ServerInstance? {
    discovery.readLive(isAlive: isAlive)?.instance
  }

  /// Live discovery file, then the configured port, then 7420; no repeats.
  public func candidates(configuredPort: ServerPort?) -> [UICandidate] {
    var candidates: [UICandidate] = []
    if let live = discovery.readLive(isAlive: isAlive) { candidates.append(UICandidate(endpoint: live.endpoint, discovery: live)) }
    for port in [configuredPort, .default].compactMap({ $0 }) where !candidates.contains(where: { $0.endpoint.port == port }) {
      candidates.append(UICandidate(endpoint: ServerEndpoint(port: port), discovery: nil))
    }
    return candidates
  }

  /// The first verified candidate; otherwise the first that answered but
  /// was not verified; otherwise how the first one failed, since that is the
  /// port the user expects to hear about.
  public func resolve(configuredPort: ServerPort?) async -> UIConnectionState {
    var firstUnverified: UIConnectionState?
    var firstFailure: UIConnectionState?
    for candidate in candidates(configuredPort: configuredPort) {
      let endpoint = candidate.endpoint
      let status = await health.check(endpoint)
      var verification: InstanceVerification?
      if status == .healthy, let discovery = candidate.discovery {
        verification = await verifier.verify(endpoint, secret: discovery.instanceSecret)
      }
      switch UICandidateOutcome.decide(health: status, discovery: candidate.discovery, verification: verification) {
      case .verified(let instance): return .connected(endpoint, .verified(instance))
      case .unverified(let reason): firstUnverified = firstUnverified ?? .unverified(endpoint, reason)
      case .foreign: firstFailure = firstFailure ?? .foreign(endpoint)
      case .unreachable(let reason): firstFailure = firstFailure ?? .unreachable(endpoint, reason: reason)
      }
    }
    return firstUnverified ?? firstFailure
      ?? .unreachable(ServerEndpoint(port: configuredPort ?? .default), reason: "No server to try")
  }
}

/// What a window does with a fresh resolve while it shows a page: after a
/// discovery change, a page load it did not start, or activation.
public enum UITrustAction: Equatable, Sendable {
  /// Nothing changes; the page keeps the trust it has.
  case keep
  /// Load the page anew from this server with this trust (a new process
  /// always means a new document).
  case load(ServerEndpoint, ServerTrust)
  /// Keep the page, but hold its terminals: the server is away, and the next
  /// discovery change decides.
  case hold
  case connectScreen(UIConnectionState)

  /// `current` is the window's connection; `acceptedUnverified` is the
  /// server the user chose to open without terminals in this window.
  public static func decide(
    current: UIConnectionState, result: UIConnectionState, acceptedUnverified: ServerEndpoint?
  ) -> UITrustAction {
    let trust: ServerTrust? = if case .connected(_, let trust) = current { trust } else { nil }
    switch result {
    case .connected(let endpoint, let newTrust):
      return current == result ? .keep : .load(endpoint, newTrust)
    case .unverified(let endpoint, _):
      if endpoint == acceptedUnverified {
        return current == .connected(endpoint, .unverified) ? .keep : .load(endpoint, .unverified)
      }
      return .connectScreen(result)
    case .unreachable, .foreign, .checking:
      // A server that is merely down is left to the page, which reconnects
      // by itself; a verified page stops using terminals meanwhile.
      return trust?.allowsTerminals == true ? .hold : .keep
    }
  }
}

/// Notices, from the live discovery file, when a window must look again: the
/// server its trust was decided on stopped, restarted or was replaced.
public struct ServerTrustWatch: Equatable, Sendable {
  public enum Action: Equatable, Sendable {
    case none
    /// The discovery file went away while the page was verified: hold its
    /// terminals, since nothing proves who answers on the port now.
    case lapse
    case reverify
  }

  /// The live discovery the window last decided on (nil: none was live).
  public private(set) var basis: ServerInstance?

  public init(basis: ServerInstance? = nil) {
    self.basis = basis
  }

  /// The window decided on `basis` just now (after a resolve).
  public mutating func decided(on basis: ServerInstance?) { self.basis = basis }

  public mutating func observe(_ live: ServerInstance?, trust: ServerTrust?) -> Action {
    guard live != basis else { return .none }
    basis = live
    guard live != nil else { return trust?.allowsTerminals == true ? .lapse : .none }
    return .reverify
  }
}

/// The words on the native connect screen.
public struct ConnectScreenContent: Equatable, Sendable {
  public let title: String
  public let detail: String
  /// Whether "Start Hivemind Server" is offered.
  public let offersServerApp: Bool
  /// Whether "Open without terminals" is offered.
  public let offersOpenWithoutTerminals: Bool

  public static let unverifiedTitle = "This server couldn't be verified"
  public static let openWithoutTerminals = "Open without terminals"

  public init(state: UIConnectionState, serverAppInstalled: Bool) {
    let address = "127.0.0.1:\(state.endpoint.port)"
    offersOpenWithoutTerminals = if case .unverified = state { true } else { false }
    switch state {
    case .checking, .connected:
      title = "Connecting to Hivemind…"
      detail = "Looking for a server on \(address)."
      offersServerApp = false
    case .unverified(_, let reason):
      title = Self.unverifiedTitle
      detail = "Something answers like Hivemind on \(address). \(reason.explanation) "
        + "\(Self.openWithoutTerminals) loads it, but agents can't be launched or attached from this window."
      offersServerApp = serverAppInstalled
    case .unreachable:
      title = "Hivemind isn't running"
      detail = serverAppInstalled
        ? "Nothing answers on \(address). Start Hivemind Server, or run `hivemind serve` in a terminal."
        : "Nothing answers on \(address). Run `hivemind serve` in a terminal, or install Hivemind Server."
      offersServerApp = serverAppInstalled
    case .foreign:
      title = "Port \(state.endpoint.port) is taken"
      detail = "Something other than Hivemind answers on \(address). Enter the port your server uses."
      offersServerApp = serverAppInstalled
    }
  }
}
