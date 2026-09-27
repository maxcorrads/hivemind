import Foundation

// Secrets a launch hands to its agent as environment variables, today only
// OPENCODE_API_KEY (the Launch agent sheet's "OpenCode Go API key" field).
// docs/terminal-broker.md#launch-secrets has the design. In short: a secret
// is never saved by Hivemind, never logged, and never reaches argv (not
// tmux's, not the shell's). The broker writes it, with the launch's other
// environment variables (LaunchEnvironment), to a fresh 0600 file in a
// private 0700 folder, and the session's script loads that file into its
// environment and deletes it before it does anything else.

/// A launch's secrets: allowlisted names, each with a short printable-ASCII
/// value. Its description, debug description and mirror never show a value.
public struct LaunchSecrets: Equatable, Sendable {
  /// The only names a launch may carry. OpenCode's `opencode-go` and
  /// `opencode` (Zen) providers read their key from OPENCODE_API_KEY.
  public static let allowedNames: Set<String> = ["OPENCODE_API_KEY"]
  /// UTF-8 bytes of one value, at most.
  public static let maxValueBytes = 512

  private let values: [String: String]

  /// Throws bad-message for no secret, a name off the allowlist or a value
  /// that is not 1–512 printable ASCII characters without whitespace. The
  /// message names the field, never the value.
  public init(_ values: [String: String]) throws(BrokerProtocolError) {
    try self.init(values, field: "secrets")
  }

  init(_ values: [String: String], field: String) throws(BrokerProtocolError) {
    guard !values.isEmpty else { throw .invalid(field, "must name at least one secret") }
    for (name, value) in values {
      guard Self.allowedNames.contains(name) else {
        throw .invalid(field, "only \(Self.allowedNames.sorted().joined(separator: ", ")) may be passed")
      }
      guard Self.isValidValue(value) else {
        throw .invalid("\(field).\(name)", "must be 1–\(Self.maxValueBytes) printable ASCII characters without spaces")
      }
    }
    self.values = values
  }

  /// 1–512 bytes, each printable ASCII (0x21–0x7E): no space, tab, newline,
  /// NUL or other control character, nothing outside ASCII.
  public static func isValidValue(_ value: String) -> Bool {
    let bytes = value.utf8
    return !bytes.isEmpty && bytes.count <= maxValueBytes && bytes.allSatisfy { (0x21...0x7E).contains($0) }
  }

  /// The names, sorted.
  public var names: [String] { values.keys.sorted() }

  public func value(_ name: String) -> String? { values[name] }

  /// For the wire only (BrokerRequestFrame's encoder).
  var dictionary: [String: String] { values }
}

extension LaunchSecrets: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
  public var description: String { "LaunchSecrets(" + names.map { "\($0): <redacted>" }.joined(separator: ", ") + ")" }
  public var debugDescription: String { description }
  /// What dump(_:) and a struct holding this print: the names, never the values.
  public var customMirror: Mirror {
    Mirror(self, children: names.map { (label: $0 as String?, value: "<redacted>" as Any) }, displayStyle: .struct)
  }
}

/// A launch's private file on its way to a session: every variable the
/// launch hands it (environment and secrets), one `NAME=value` per line.
public struct LaunchEnvironmentFile: Equatable, Sendable {
  public let path: String

  public init(path: String) {
    self.path = path
  }
}

extension HivemindPaths {
  /// Where the broker hands launch secrets and environment variables to their sessions (LaunchSecretStore).
  public var launchSecrets: URL { appSupport.appendingPathComponent("launch-secrets", isDirectory: true) }
}

/// The broker's folder of launch files: 0700, this user's, a real folder
/// (lstat, never a symlink). Each launch that hands its session variables
/// gets one file, created exclusively (O_EXCL | O_NOFOLLOW) at 0600 under a
/// random name, holding one `NAME=value` line per variable (`contents`), and
/// deleted by the session's script as soon as it has read it. One the script
/// never read is deleted by `sweep` after 10 minutes.
public struct LaunchSecretStore: Sendable {
  public let folder: URL

  public static let folderMode: mode_t = 0o700
  public static let fileMode: mode_t = 0o600
  /// A file older than this is a leftover (its session never read it).
  public static let maxAge: TimeInterval = 10 * 60
  static let fileExtension = "env"

  public init(folder: URL) {
    self.folder = folder
  }

  /// A fresh, unused path for one launch's file. Nothing is written yet.
  public func file() -> LaunchEnvironmentFile {
    LaunchEnvironmentFile(path: folder.appendingPathComponent("\(UUID().uuidString).\(Self.fileExtension)").path)
  }

