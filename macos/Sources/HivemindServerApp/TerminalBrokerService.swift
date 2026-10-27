import Foundation
import HivemindKit

/// The terminal broker as the app runs it: BrokerFiles on start (0700
/// folder, the Unix socket, then tmux.conf and a fresh token), and TerminalBroker
/// with the real tmux, PTYs and clock. It runs for the life of the app,
/// independently of the Node server: terminals never go through Node.
/// docs/terminal-broker.md has the whole design.
@MainActor
final class TerminalBrokerService {
  let paths: HivemindPaths
  var onChange: (@MainActor () -> Void)?
  var launcherDecision: (@MainActor (String, TemplateID?, Bool) async -> Result<Void, BrokerProtocolError>)?
  /// The remote hosts the broker launches on and lists (docs/remote-hosts.md#launch): HostsService, set before start.
  var remoteHosts: (any BrokerRemoteHosts)?

  private var broker: TerminalBroker?
  var inProcessBroker: TerminalBroker? { broker }
  private var listener: BrokerSocketListener?
  private var failure: String?
  private let log: RotatingLog

  init(paths: HivemindPaths) {
    self.paths = paths
    log = RotatingLog(file: paths.logsDirectory.appendingPathComponent("broker.log"))
  }

  /// Whether the broker listens: the remote gateway only offers terminals then.
  var isRunning: Bool { broker != nil }

  var status: BrokerStatus {
    if let failure { return BrokerStatus(state: .failed(failure), tmuxPath: broker?.tmuxPath, sessionCount: nil) }
    return broker?.status ?? BrokerStatus(state: .stopped, tmuxPath: nil, sessionCount: nil)
  }

  func start() {
    guard broker == nil else { return }
    failure = nil
    // The socket first: when another broker still answers on it, its token
    // and tmux.conf stay as they are (BrokerFiles.start).
    let listener = BrokerSocketListener(path: paths.brokerSocket.path) { [weak self] fd in self?.accept(fd) }
    let token: BrokerToken
    do {
      let files = BrokerFiles(paths: paths)
      try files.checkSocketPath()
      token = try files.start(listen: { try listener.start() }, unlisten: { listener.stop() })
    } catch {
      // BrokerFiles.Failure and BrokerSocketError both describe themselves.
      return fail(error.localizedDescription)
    }
    // accept(_:) runs on the main queue, after this returns: it finds the broker.
    let log = self.log
    let broker = TerminalBroker(
      token: token, configPath: paths.tmuxConfig.path,
      dependencies: .init(
        tmux: TmuxProcessRunner(), terminals: PseudoTerminalSpawner(), scheduler: MainQueueScheduler(),
        locateTmux: { TmuxLocator().locate() },
        isDirectory: { path in
          var isDirectory: ObjCBool = false
          return FileManager.default.fileExists(atPath: path, isDirectory: &isDirectory) && isDirectory.boolValue
        },
        environment: ProcessInfo.processInfo.environment,
        secrets: LaunchSecretStore(folder: paths.launchSecrets),
        templateSecrets: KeychainTemplateSecretVault(),
        shadowHomes: FileShadowHomes(),
        claudeTap: ClaudeStatusTap(folder: paths.accounts),
        remoteHosts: remoteHosts,
        originURL: { folder in await Self.origin(of: folder) },
        log: { log.append($0) }))
    broker.onChange = { [weak self] in self?.onChange?() }
    broker.launcherDecision = { [weak self] requestId, templateId, approve in
      guard let handler = self?.launcherDecision else {
        return .failure(.init(.internal, "launcher approval is unavailable"))
      }
      return await handler(requestId, templateId, approve)
    }
    self.broker = broker
    self.listener = listener
    broker.start()
    log.append("[broker] listening on \(paths.brokerSocket.path)")
  }

  /// For Quit: hangs up every PTY child (their tmux clients detach) and
  /// removes the socket. The tmux server and its sessions keep running, and
  /// with them the agents.
  func stop() {
    listener?.stop()
    listener = nil
    broker?.stop()
    broker = nil
    onChange?()
  }

  private func accept(_ fd: Int32) {
    guard let broker else {
      close(fd)
      return
    }
    guard let transport = SocketTransport(fd: fd) else {
      log.append("[broker] refused a connection from another user")
      return
    }
    guard let connection = broker.accept(transport) else {
      log.append("[broker] refused a connection: at most \(BrokerLimits.maxConnections)")
      return
    }
    transport.start(connection)
  }

  /// `git remote get-url origin` in `folder` on this Mac, for a host that has no copy of the project to clone it from;
  /// nil when the folder has no origin or git cannot tell.
  private static func origin(of folder: String) async -> String? {
    await withCheckedContinuation { continuation in
      DispatchQueue.global(qos: .utility).async {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.arguments = ["-C", folder, "remote", "get-url", "origin"]
        process.environment = ["PATH": "/usr/bin:/bin", "HOME": NSHomeDirectory(), "GIT_TERMINAL_PROMPT": "0"]
        let out = Pipe()
        process.standardOutput = out
        process.standardError = FileHandle.nullDevice
        process.standardInput = FileHandle.nullDevice
        do { try process.run() } catch { return continuation.resume(returning: nil) }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        let url = String(decoding: data.prefix(4096), as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        continuation.resume(returning: process.terminationStatus == 0 && !url.isEmpty && !url.contains("\n") ? url : nil)
      }
    }
  }

  private func fail(_ message: String) {
    failure = message
    log.append("[broker] cannot start: \(message)")
    onChange?()
  }
}
