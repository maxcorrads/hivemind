import Foundation

/// "Install command-line tool": where the wrapper goes, whether that needs
/// the administrator prompt, and what it would replace. Writing happens only
/// after the user picked a destination (and confirmed a replacement).
public struct CommandLineInstaller: Sendable {
  public enum Existing: Equatable, Sendable {
    case none
    /// A wrapper an earlier install wrote; replaced without asking.
    case ours
    /// Anything else, e.g. the npm package's own `hivemind` link.
    case other(String)
  }

  public struct Plan: Equatable, Sendable {
    public var destination: URL
    public var needsAdmin: Bool
    public var existing: Existing
  }

  /// The comment CommandLineTool.script puts on line 2.
  static let marker = "# Installed by Hivemind Server.app"

  public let paths: HivemindPaths
  private let isWritable: @Sendable (String) -> Bool

  public init(paths: HivemindPaths, isWritable: @escaping @Sendable (String) -> Bool = {
    FileManager.default.isWritableFile(atPath: $0)
  }) {
    self.paths = paths
    self.isWritable = isWritable
  }

  public func plan(for destination: URL) -> Plan {
    Plan(destination: destination, needsAdmin: !isWritable(nearestExistingFolder(of: destination).path),
         existing: existing(at: destination))
  }

  /// The folder mkdir -p would start from: the first ancestor that exists.
  func nearestExistingFolder(of destination: URL) -> URL {
    var folder = destination.deletingLastPathComponent()
    var isDirectory: ObjCBool = false
    while folder.path != "/", !(FileManager.default.fileExists(atPath: folder.path, isDirectory: &isDirectory) && isDirectory.boolValue) {
      folder = folder.deletingLastPathComponent()
    }
    return folder
  }

  func existing(at destination: URL) -> Existing {
    let fm = FileManager.default
    // attributesOfItem does not follow a symlink, which is what we must describe.
    guard let attributes = try? fm.attributesOfItem(atPath: destination.path) else { return .none }
    if attributes[.type] as? FileAttributeType == .typeSymbolicLink {
      let target = (try? fm.destinationOfSymbolicLink(atPath: destination.path)) ?? "?"
      return .other("a link to \(target)")
    }
    guard let handle = FileHandle(forReadingAtPath: destination.path) else { return .other("a file") }
    defer { try? handle.close() }
    let head = String(decoding: handle.readData(ofLength: 512), as: UTF8.self)
    return head.contains(Self.marker) ? .ours : .other("a file")
  }

  /// A private copy of the wrapper for the administrator `install` to read.
  public func stage(_ script: String) throws -> URL {
    let fm = FileManager.default
    try fm.createDirectory(at: paths.appSupport, withIntermediateDirectories: true)
    let folder = paths.appSupport.appendingPathComponent("cli-\(UUID().uuidString)", isDirectory: true)
    try fm.createDirectory(at: folder, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    let file = folder.appendingPathComponent("hivemind")
    try Data(script.utf8).write(to: file)
    try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path)
    return file
  }

  public func unstage(_ staged: URL) {
    try? FileManager.default.removeItem(at: staged.deletingLastPathComponent())
  }

  /// Writes the wrapper where the user can write, replacing what is there
  /// (a link is removed, never followed).
  public func installDirectly(_ script: String, at destination: URL) throws {
    let fm = FileManager.default
    try fm.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
    if (try? fm.attributesOfItem(atPath: destination.path)) != nil { try fm.removeItem(at: destination) }
    try Data(script.utf8).write(to: destination, options: .atomic)
    try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: destination.path)
  }

  /// `do shell script … with administrator privileges` installing `staged`.
  /// rm -f first: install(1) would write through a symlink to its target.
  public func adminAppleScript(staged: URL, destination: URL) -> String {
    let command = "/bin/rm -f \(CommandLineTool.shellQuoted(destination.path)) && "
      + CommandLineTool.installCommand(from: staged, to: destination)
    return "do shell script \(CommandLineTool.appleScriptLiteral(command)) with administrator privileges"
  }
}
