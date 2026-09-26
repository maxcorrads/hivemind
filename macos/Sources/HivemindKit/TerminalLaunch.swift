import Foundation

// "Open in Terminal": Terminal.app windows attached to Hivemind's tmux
// sessions. The app builds each launch itself (TerminalBridgeRouter, from
// TmuxCommand.attachShellLine); the page never supplies the command. Each
// one becomes a self-deleting .command file that Terminal opens like a
// double-clicked script, so no Apple Events (Automation permission) are
// needed. docs/macos.md#security-note has the security note.

/// One Terminal.app window to open.
public struct TerminalLaunch: Equatable, Sendable {
  /// Window title, e.g. "Acme - Atlas".
  public let title: String
  /// Folder to start in: absolute, or "~" / "~/…". Nil: the login shell's own.
  public let cwd: String?
  /// Shell text run in the folder, as the sheet's Copy would copy it.
  public let command: String

  public static let maxCommandBytes = 8 * 1024
  public static let maxTitleLength = 200
  public static let maxPathBytes = 1024

  /// Nil for anything outside the limits; the caller drops the whole message.
  public init?(title: String, cwd: String?, command: String) {
    guard title.count <= Self.maxTitleLength, !title.contains("\0") else { return nil }
    guard !command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
          command.utf8.count <= Self.maxCommandBytes, !command.contains("\0") else { return nil }
    if let cwd {
      guard !cwd.isEmpty, cwd.utf8.count <= Self.maxPathBytes, !cwd.contains("\0"),
            cwd.hasPrefix("/") || cwd == "~" || cwd.hasPrefix("~/") else { return nil }
    }
    self.title = title
    self.cwd = cwd
    self.command = command
  }

  /// `cwd` with a leading "~" replaced by `home`.
  public func folder(home: String) -> String? {
    guard let cwd else { return nil }
    if cwd == "~" { return home }
    if cwd.hasPrefix("~/") { return (home.hasSuffix("/") ? String(home.dropLast()) : home) + cwd.dropFirst() }
    return cwd
  }
}

