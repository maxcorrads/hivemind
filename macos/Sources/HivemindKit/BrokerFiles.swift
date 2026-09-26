import Foundation

/// The files the broker keeps next to its socket, rewritten on every start:
/// the app-support folder tightened to 0700, Hivemind's tmux.conf and a fresh
/// capability token, both 0600. The socket itself is the transport's job.
///
/// Order matters: `start` publishes the token only once the socket is this
/// broker's. A start that finds another broker still listening fails before
/// it touches that broker's token, which its clients read on every connect.
public struct BrokerFiles: Sendable {
  public let paths: HivemindPaths

  public static let folderMode: mode_t = 0o700
  public static let fileMode: mode_t = 0o600

  public init(paths: HivemindPaths) {
    self.paths = paths
  }

  public struct Failure: Error, Equatable, LocalizedError {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
  }

  /// A broker's start around `listen`, which binds the socket and throws
  /// when it cannot (another broker still answers on it, say): the folder
  /// is made first, then `listen` runs, and only
  /// after it succeeded are tmux.conf and a fresh token written. A failed
  /// listen leaves both files as they were, so a running broker's clients
  /// keep a token that matches. When writing them fails after all,
  /// `unlisten` gives the socket back before the error is thrown.
  public func start(
    token: BrokerToken = .generate(), listen: () throws -> Void, unlisten: () -> Void
  ) throws -> BrokerToken {
    try prepareFolder()
    try listen()
    do {
      try publish(token)
    } catch {
      unlisten()
      throw error
    }
    return token
  }

  /// Writes tmux.conf and `token`, which replaces the old one: a client reads
  /// it before every connection. Only for a broker that owns the socket.
  public func publish(_ token: BrokerToken) throws(Failure) {
    try prepareFolder()
    try Self.writePrivately(Data(TmuxCommand.configText.utf8), to: paths.tmuxConfig)
    try Self.writePrivately(Data((token.value + "\n").utf8), to: paths.brokerToken)
  }

  /// A home folder long enough to overflow sockaddr_un is reported, never
  /// truncated into another path.
  public func checkSocketPath() throws(Failure) {
    guard BrokerPaths.fitsSocketAddress(paths.brokerSocket) else {
      throw Failure("The broker socket path is too long for a Unix socket: \(paths.brokerSocket.path)")
    }
  }

  /// Creates the folder, or tightens an existing one, to 0700, and makes
  /// sure it belongs to this user.
  public func prepareFolder() throws(Failure) {
    try Self.preparePrivateFolder(paths.appSupport)
  }

  /// `folder`, created or tightened to 0700, and this user's. The discovery
  /// file shares the folder, so DiscoveryStore uses this too.
  public static func preparePrivateFolder(_ folder: URL) throws(Failure) {
    do {
      try FileManager.default.createDirectory(
        at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: Int(folderMode)])
    } catch {
      throw Failure("Cannot create \(folder.path): \(error.localizedDescription)")
    }
    var info = stat()
    guard stat(folder.path, &info) == 0, (info.st_mode & S_IFMT) == S_IFDIR else {
      throw Failure("\(folder.path) is not a folder")
    }
    guard info.st_uid == getuid() else { throw Failure("\(folder.path) belongs to another user") }
    if info.st_mode & 0o7777 != folderMode, chmod(folder.path, folderMode) != 0 {
      throw Failure("Cannot make \(folder.path) private: \(String(cString: strerror(errno)))")
    }
  }

  /// Writes `data` to a new 0600 file next to `url`, then renames it over
  /// `url`: a reader sees the old file or the new one, never a partial or a
  /// readable-by-others one.
  public static func writePrivately(_ data: Data, to url: URL) throws(Failure) {
    let temporary = url.deletingLastPathComponent()
      .appendingPathComponent(".\(url.lastPathComponent).\(UUID().uuidString)")
    let fd = open(temporary.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, fileMode)
    guard fd >= 0 else { throw Failure("Cannot write \(url.path): \(String(cString: strerror(errno)))") }
    var failure: String?
    // open's mode is filtered by the umask; fchmod is not.
    if fchmod(fd, fileMode) != 0 { failure = String(cString: strerror(errno)) }
    if failure == nil {
      failure = data.withUnsafeBytes { buffer -> String? in
        var offset = 0
        while offset < buffer.count {
          let written = Darwin.write(fd, buffer.baseAddress! + offset, buffer.count - offset)
          if written < 0 {
            if errno == EINTR { continue }
            return String(cString: strerror(errno))
          }
          offset += written
        }
        return nil
      }
    }
    close(fd)
    if failure == nil, rename(temporary.path, url.path) != 0 { failure = String(cString: strerror(errno)) }
    if let failure {
      unlink(temporary.path)
      throw Failure("Cannot write \(url.path): \(failure)")
    }
  }
}
