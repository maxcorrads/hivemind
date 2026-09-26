import Foundation

/// The server the server app ships, as build.sh lays it out:
/// Contents/Helpers/node (arm64 Node.js; code lives outside Resources so
/// it can be signed as code) and the npm-packed package in
/// Contents/Resources/server.
public struct BundledServer: Sendable, Equatable {
  /// The bundle's Contents folder.
  public let contents: URL

  public init(contents: URL) { self.contents = contents }

  /// nil outside a built bundle (e.g. `swift run`), where there is no Node.
  public init?(bundle: Bundle) {
    self.init(contents: bundle.bundleURL.appendingPathComponent("Contents", isDirectory: true))
    guard FileManager.default.isExecutableFile(atPath: node.path),
          FileManager.default.fileExists(atPath: cli.path) else { return nil }
  }

  public var node: URL { contents.appendingPathComponent("Helpers/node") }
  public var packageRoot: URL { contents.appendingPathComponent("Resources/server", isDirectory: true) }
  public var cli: URL { packageRoot.appendingPathComponent("bin/hivemind.mjs") }

  /// The packed server's version, for the discovery file and About.
  public func version() -> String? {
    struct Package: Decodable { let version: String }
    guard let data = try? Data(contentsOf: packageRoot.appendingPathComponent("package.json")) else { return nil }
    return (try? JSONDecoder().decode(Package.self, from: data))?.version
  }
}

/// What `hivemind serve` prints and how the app reads it.
public enum ServerOutput {
  /// serve.ts prints "hivemind on http://127.0.0.1:<port>" to stderr once listening.
  public static func listeningPort(in line: String) -> ServerPort? {
    let prefix = "hivemind on http://\(ServerEndpoint.host):"
    guard line.hasPrefix(prefix) else { return nil }
    return ServerPort(String(line.dropFirst(prefix.count)))
  }

  /// Failures a restart would only repeat: the data folder is locked by
  /// another server (InstanceLockError) or the port is taken.
  public static func isFatal(_ line: String) -> Bool {
    line.contains("Another Hivemind server") || line.contains("Could not take the Hivemind server lock")
      || line.contains("EADDRINUSE")
  }

  /// A line worth surfacing as "the last error": not a stack frame, not the
  /// ready line, not Node's version footer or caret markers.
  public static func isError(_ line: String) -> Bool {
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    guard !trimmed.isEmpty, line.first?.isWhitespace != true else { return false }
    if listeningPort(in: line) != nil || trimmed.hasPrefix("Node.js v") { return false }
    return trimmed.contains(where: { $0.isLetter })
  }
}

/// How the server app runs `hivemind serve`.
public struct ServerLaunchSettings: Equatable, Sendable {
  public var port: ServerPort
  public var dataHome: URL

  public init(port: ServerPort, dataHome: URL) {
    self.port = port
    self.dataHome = dataHome
  }

  /// Environment variables never passed through: NODE_OPTIONS and friends
  /// could load code into the server; HIVEMIND_URL/TOKEN belong to CLI shells.
  static let dropped: Set<String> = [
    "NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS_FILE", "NODE_REPL_EXTERNAL_MODULE",
    "HIVEMIND_URL", "HIVEMIND_TOKEN", "HIVEMIND_FROM_DIST", "HIVEMIND_PORT", "HIVEMIND_HOME",
    InstanceProof.environmentKey,
  ]

  /// `secret` is this start's InstanceSecret: node reads it from
  /// HIVEMIND_INSTANCE_SECRET and deletes it from its own environment, so
  /// nothing the server spawns inherits it.
  public func spec(
    server: BundledServer, baseEnvironment: [String: String], home: URL, secret: InstanceSecret? = nil
  ) -> LaunchSpec {
    var environment = baseEnvironment.filter { !Self.dropped.contains($0.key) }
    environment["HIVEMIND_HOME"] = dataHome.path
    if let secret { environment[InstanceProof.environmentKey] = secret.hex }
    environment["HOME"] = environment["HOME"] ?? home.path
    // A GUI app inherits launchd's bare PATH. The bundled node comes first so
    // anything the server spawns as `node` is the same runtime; the usual
    // install folders follow so agent CLIs the server starts are found.
    let preferred = [
      server.node.deletingLastPathComponent().path,
      "/opt/homebrew/bin", "/usr/local/bin", home.appendingPathComponent(".local/bin").path,
    ]
    let inherited = (environment["PATH"] ?? "/usr/bin:/bin:/usr/sbin:/sbin").split(separator: ":").map(String.init)
    var seen = Set<String>()
    environment["PATH"] = (preferred + inherited).filter { seen.insert($0).inserted }.joined(separator: ":")
    return LaunchSpec(
      executable: server.node,
      arguments: [server.cli.path, "serve", "--port", port.description],
      environment: environment,
      workingDirectory: dataHome)
  }

  /// Refuses to start next to another live server on the same data folder or port.
  public func preflight(
    probe: any PortProbing = LoopbackPortProbe(),
    lockOwner: (URL) -> InstanceLockOwner? = { InstanceLockOwner.live(dataHome: $0) }
  ) -> PreflightFailure? {
    if let owner = lockOwner(dataHome) { return .dataFolderInUse(pid: owner.pid, dataHome: dataHome.path) }
    if probe.isListening(port) { return .portInUse(port) }
    return nil
  }
}

/// Keeps server.json in step with the supervisor: present exactly while a
/// child is running, naming that child.
@MainActor
public final class DiscoveryPublisher {
  private let store: DiscoveryStore
  private let settings: @MainActor () -> ServerLaunchSettings
  /// The secret the running child was started with.
  private let secret: @MainActor () -> InstanceSecret?
  private let version: String
  private var published: Int32?

  public init(
    store: DiscoveryStore, version: String, settings: @escaping @MainActor () -> ServerLaunchSettings,
    secret: @escaping @MainActor () -> InstanceSecret? = { nil }
  ) {
    self.store = store
    self.version = version
    self.settings = settings
    self.secret = secret
  }

  public func update(for state: SupervisorState) {
    if case .running(let pid, let since) = state {
      guard published != pid else { return }
      withdraw()
      let current = settings()
      do {
        try store.write(ServerDiscovery(
          port: current.port, pid: pid, home: current.dataHome.path, startedAt: since, version: version,
          instanceSecret: secret()))
        published = pid
      } catch {
        published = nil
      }
    } else {
      withdraw()
    }
  }

  public func withdraw() {
    guard let pid = published else { return }
    store.remove(ifOwnedBy: pid)
    published = nil
  }
}

/// How the UI app picks a server: a live discovery file first, then the port
/// the user configured, then 7420.
public enum ServerLocator {
  public static func endpoint(
    discovery: DiscoveryStore,
    configuredPort: ServerPort?,
    isAlive: (Int32) -> Bool = ProcessLiveness.isAlive
  ) -> ServerEndpoint {
    if let live = discovery.readLive(isAlive: isAlive) { return live.endpoint }
    return ServerEndpoint(port: configuredPort ?? .default)
  }
}
