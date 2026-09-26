import Foundation

/// What the user configured in the server app's menu. `dataHome` nil means
/// the default (~/.hivemind), stored as an absent key so moving the default
/// later needs no migration.
public struct ServerAppSettings: Equatable, Sendable {
  public var port: ServerPort
  public var dataHome: URL?

  public init(port: ServerPort = .default, dataHome: URL? = nil) {
    self.port = port
    self.dataHome = dataHome
  }

  public func launchSettings(paths: HivemindPaths) -> ServerLaunchSettings {
    ServerLaunchSettings(port: port, dataHome: (dataHome ?? paths.defaultDataHome).standardizedFileURL)
  }
}

/// The slice of UserDefaults the settings use, so tests keep them in memory
/// instead of writing a preferences domain.
public protocol SettingsStorage: AnyObject {
  func object(forKey key: String) -> Any?
  func string(forKey key: String) -> String?
  func set(_ value: Any?, forKey key: String)
  func removeObject(forKey key: String)
}

extension UserDefaults: SettingsStorage {}

/// The server app's settings in its own UserDefaults. A value that no longer
/// parses (hand-edited plist, older build) falls back to the default instead
/// of stopping the server from starting.
public struct ServerAppSettingsStore {
  private let defaults: any SettingsStorage

  public init(defaults: any SettingsStorage = UserDefaults.standard) { self.defaults = defaults }

  public func load() -> ServerAppSettings {
    var settings = ServerAppSettings()
    if let port = (defaults.object(forKey: SettingsKey.port) as? NSNumber).flatMap({ ServerPort($0.intValue) }) {
      settings.port = port
    }
    if let path = defaults.string(forKey: SettingsKey.dataHome), path.hasPrefix("/") {
      settings.dataHome = URL(fileURLWithPath: path, isDirectory: true)
    }
    return settings
  }

  public func save(_ settings: ServerAppSettings) {
    if settings.port == .default {
      defaults.removeObject(forKey: SettingsKey.port)
    } else {
      defaults.set(settings.port.value, forKey: SettingsKey.port)
    }
    if let home = settings.dataHome {
      defaults.set(home.standardizedFileURL.path, forKey: SettingsKey.dataHome)
    } else {
      defaults.removeObject(forKey: SettingsKey.dataHome)
    }
  }
}

extension HivemindPaths {
  /// A path as the menu shows it: the home folder abbreviated to "~".
  public func abbreviated(_ url: URL) -> String {
    let path = url.standardizedFileURL.path
    let homePath = home.standardizedFileURL.path
    if path == homePath { return "~" }
    if path.hasPrefix(homePath + "/") { return "~" + path.dropFirst(homePath.count) }
    return path
  }
}
