import Foundation

// The files the shadow home engine reads and writes (ShadowHome, FileShadowHomes): this Mac's (LocalShadowFiles), or a
// remote host's (SnapshotShadowFiles, docs/remote-hosts.md#launch). A host's are a snapshot its own `perl` read
// (RemoteHostScripts.facts), so the same steps run on it without a round trip each; the writes they make are recorded,
// and the launch applies them on the host before its session starts.

/// What a shadow's steps need of a file tree.
public protocol ShadowFiles {
  /// The type of the entry at `path` (lstat: a symlink is never followed), or nil when nothing is there.
  func kind(of path: String) throws -> mode_t?
  /// A new folder at 0700; the caller has checked that nothing is there.
  func makeFolder(_ path: String) throws
  /// A symlink at `link` to `target`; the caller has checked that nothing is there.
  func link(_ link: String, to target: String) throws
  /// Where the symlink at `path` points, or nil.
  func destination(of path: String) -> String?
  /// Every entry of `folder` by name, hidden ones and dangling links included, sorted.
  func names(in folder: String) throws -> [String]
  /// `path` with its symlinks resolved (realpath), or `path` when it cannot be.
  func canonical(_ path: String) -> String
  /// `path` with its symlinks resolved as `URL.resolvingSymlinksInPath` does: Claude's exact-path check.
  func resolved(_ path: String) -> String
  /// The top-level `cleanupPeriodDays` of a settings file as text: "default" when the file or the key is missing.
  /// Throws for a file that is not a JSON object, since its value is unknown.
  func cleanupPeriodDays(in path: String) throws -> String
  /// The `cli_auth_credentials_store` that `<home>/config.toml` sets before its first table when it is `keyring`,
  /// `auto` or `ephemeral`, or nil.
  func credentialStore(home: String) -> String?
  /// The layout's login check on `shadow`; nothing is read of a login.
  func isLoggedIn(_ layout: ShadowLayout, shadow: String) -> Bool
}

/// This Mac's files, with the system calls the engine always made.
public struct LocalShadowFiles: ShadowFiles {
  public init() {}

  public func kind(of path: String) throws -> mode_t? {
    var info = stat()
    guard lstat(path, &info) == 0 else {
      if errno == ENOENT || errno == ENOTDIR { return nil }
      throw ShadowHomeError(path: path, message: "Cannot read `\(path)`: \(String(cString: strerror(errno)))")
    }
    return info.st_mode & S_IFMT
  }

  public func makeFolder(_ path: String) throws {
    guard mkdir(path, 0o700) == 0 else {
      throw ShadowHomeError(path: path, message: "Cannot create `\(path)`: \(String(cString: strerror(errno)))")
    }
  }

  public func link(_ link: String, to target: String) throws {
    guard symlink(target, link) == 0 else {
      throw ShadowHomeError(path: link, message: "Cannot link `\(link)` to `\(target)`: \(String(cString: strerror(errno)))")
    }
  }

  public func destination(of path: String) -> String? {
    try? FileManager.default.destinationOfSymbolicLink(atPath: path)
  }

  public func names(in folder: String) throws -> [String] {
    do {
      return try FileManager.default.contentsOfDirectory(atPath: folder).sorted()
    } catch {
      throw ShadowHomeError(path: folder, message: "Cannot read `\(folder)`: \(error.localizedDescription)")
    }
  }

  public func canonical(_ path: String) -> String {
    guard let resolved = realpath(path, nil) else { return path }
    defer { free(resolved) }
    return String(cString: resolved)
  }

  public func resolved(_ path: String) -> String {
    URL(fileURLWithPath: path).resolvingSymlinksInPath().path
  }

  public func cleanupPeriodDays(in path: String) throws -> String {
    guard FileManager.default.fileExists(atPath: path) else { return "default" }
    guard let data = FileManager.default.contents(atPath: path),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      throw ShadowHomeError(path: path, message: "`\(path)` is not a readable JSON object; fix it before launching a shadow account.")
    }
    guard let days = json["cleanupPeriodDays"], !(days is NSNull) else { return "default" }
    return "\(days)"
  }

  /// Reads `<home>/config.toml` line by line up to its first table header and nothing else; a missing file sets nothing.
  public func credentialStore(home: String) -> String? {
    guard let file = fopen(home + "/config.toml", "r") else { return nil }
    defer { fclose(file) }
    var buffer: UnsafeMutablePointer<CChar>?
    var capacity = 0
    defer { free(buffer) }
    while getline(&buffer, &capacity, file) > 0, let buffer {
      let line = String(cString: buffer)
      if line.drop(while: \.isWhitespace).first == "[" { return nil }
      if let store = ShadowFacts.credentialStore(inLine: line) { return store }
    }
    return nil
  }

  public func isLoggedIn(_ layout: ShadowLayout, shadow: String) -> Bool {
    layout.isLoggedIn(URL(fileURLWithPath: shadow))
  }
}

