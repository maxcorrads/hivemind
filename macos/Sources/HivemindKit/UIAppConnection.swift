import Foundation

/// Where a UI window stands with the local server.
public enum UIConnectionState: Equatable, Sendable {
  case checking(ServerEndpoint)
  case connected(ServerEndpoint)
  case unreachable(ServerEndpoint, reason: String)
  /// Something answers on the port but it is not Hivemind.
  case foreign(ServerEndpoint)

  public var endpoint: ServerEndpoint {
    switch self {
    case .checking(let endpoint), .connected(let endpoint), .unreachable(let endpoint, _), .foreign(let endpoint): endpoint
    }
  }
}

/// Finds a server the UI can load. Like ServerLocator, but it health-checks
/// every candidate in turn, so a discovery file whose server is still binding
/// does not hide a CLI `hivemind serve` on the configured or default port.
public struct UIServerLocator: Sendable {
  private let discovery: DiscoveryStore
  private let health: HealthChecker
  private let isAlive: @Sendable (Int32) -> Bool

  public init(
    discovery: DiscoveryStore, health: HealthChecker = HealthChecker(),
    isAlive: @escaping @Sendable (Int32) -> Bool = ProcessLiveness.isAlive
  ) {
    self.discovery = discovery
    self.health = health
    self.isAlive = isAlive
  }

  /// Live discovery file, then the configured port, then 7420; no repeats.
  public func candidates(configuredPort: ServerPort?) -> [ServerEndpoint] {
    var ports: [ServerPort] = []
    if let live = discovery.readLive(isAlive: isAlive) { ports.append(live.port) }
    for port in [configuredPort, .default].compactMap({ $0 }) where !ports.contains(port) { ports.append(port) }
    return ports.map(ServerEndpoint.init(port:))
  }

  /// The first healthy candidate; otherwise how the first one failed, since
  /// that is the port the user expects to hear about.
  public func resolve(configuredPort: ServerPort?) async -> UIConnectionState {
    let endpoints = candidates(configuredPort: configuredPort)
    var firstFailure: UIConnectionState?
    for endpoint in endpoints {
      switch await health.check(endpoint) {
      case .healthy: return .connected(endpoint)
      case .foreign: firstFailure = firstFailure ?? .foreign(endpoint)
      case .unreachable(let reason): firstFailure = firstFailure ?? .unreachable(endpoint, reason: reason)
      }
    }
    return firstFailure ?? .unreachable(ServerEndpoint(port: configuredPort ?? .default), reason: "No server to try")
  }
}

/// The words on the native connect screen.
public struct ConnectScreenContent: Equatable, Sendable {
  public let title: String
  public let detail: String
  /// Whether "Start Hivemind Server" is offered.
  public let offersServerApp: Bool

  public init(state: UIConnectionState, serverAppInstalled: Bool) {
    let address = "127.0.0.1:\(state.endpoint.port)"
    switch state {
    case .checking, .connected:
      title = "Connecting to Hivemind…"
      detail = "Looking for a server on \(address)."
      offersServerApp = false
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
