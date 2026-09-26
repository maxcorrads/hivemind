import Foundation

/// Every file location both apps agree on. `home` is injectable so tests (and
/// a sandboxed future) never touch the real ~/.hivemind or ~/Library.
public struct HivemindPaths: Sendable, Equatable {
  public let home: URL

  public init(home: URL = FileManager.default.homeDirectoryForCurrentUser) {
    self.home = home
  }

  /// The server's HIVEMIND_HOME when the user has not chosen another.
  public var defaultDataHome: URL { home.appendingPathComponent(".hivemind", isDirectory: true) }

  /// ~/Library/Application Support/Hivemind — shared by both apps, so neither
  /// may use its own bundle id folder here.
  public var appSupport: URL {
    home.appendingPathComponent("Library/Application Support/Hivemind", isDirectory: true)
  }

  /// Written by the server app while its server runs; read by the UI app.
  public var discoveryFile: URL { appSupport.appendingPathComponent("server.json") }

  public var logsDirectory: URL { home.appendingPathComponent("Library/Logs/Hivemind", isDirectory: true) }

  public var serverLog: URL { logsDirectory.appendingPathComponent("server.log") }

  /// Destinations offered by "Install command-line tool". The first needs an
  /// administrator prompt; the second never does.
  public var systemCommandLineTool: URL { URL(fileURLWithPath: "/usr/local/bin/hivemind") }
  public var userCommandLineTool: URL { home.appendingPathComponent(".local/bin/hivemind") }

  /// The single-instance lock `hivemind serve` keeps in its data home
  /// (INSTANCE_LOCK_FILE in src/server/instance-lock.ts).
  public static func lockFile(dataHome: URL) -> URL {
    dataHome.appendingPathComponent("server.lock")
  }

  /// Expands a leading "~" the way a user types a data folder.
  public func expandingTilde(_ path: String) -> URL {
    if path == "~" { return home }
    if path.hasPrefix("~/") { return home.appendingPathComponent(String(path.dropFirst(2)), isDirectory: true) }
    return URL(fileURLWithPath: path, isDirectory: true)
  }
}
