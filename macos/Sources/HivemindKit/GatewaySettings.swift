import Foundation

/// The menu's remote-access settings: off by default, on port 7443.
public struct GatewaySettings: Equatable, Sendable {
  public static let defaultPort = ServerPort(GatewayLimits.defaultPort)!

  public var enabled: Bool
  public var port: ServerPort

  public init(enabled: Bool = false, port: ServerPort = GatewaySettings.defaultPort) {
    self.enabled = enabled
    self.port = port
  }
}

/// The settings in the server app's UserDefaults, next to ServerAppSettings.
/// Anything unreadable falls back to the default, which is "off".
public struct GatewaySettingsStore {
  public static let enabledKey = "remoteAccess"
  public static let portKey = "remoteAccessPort"

  private let defaults: any SettingsStorage

  public init(defaults: any SettingsStorage = UserDefaults.standard) { self.defaults = defaults }

  public func load() -> GatewaySettings {
    var settings = GatewaySettings()
    settings.enabled = (defaults.object(forKey: Self.enabledKey) as? NSNumber)?.boolValue ?? false
    if let port = (defaults.object(forKey: Self.portKey) as? NSNumber).flatMap({ ServerPort($0.intValue) }) {
      settings.port = port
    }
    return settings
  }

  public func save(_ settings: GatewaySettings) {
    if settings.enabled {
      defaults.set(true, forKey: Self.enabledKey)
    } else {
      defaults.removeObject(forKey: Self.enabledKey)
    }
    if settings.port == GatewaySettings.defaultPort {
      defaults.removeObject(forKey: Self.portKey)
    } else {
      defaults.set(settings.port.value, forKey: Self.portKey)
    }
  }
}

/// Which listeners to open and close when the Mac's addresses change
/// (docs/remote-access.md#network-scope): one per private address.
public struct GatewayListenPlan: Equatable, Sendable {
  public let open: [InterfaceAddress]
  public let close: [InterfaceAddress]

  public init(current: Set<InterfaceAddress>, interfaces: [InterfaceAddress]) {
    let wanted = RemoteAddressPolicy.listenAddresses(interfaces)
    open = wanted.filter { !current.contains($0) }
    let wantedSet = Set(wanted)
    close = current.filter { !wantedSet.contains($0) }.sorted { $0.address.description < $1.address.description }
  }

  public var isEmpty: Bool { open.isEmpty && close.isEmpty }
}

/// What the menu says about remote access.
public struct GatewayStatus: Equatable, Sendable {
  public enum State: Equatable, Sendable {
    case off
    /// Listening on these addresses.
    case on(addresses: [IPAddress], port: Int)
    /// On, but no private network is up.
    case noNetwork(port: Int)
    case failed(String)
  }

  public let state: State
  public let deviceCount: Int

  public init(state: State, deviceCount: Int) {
    self.state = state
    self.deviceCount = deviceCount
  }

  public var title: String {
    switch state {
    case .off: return "Remote Access: Off"
    case .on(let addresses, let port):
      let shown = addresses.prefix(2).map { GatewayEndpoint(host: $0.description, port: port)?.description ?? $0.description }
      let more = addresses.count > 2 ? " +\(addresses.count - 2)" : ""
      return "Remote Access: \(shown.joined(separator: ", "))\(more)"
    case .noNetwork: return "Remote Access: waiting for a private network"
    case .failed(let message): return "Remote Access failed: \(message)"
    }
  }

  public var devicesTitle: String {
    deviceCount == 1 ? "1 paired device" : "\(deviceCount) paired devices"
  }
}