/// What a host's `perl` read of a shadow and its shared home (RemoteHostScripts.facts): every entry of both folders,
/// the two `cleanupPeriodDays`, the config's credential store and whether the shadow is logged in. Never a login's
/// contents: the login check runs on the host and only its answer comes back.
public struct ShadowFacts: Codable, Equatable, Sendable {
  public struct Entry: Codable, Equatable, Sendable {
    /// `dir`, `file`, `link`, `other` or `none`; or `error:<reason>` when it could not be read.
    public var kind: String
    public var link: String?
    /// realpath, when it resolves.
    public var real: String?
    /// The folder's entries by name, for the two folders.
    public var entries: [String: Entry]?

    public init(kind: String, link: String? = nil, real: String? = nil, entries: [String: Entry]? = nil) {
      self.kind = kind
      self.link = link
      self.real = real
      self.entries = entries
    }
  }

  /// The shared home and the shadow, by path.
  public var paths: [String: Entry]
  /// Each settings file's `cleanupPeriodDays` as LocalShadowFiles reads it, `invalid` for one that is not a JSON object.
  public var cleanup: [String: String]
  public var credentialStore: String?
  public var loggedIn: Bool

  public init(paths: [String: Entry], cleanup: [String: String] = [:], credentialStore: String? = nil, loggedIn: Bool = false) {
    self.paths = paths
    self.cleanup = cleanup
    self.credentialStore = credentialStore
    self.loggedIn = loggedIn
  }

  /// The credential store one config line sets, when it is one a shadow cannot use.
  static func credentialStore(inLine line: String) -> String? {
    line.firstMatch(of: /^\s*cli_auth_credentials_store\s*=\s*["']?(keyring|auto|ephemeral)["']?/).map { String($0.1) }
  }
}

/// A host's files as its facts say, with the engine's writes recorded instead of made: `actions` is what the launch
/// applies on the host, in order, before its session starts. A write updates the snapshot, so later steps see it.
public final class SnapshotShadowFiles: ShadowFiles {
  /// One write the engine made.
  public enum Action: Equatable, Sendable {
    case makeFolder(String)
    case link(String, to: String)
  }

  public private(set) var actions: [Action] = []
  private var facts: ShadowFacts

  public init(_ facts: ShadowFacts) {
    self.facts = facts
  }

  /// The folder of `path` and its name, when that folder is one the facts list.
  private func listed(_ path: String) -> (folder: String, name: String)? {
    let folder = (path as NSString).deletingLastPathComponent, name = (path as NSString).lastPathComponent
    guard facts.paths[folder]?.entries != nil else { return nil }
    return (folder, name)
  }

  private func entry(_ path: String) -> ShadowFacts.Entry? {
    if let top = facts.paths[path] { return top }
    guard let (folder, name) = listed(path) else { return nil }
    return facts.paths[folder]?.entries?[name] ?? ShadowFacts.Entry(kind: "none")
  }

  public func kind(of path: String) throws -> mode_t? {
    guard let entry = entry(path) else {
      throw ShadowHomeError(path: path, message: "Cannot read `\(path)`: the host's facts do not cover it")
    }
    switch entry.kind {
    case "none": return nil
    case "dir": return S_IFDIR
    case "file": return S_IFREG
    case "link": return S_IFLNK
    case "other": return S_IFIFO
    default:
      let reason = entry.kind.hasPrefix("error:") ? String(entry.kind.dropFirst(6)) : entry.kind
      throw ShadowHomeError(path: path, message: "Cannot read `\(path)`: \(reason)")
    }
  }

  private func record(_ path: String, _ entry: ShadowFacts.Entry) {
    if facts.paths[path] != nil {
      facts.paths[path] = entry
    } else if let (folder, name) = listed(path) {
      facts.paths[folder]?.entries?[name] = entry
    }
  }

  public func makeFolder(_ path: String) throws {
    actions.append(.makeFolder(path))
    record(path, ShadowFacts.Entry(kind: "dir", real: path, entries: [:]))
  }

  public func link(_ link: String, to target: String) throws {
    actions.append(.link(link, to: target))
    record(link, ShadowFacts.Entry(kind: "link", link: target))
  }

  public func destination(of path: String) -> String? { entry(path)?.link }

  public func names(in folder: String) throws -> [String] {
    guard let entries = facts.paths[folder]?.entries else {
      throw ShadowHomeError(path: folder, message: "Cannot read `\(folder)`: the host's facts do not list it")
    }
    return entries.filter { $0.value.kind != "none" }.keys.sorted()
  }

  public func canonical(_ path: String) -> String { facts.paths[path]?.real ?? path }

  public func resolved(_ path: String) -> String { facts.paths[path]?.real ?? path }

  public func cleanupPeriodDays(in path: String) throws -> String {
    let value = facts.cleanup[path] ?? "default"
    guard value != "invalid" else {
      throw ShadowHomeError(path: path, message: "`\(path)` is not a readable JSON object; fix it before launching a shadow account.")
    }
    return value
  }

  public func credentialStore(home: String) -> String? { facts.credentialStore }

  public func isLoggedIn(_ layout: ShadowLayout, shadow: String) -> Bool { facts.loggedIn }
}
