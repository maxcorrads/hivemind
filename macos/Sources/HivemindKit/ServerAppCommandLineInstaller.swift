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
    // Only a regular file is read: a directory would raise on read and a FIFO would block.
    guard attributes[.type] as? FileAttributeType == .typeRegular else { return .other("not a regular file") }
    guard let handle = FileHandle(forReadingAtPath: destination.path) else { return .other("a file") }
    defer { try? handle.close() }
    let head = String(decoding: (try? handle.read(upToCount: 512)) ?? Data(), as: UTF8.self)
    return head.contains(Self.marker) ? .ours : .other("a file")
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

  /// The shell command the administrator prompt runs. The wrapper travels inside the command (as base64), so root
  /// never reads a file a user process could swap for a symlink while the prompt is open. It is written to a fresh
  /// temporary file next to the destination and renamed over it. rm -f first: a link (even to a folder) is removed,
  /// never written or moved through, and a real folder there fails the install.
  public func adminInstallCommand(script: String, destination: URL) -> String {
    let folder = CommandLineTool.shellQuoted(destination.deletingLastPathComponent().path)
    let target = CommandLineTool.shellQuoted(destination.path)
    let payload = Data(script.utf8).base64EncodedString()
    return "umask 022 && /bin/mkdir -p \(folder) && t=$(/usr/bin/mktemp \(folder)/.hivemind.XXXXXX) && "
      + "{ /usr/bin/printf '%s' '\(payload)' | /usr/bin/base64 --decode > \"$t\" && /bin/chmod 0755 \"$t\""
      + " && /bin/rm -f \(target) && /bin/mv -f \"$t\" \(target)"
      + " || { /bin/rm -f \"$t\"; exit 1; }; }"
  }

  /// `do shell script … with administrator privileges` running `adminInstallCommand`.
  public func adminAppleScript(script: String, destination: URL) -> String {
    "do shell script \(CommandLineTool.appleScriptLiteral(adminInstallCommand(script: script, destination: destination))) with administrator privileges"
  }
}