  /// What the file holds: one `NAME=value` line per variable, each ended by a
  /// newline: the environment's, then the template's secrets, then the
  /// launch's own secrets (so a later line wins), each sorted by name. No
  /// value holds a newline (every type refuses one), so every line is one
  /// variable; the value is the rest of the line, byte for byte.
  public static func contents(environment: LaunchEnvironment?, secrets: LaunchSecrets?, templateSecrets: [String: String] = [:]) -> [UInt8] {
    var lines: [String] = []
    if let environment { lines += environment.names.map { "\($0)=\(environment.value($0)!)\n" } }
    lines += templateSecrets.keys.sorted().map { "\($0)=\(templateSecrets[$0]!)\n" }
    if let secrets { lines += secrets.names.map { "\($0)=\(secrets.value($0)!)\n" } }
    return Array(lines.joined().utf8)
  }

  /// Writes the launch's variables to `file`. On failure nothing is left
  /// behind and the error (which names a path, never a value) is thrown.
  public func write(
    environment: LaunchEnvironment?, secrets: LaunchSecrets?, templateSecrets: [String: String] = [:], to file: LaunchEnvironmentFile
  ) throws(BrokerFiles.Failure) {
    guard (file.path as NSString).deletingLastPathComponent == folder.path else {
      throw BrokerFiles.Failure("Cannot write a launch file outside \(folder.path)")
    }
    try prepareFolder()
    try Self.create(file.path, contents: Self.contents(environment: environment, secrets: secrets, templateSecrets: templateSecrets))
  }

  /// Deletes the file if it exists: for a launch whose shell never ran.
  public func remove(_ file: LaunchEnvironmentFile?) {
    if let file { unlink(file.path) }
  }

  /// Deletes every file in the folder last modified more than `maxAge` ago.
  /// Nothing is touched unless the folder is a real folder of this user's.
  @discardableResult
  public func sweep(now: Date = Date()) -> Int {
    var info = stat()
    guard lstat(folder.path, &info) == 0, info.st_mode & S_IFMT == S_IFDIR, info.st_uid == getuid(),
          let names = try? FileManager.default.contentsOfDirectory(atPath: folder.path) else { return 0 }
    let cutoff = now.timeIntervalSince1970 - Self.maxAge
    var removed = 0
    for name in names {
      let path = folder.appendingPathComponent(name).path
      var entry = stat()
      guard lstat(path, &entry) == 0, entry.st_mode & S_IFMT != S_IFDIR else { continue }
      let modified = TimeInterval(entry.st_mtimespec.tv_sec) + TimeInterval(entry.st_mtimespec.tv_nsec) / 1e9
      if modified < cutoff, unlink(path) == 0 { removed += 1 }
    }
    return removed
  }

  /// Creates the folder at 0700 or checks an existing one: a real folder
  /// (lstat), owned by this user, tightened to 0700.
  public func prepareFolder() throws(BrokerFiles.Failure) {
    if mkdir(folder.path, Self.folderMode) != 0, errno != EEXIST {
      guard errno == ENOENT else { throw Self.failure(folder.path) }
      try BrokerFiles.preparePrivateFolder(folder.deletingLastPathComponent())
      guard mkdir(folder.path, Self.folderMode) == 0 || errno == EEXIST else { throw Self.failure(folder.path) }
    }
    var info = stat()
    guard lstat(folder.path, &info) == 0 else { throw Self.failure(folder.path) }
    guard info.st_mode & S_IFMT == S_IFDIR else { throw BrokerFiles.Failure("\(folder.path) is not a folder") }
    guard info.st_uid == getuid() else { throw BrokerFiles.Failure("\(folder.path) belongs to another user") }
    if info.st_mode & 0o7777 != Self.folderMode, chmod(folder.path, Self.folderMode) != 0 { throw Self.failure(folder.path) }
  }

  private static func create(_ path: String, contents: [UInt8]) throws(BrokerFiles.Failure) {
    let fd = open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, fileMode)
    guard fd >= 0 else { throw failure(path) }
    var problem: String?
    // open's mode is filtered by the umask; fchmod is not.
    if fchmod(fd, fileMode) != 0 { problem = String(cString: strerror(errno)) }
    var offset = 0
    while problem == nil, offset < contents.count {
      let written = contents.withUnsafeBytes { Darwin.write(fd, $0.baseAddress! + offset, contents.count - offset) }
      if written < 0 {
        if errno != EINTR { problem = String(cString: strerror(errno)) }
      } else {
        offset += written
      }
    }
    close(fd)
    if let problem {
      unlink(path)
      throw BrokerFiles.Failure("Cannot write \(path): \(problem)")
    }
  }

  private static func failure(_ path: String) -> BrokerFiles.Failure {
    BrokerFiles.Failure("Cannot write \(path): \(String(cString: strerror(errno)))")
  }
}
