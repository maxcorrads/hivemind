import Foundation

// The remote runtime (docs/remote-hosts.md#remote-runtime): what the Hivemind MCP needs on a host, installed by
// Server.app so a host needs no Node.js or Hivemind of its own. It is this app's own bundled Node.js and server package,
// and Hivemind's tmux.conf, in `~/Library/Application Support/Hivemind/remote/<version>/` on the host:
//
//   node             Contents/Helpers/node
//   server/          Contents/Resources/server (bin/hivemind.mjs and its dependencies)
//   tmux.conf        TmuxCommand.configText
//   runtime.stamp    the stamp below, written last: a folder without it is an unfinished copy
//
// Every connection checks the stamp over the master and copies the runtime again when it differs, as one `tar` stream
// on the master's stdin, so the MCP on a host always matches this app's server.

/// The runtime this app installs on its hosts.
public struct RemoteRuntime: Equatable, Sendable {
  /// The host's runtime folders, relative to its home.
  public static let folder = "Library/Application Support/Hivemind/remote"
  /// The only platform the bundled Node.js runs on (`uname -s`, `uname -m`).
  public static let platform = "Darwin arm64"

  public let server: BundledServer
  /// The server package's version, which names the folder on the host.
  public let version: String
  /// The version and a digest of the files copied, so a rebuild with the same version is copied again.
  public let stamp: String
  /// What `uname -s` and `uname -m` print on a host it can run on.
  public let platform: String

  /// nil when `version` cannot name a folder (1–64 of letters, digits, `.`, `+`, `-`, not starting with `.`).
  public init?(server: BundledServer, version: String, platform: String = Self.platform) {
    let allowed = Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.+-")
    guard (1...64).contains(version.count), version.allSatisfy(allowed.contains), !version.hasPrefix("."),
          !version.hasPrefix("-") else { return nil }
    self.server = server
    self.version = version
    self.platform = platform
    stamp = "\(version) \(Self.digest(server))"
  }

  /// The runtime of the server this app bundles, or nil outside a built bundle.
  public init?(server: BundledServer?) {
    guard let server, let version = server.version() else { return nil }
    self.init(server: server, version: version)
  }

  /// The host's folder for this version, relative to its home.
  public var remoteFolder: String { "\(Self.folder)/\(version)" }

  /// SHA-256 over the copied tree as names and sizes (Node.js, then every file of the server package but its
  /// `node_modules`, whose `package-lock.json` is hashed whole), and tmux.conf. Cheap: it reads no large file.
  static func digest(_ server: BundledServer) -> String {
    var text = "node \(size(server.node))\ntmux.conf \(TmuxCommand.configText)\n"
    let root = server.packageRoot.standardizedFileURL.path
    let manager = FileManager.default
    if let walker = manager.enumerator(atPath: root) {
      var entries: [String] = []
      while let relative = walker.nextObject() as? String {
        if relative == "node_modules" || relative.hasPrefix("node_modules/") {
          if relative == "node_modules" { walker.skipDescendants() }
          continue
        }
        entries.append("\(relative) \(size(URL(fileURLWithPath: root).appendingPathComponent(relative)))")
      }
      text += entries.sorted().joined(separator: "\n")
    }
    if let lock = manager.contents(atPath: root + "/package-lock.json") { text += "\nlock " + SHA256Hash.hex(lock) }
    return String(SHA256Hash.hex(Data(text.utf8)).prefix(16))
  }

  private static func size(_ url: URL) -> String {
    var info = stat()
    guard lstat(url.path, &info) == 0 else { return "-" }
    return info.st_mode & S_IFMT == S_IFREG ? String(info.st_size) : "dir"
  }

  // MARK: Commands

  /// `script` as one remote command: the host user's login shell runs `/bin/sh -c '<script>'`, so the script is POSIX
  /// sh whatever that shell is.
  static func remote(_ script: String) -> String { "/bin/sh -c \(TerminalScript.shellQuoted(script))" }

  private var folderVariables: String {
    """
    support="$HOME/Library/Application Support/Hivemind"
    base="$HOME/\(Self.folder)"
    target="$base/\(version)"

    """
  }

  /// Prints the host's platform, then the stamp of this version's folder, if it has one, each on a line of its own
  /// after a marker: whatever the host's shell startup files print around them is ignored.
  public var checkCommand: String {
    Self.remote(folderVariables + """
      printf 'hivemind-platform %s %s\\n' "$(uname -s)" "$(uname -m)"
      printf 'hivemind-stamp %s\\n' "$(cat "$target/runtime.stamp" 2>/dev/null)"
      """)
  }

  /// What a check printed.
  public enum Check: Equatable, Sendable {
    /// This version's folder holds this stamp.
    case current
    /// No folder, an unfinished one, or another build's.
    case outdated
    /// The host is not a platform the runtime runs on; the platform it reported.
    case unsupported(String)
  }

