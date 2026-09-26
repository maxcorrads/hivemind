import Foundation

/// ~/Library/Application Support/Hivemind/server.json: how the UI app finds a
/// server the server app started. It carries no secret (the Human session is
/// a cookie the server sets per process), so it is safe to be world-readable,
/// but it is written 0600 anyway like the rest of the hive.
public struct ServerDiscovery: Codable, Equatable, Sendable {
  public var port: ServerPort
  public var pid: Int32
  /// The server's HIVEMIND_HOME, as a path.
  public var home: String
  public var startedAt: Date
  public var version: String

  public init(port: ServerPort, pid: Int32, home: String, startedAt: Date, version: String) {
    self.port = port
    self.pid = pid
    self.home = home
    self.startedAt = startedAt
    self.version = version
  }

  public var endpoint: ServerEndpoint { ServerEndpoint(port: port) }
}

public struct DiscoveryStore: Sendable {
  public let file: URL

  public init(file: URL) { self.file = file }
  public init(paths: HivemindPaths) { self.init(file: paths.discoveryFile) }

  static let encoder: JSONEncoder = {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    return encoder
  }()

  static let decoder: JSONDecoder = {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    return decoder
  }()

  /// nil when missing or unreadable: a corrupt file must never block the UI
  /// from falling back to the configured port.
  public func read() -> ServerDiscovery? {
    guard let data = try? Data(contentsOf: file) else { return nil }
    return try? Self.decoder.decode(ServerDiscovery.self, from: data)
  }

  /// The discovery only while its process is still alive; a crashed server
  /// app can leave the file behind.
  public func readLive(isAlive: (Int32) -> Bool = ProcessLiveness.isAlive) -> ServerDiscovery? {
    guard let discovery = read(), isAlive(discovery.pid) else { return nil }
    return discovery
  }

  /// Atomic replace, so a reader never sees half a file.
  public func write(_ discovery: ServerDiscovery) throws {
    let fm = FileManager.default
    try fm.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    var data = try Self.encoder.encode(discovery)
    data.append(0x0A)
    try data.write(to: file, options: .atomic)
    try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
  }

  /// Removes the file only if it still names `pid`, so stopping one server
  /// never deletes the discovery another one wrote since.
  public func remove(ifOwnedBy pid: Int32) {
    guard let current = read(), current.pid == pid else { return }
    try? FileManager.default.removeItem(at: file)
  }
}
