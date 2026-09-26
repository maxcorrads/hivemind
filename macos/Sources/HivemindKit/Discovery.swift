import Darwin
import Foundation

/// ~/Library/Application Support/Hivemind/server.json: how the UI app finds a
/// server the server app started, and the secret that server proves it holds
/// (InstanceProof). The file is 0600 in the 0700 app-support folder, and
/// readers refuse any other kind of file (PrivateFile).
public struct ServerDiscovery: Codable, Equatable, Sendable {
  public var port: ServerPort
  public var pid: Int32
  /// The server's HIVEMIND_HOME, as a path.
  public var home: String
  public var startedAt: Date
  public var version: String
  /// The secret this server was started with; nil in a file an older
  /// Hivemind Server wrote, which then never verifies.
  public var instanceSecret: InstanceSecret?

  public init(
    port: ServerPort, pid: Int32, home: String, startedAt: Date, version: String, instanceSecret: InstanceSecret? = nil
  ) {
    self.port = port
    self.pid = pid
    self.home = home
    self.startedAt = startedAt
    self.version = version
    self.instanceSecret = instanceSecret
  }

  public var endpoint: ServerEndpoint { ServerEndpoint(port: port) }

  /// Which server process this names, for noticing a restart.
  public var instance: ServerInstance {
    ServerInstance(port: port, pid: pid, startedAt: startedAt, secret: instanceSecret)
  }
}

/// One run of a server, as its discovery file names it. Two runs never share
/// a secret, so a restart on the same port and even a recycled pid differ.
public struct ServerInstance: Hashable, Sendable {
  public let port: ServerPort
  public let pid: Int32
  public let startedAt: Date
  public let secret: InstanceSecret?

  public init(port: ServerPort, pid: Int32, startedAt: Date, secret: InstanceSecret?) {
    self.port = port
    self.pid = pid
    self.startedAt = startedAt
    self.secret = secret
  }

  public var endpoint: ServerEndpoint { ServerEndpoint(port: port) }
}

/// Reads a file that holds a secret only when it is what its writer made: a
/// regular file (not a symlink, which O_NOFOLLOW refuses), owned by this
/// user, mode exactly 0600. Checked on the open descriptor, so the file
/// cannot be swapped between the check and the read.
public enum PrivateFile {
  public enum Refusal: Error, Equatable, Sendable {
    case missing
    case symlink
    case notRegular
    case wrongOwner
    case wrongMode(mode_t)
    case tooLarge
    case unreadable(Int32)
  }

  public static func read(_ url: URL, maxBytes: Int) -> Result<Data, Refusal> {
    let fd = open(url.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK)
    guard fd >= 0 else {
      switch errno {
      case ENOENT: return .failure(.missing)
      case ELOOP: return .failure(.symlink)
      default: return .failure(.unreadable(errno))
      }
    }
    defer { close(fd) }
    var info = stat()
    guard fstat(fd, &info) == 0 else { return .failure(.unreadable(errno)) }
    guard (info.st_mode & S_IFMT) == S_IFREG else { return .failure(.notRegular) }
    guard info.st_uid == geteuid() else { return .failure(.wrongOwner) }
    guard info.st_mode & 0o7777 == 0o600 else { return .failure(.wrongMode(info.st_mode & 0o7777)) }
    guard info.st_size <= off_t(maxBytes) else { return .failure(.tooLarge) }
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 4096)
    while data.count <= maxBytes {
      let count = buffer.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, $0.count) }
      if count < 0, errno == EINTR { continue }
      if count < 0 { return .failure(.unreadable(errno)) }
      if count == 0 { return .success(data) }
      data.append(contentsOf: buffer[0..<count])
    }
    return .failure(.tooLarge)
  }
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

  /// A discovery file is a few hundred bytes.
  static let maxBytes = 16 * 1024

  /// nil when missing, unreadable, corrupt or not a private file of this
  /// user's (PrivateFile): such a file must never block the UI from falling
  /// back to the configured port, and it is never trusted.
  public func read() -> ServerDiscovery? {
    guard case .success(let data) = PrivateFile.read(file, maxBytes: Self.maxBytes) else { return nil }
    return try? Self.decoder.decode(ServerDiscovery.self, from: data)
  }

  /// The discovery only while its process is still alive; a crashed server
  /// app can leave the file behind.
  public func readLive(isAlive: (Int32) -> Bool = ProcessLiveness.isAlive) -> ServerDiscovery? {
    guard let discovery = read(), isAlive(discovery.pid) else { return nil }
    return discovery
  }

  /// Into the 0700 folder, as a new 0600 file renamed over the old one: a
  /// reader never sees half a file, nor the secret in a file others can read.
  public func write(_ discovery: ServerDiscovery) throws {
    try BrokerFiles.preparePrivateFolder(file.deletingLastPathComponent())
    var data = try Self.encoder.encode(discovery)
    data.append(0x0A)
    try BrokerFiles.writePrivately(data, to: file)
  }

  /// Removes the file only if it still names `pid`, so stopping one server
  /// never deletes the discovery another one wrote since.
  public func remove(ifOwnedBy pid: Int32) {
    guard let current = read(), current.pid == pid else { return }
    try? FileManager.default.removeItem(at: file)
  }
}