  public func check(_ output: String) -> Check {
    let lines = output.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }
    func value(_ marker: String) -> String? {
      lines.last { $0.hasPrefix(marker + " ") }.map { String($0.dropFirst(marker.count + 1)) }
    }
    let reported = value("hivemind-platform") ?? ""
    guard reported == platform else { return .unsupported(reported.isEmpty ? "unknown" : String(reported.prefix(60))) }
    return value("hivemind-stamp") == stamp ? .current : .outdated
  }

  /// Reads the `tar` stream on stdin into a new private folder next to this version's, checks that its Node.js runs,
  /// writes the stamp, and only then moves it into place, so a copy cut short never looks finished. The
  /// app-support folder and the runtime folders are 0700, like this Mac's. Of the other versions only the newest is
  /// kept, for agents still running its MCP.
  public var installCommand: String {
    Self.remote("set -eu\numask 077\n" + folderVariables + """
      mkdir -p "$base"
      chmod 700 "$support" "$base"
      work="$base/.install.$$"
      rm -rf "$work"
      mkdir "$work"
      trap 'rm -rf "$work"' EXIT
      tar -xf - -C "$work"
      "$work/node" --version >/dev/null
      printf '%s\\n' \(TerminalScript.shellQuoted(stamp)) > "$work/runtime.stamp"
      if [ -e "$target" ]; then
        mv "$target" "$base/.old.$$"
        rm -rf "$base/.old.$$"
      fi
      mv "$work" "$target"
      trap - EXIT
      ls -1t "$base" | grep -vx \(TerminalScript.shellQuoted(version)) | tail -n +2 | while IFS= read -r old; do
        rm -rf "$base/$old"
      done
      """)
  }

  /// The local `tar` that writes the stream `installCommand` reads: tmux.conf from `staging`, Node.js and the server
  /// package from the bundle, without macOS metadata (no `._` files).
  public func archiveSpec(staging: URL) -> LaunchSpec {
    LaunchSpec(
      executable: URL(fileURLWithPath: "/usr/bin/tar"),
      arguments: ["-c", "-f", "-", "--no-mac-metadata",
                  "-C", staging.path, "tmux.conf",
                  "-C", server.contents.appendingPathComponent("Helpers").path, "node",
                  "-C", server.contents.appendingPathComponent("Resources").path, "server"],
      environment: ["COPYFILE_DISABLE": "1", "PATH": "/usr/bin:/bin"],
      workingDirectory: server.contents)
  }
}

/// RemoteRuntimeInstalling over a host's master: the check, then, when it is not current, the copy.
@MainActor public final class RemoteRuntimeInstaller: RemoteRuntimeInstalling {
  /// How long a check, and a whole copy, may take.
  public static let checkTimeout: TimeInterval = 30
  public static let installTimeout: TimeInterval = 15 * 60

  /// nil when this app has no bundled runtime: every ensure then fails with `unbundled`. Made on the first ensure, so
  /// an app with no host never reads its bundle for it.
  public private(set) lazy var runtime: RemoteRuntime? = makeRuntime()
  private let makeRuntime: @MainActor () -> RemoteRuntime?
  private let transport: SSHTransport
  private let runner: any SSHRunning
  /// Where tmux.conf is staged for `tar`, in a fresh private folder per copy.
  private let temporaryFolder: URL

  public static let unbundled = "This copy of Hivemind Server has no bundled runtime; build it with macos/build.sh"

  public var runtimeFolder: String? { runtime?.remoteFolder }

  public init(runtime: @escaping @MainActor () -> RemoteRuntime?, transport: SSHTransport, runner: any SSHRunning,
              temporaryFolder: URL = FileManager.default.temporaryDirectory) {
    makeRuntime = runtime
    self.transport = transport
    self.runner = runner
    self.temporaryFolder = temporaryFolder
  }

  public func ensure(on host: RemoteHost, installing: @escaping @MainActor () -> Void) async -> Result<Void, BrokerFiles.Failure> {
    guard let runtime else { return .failure(.init(Self.unbundled)) }
    let checked = await runner.run(transport.commandSpec(host, command: runtime.checkCommand), input: nil, timeout: Self.checkTimeout)
    guard checked.succeeded else { return .failure(.init("Version check failed: \(checked.reason ?? "ssh exited with status \(checked.status)")")) }
    switch runtime.check(checked.stdout) {
    case .current: return .success(())
    case .unsupported(let platform):
      return .failure(.init("The host reports \(platform); the remote runtime runs on \(runtime.platform) only"))
    case .outdated: break
    }
    installing()
    let staging = temporaryFolder.appendingPathComponent("hivemind-runtime-\(UUID().uuidString)", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: staging) }
    do {
      try BrokerFiles.preparePrivateFolder(staging)
      try BrokerFiles.writePrivately(Data(TmuxCommand.configText.utf8), to: staging.appendingPathComponent("tmux.conf"))
    } catch {
      return .failure(error)
    }
    let installed = await runner.run(transport.commandSpec(host, command: runtime.installCommand),
                                     input: runtime.archiveSpec(staging: staging), timeout: Self.installTimeout)
    guard installed.succeeded else { return .failure(.init("Install failed: \(installed.reason ?? "ssh exited with status \(installed.status)")")) }
    // The copy is checked as a new connection would check it.
    let after = await runner.run(transport.commandSpec(host, command: runtime.checkCommand), input: nil, timeout: Self.checkTimeout)
    guard after.succeeded, runtime.check(after.stdout) == .current else { return .failure(.init("Install did not leave this version on the host")) }
    return .success(())
  }
}