/// The .command file for a launch. Pure text; nothing here runs a shell.
public enum TerminalScript {
  /// Login shell, so the user's PATH (claude, codex, …) is set up as in any
  /// new Terminal window. The script deletes itself first, cds, runs the
  /// command, then stays open in an interactive login shell.
  public static func contents(for launch: TerminalLaunch, home: String) -> String {
    var lines = [
      "#!/bin/zsh -l",
      #"rm -f -- "$0""#,
      #"printf '\033]0;%s\007' "# + shellQuoted(displayTitle(launch.title)),
    ]
    if let folder = launch.folder(home: home) {
      lines.append("cd -- \(shellQuoted(folder)) || exit 1")
    }
    // The command as is. Its trailing newlines are the script's; the blank
    // line after it ends a trailing backslash continuation before `exec`.
    var command = launch.command
    while command.hasSuffix("\n") || command.hasSuffix("\r") { command.removeLast() }
    lines.append(command)
    lines.append("")
    lines.append(#"exec "${SHELL:-/bin/zsh}" -l"#)
    return lines.joined(separator: "\n") + "\n"
  }

  /// POSIX single quoting: every byte literal, including newlines and
  /// non-ASCII; a quote becomes '\''.
  public static func shellQuoted(_ value: String) -> String {
    "'" + value.replacingOccurrences(of: "'", with: #"'\''"#) + "'"
  }

  /// The window title: one line, no control characters.
  public static func displayTitle(_ title: String) -> String {
    let cleaned = String(String.UnicodeScalarView(title.unicodeScalars.map { scalar in
      CharacterSet.controlCharacters.contains(scalar) || CharacterSet.newlines.contains(scalar) ? " " : scalar
    }))
    let collapsed = cleaned.split(whereSeparator: \.isWhitespace).joined(separator: " ")
    return collapsed.isEmpty ? "Hivemind" : collapsed
  }

  static let maxFileNameLength = 80

  /// "<title>.command" without path separators, a Finder ":" or a leading
  /// dot, at most 80 characters before the extension.
  public static func fileName(for title: String, suffix: Int? = nil) -> String {
    var name = displayTitle(title)
      .replacingOccurrences(of: "/", with: "-")
      .replacingOccurrences(of: ":", with: "-")
    while name.hasPrefix(".") || name.hasPrefix(" ") { name.removeFirst() }
    if name.count > maxFileNameLength { name = String(name.prefix(maxFileNameLength)) }
    name = name.trimmingCharacters(in: .whitespaces)
    if name.isEmpty { name = "Hivemind" }
    if let suffix { name += " \(suffix)" }
    return name + ".command"
  }
}

/// Opens a written script in Terminal.app. The app's is NSWorkspace; tests
/// use a fake, so nothing is ever opened by them.
@MainActor
public protocol TerminalOpening {
  /// Throws when Terminal cannot be asked at all; the launcher then deletes
  /// the script. A later asynchronous failure is the opener's to report.
  func open(script: URL) throws
}

public enum TerminalLaunchOutcome: Equatable, Sendable {
  case opened(URL)
  /// The folder (tilde expanded) is not a directory; nothing was written.
  case missingFolder(title: String, folder: String)
  case failed(title: String, reason: String)
}

/// Writes one script per launch into a private folder and hands each to the
/// opener, in order.
@MainActor
public struct TerminalLauncher {
  public let directory: URL
  public let home: String
  private let opener: any TerminalOpening
  private let folderExists: (String) -> Bool
  private let now: () -> Date

  /// Scripts Terminal never ran (it was quit before opening them) go after this.
  public static let staleAge: TimeInterval = 24 * 60 * 60

  /// FileManager.temporaryDirectory/Hivemind/terminal: the per-user temp
  /// folder, itself private to the user.
  public static func defaultDirectory(temporary: URL = FileManager.default.temporaryDirectory) -> URL {
    temporary.appendingPathComponent("Hivemind", isDirectory: true).appendingPathComponent("terminal", isDirectory: true)
  }

  public init(
    directory: URL, home: String, opener: any TerminalOpening,
    folderExists: @escaping (String) -> Bool = TerminalLauncher.isDirectory, now: @escaping () -> Date = Date.init
  ) {
    self.directory = directory
    self.home = home
    self.opener = opener
    self.folderExists = folderExists
    self.now = now
  }

  public nonisolated static func isDirectory(_ path: String) -> Bool {
    var isDirectory: ObjCBool = false
    return FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory) && isDirectory.boolValue
  }

  public func launch(_ launches: [TerminalLaunch]) -> [TerminalLaunchOutcome] {
    do {
      try prepareDirectory()
    } catch {
      return launches.map { .failed(title: TerminalScript.displayTitle($0.title), reason: error.localizedDescription) }
    }
    removeStaleScripts()
    return launches.map(launchOne)
  }

  private func launchOne(_ launch: TerminalLaunch) -> TerminalLaunchOutcome {
    let title = TerminalScript.displayTitle(launch.title)
    if let folder = launch.folder(home: home), !folderExists(folder) {
      return .missingFolder(title: title, folder: folder)
    }
    let script: URL
    do {
      script = try write(TerminalScript.contents(for: launch, home: home), title: launch.title)
    } catch {
      return .failed(title: title, reason: error.localizedDescription)
    }
    do {
      try opener.open(script: script)
      return .opened(script)
    } catch {
      try? FileManager.default.removeItem(at: script)
      return .failed(title: title, reason: error.localizedDescription)
    }
  }

  /// The folder must be ours: a real directory (not a symlink someone put
  /// there), owned by this user, mode 0700.
  func prepareDirectory() throws {
    let fm = FileManager.default
    let parent = directory.deletingLastPathComponent()
    for folder in [parent, directory] {
      if mkdir(folder.path, 0o700) != 0, errno != EEXIST {
        if errno == ENOENT {
          try fm.createDirectory(at: folder, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        } else {
          throw TerminalLaunchError.folder(folder.path, String(cString: strerror(errno)))
        }
      }
      var info = stat()
      guard lstat(folder.path, &info) == 0 else { throw TerminalLaunchError.folder(folder.path, String(cString: strerror(errno))) }
      guard info.st_mode & S_IFMT == S_IFDIR else { throw TerminalLaunchError.folder(folder.path, "not a folder") }
      guard info.st_uid == getuid() else { throw TerminalLaunchError.folder(folder.path, "owned by another user") }
      if info.st_mode & 0o777 != 0o700, chmod(folder.path, 0o700) != 0 {
        throw TerminalLaunchError.folder(folder.path, String(cString: strerror(errno)))
      }
    }
  }

  /// Created exclusively (O_EXCL, O_NOFOLLOW) at 0700 under a free name:
  /// "<title>.command", then "<title> 2.command", …
  func write(_ contents: String, title: String) throws -> URL {
    let data = Array(contents.utf8)
    for attempt in 1...100 {
      let url = directory.appendingPathComponent(TerminalScript.fileName(for: title, suffix: attempt == 1 ? nil : attempt))
      let fd = Darwin.open(url.path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o700)
      if fd < 0 {
        if errno == EEXIST { continue }
        throw TerminalLaunchError.write(url.lastPathComponent, String(cString: strerror(errno)))
      }
      defer { close(fd) }
      // The umask may have taken bits off the mode above.
      guard fchmod(fd, 0o700) == 0 else {
        let reason = String(cString: strerror(errno))
        unlink(url.path)
        throw TerminalLaunchError.write(url.lastPathComponent, reason)
      }
      var offset = 0
      while offset < data.count {
        let written = data[offset...].withUnsafeBytes { Darwin.write(fd, $0.baseAddress, $0.count) }
        if written < 0 {
          if errno == EINTR { continue }
          let reason = String(cString: strerror(errno))
          unlink(url.path)
          throw TerminalLaunchError.write(url.lastPathComponent, reason)
        }
        offset += written
      }
      return url
    }
    throw TerminalLaunchError.write(TerminalScript.fileName(for: title), "no free file name")
  }

  func removeStaleScripts() {
    let fm = FileManager.default
    guard let items = try? fm.contentsOfDirectory(
      at: directory, includingPropertiesForKeys: [.contentModificationDateKey], options: [.skipsHiddenFiles]) else { return }
    let cutoff = now().addingTimeInterval(-Self.staleAge)
    for item in items where item.pathExtension == "command" {
      let modified = (try? item.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
      if let modified, modified < cutoff { try? fm.removeItem(at: item) }
    }
  }
}

public enum TerminalLaunchError: LocalizedError, Equatable {
  case folder(String, String)
  case write(String, String)
  case terminalMissing

  public var errorDescription: String? {
    switch self {
    case .folder(let path, let reason): "Cannot use \(path): \(reason)"
    case .write(let name, let reason): "Cannot write \(name): \(reason)"
    case .terminalMissing: "Terminal.app was not found"
    }
  }
}

/// A script running in the page could post terminal-launch (or -open, or
/// -kill) in a loop; one message per interval per window is plenty for a button.
public struct TerminalLaunchThrottle: Sendable {
  public static let interval: TimeInterval = 1
  private var last: Date?

  public init() {}

  public mutating func allow(at now: Date) -> Bool {
    if let last, now.timeIntervalSince(last) < Self.interval, now >= last { return false }
    last = now
    return true
  }
}
