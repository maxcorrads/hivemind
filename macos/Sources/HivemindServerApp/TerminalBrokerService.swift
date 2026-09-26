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

  private var broker: TerminalBroker?
  private var listener: BrokerSocketListener?
  private var failure: String?
  private let log: RotatingLog

  init(paths: HivemindPaths) {
    self.paths = paths
    log = RotatingLog(file: paths.logsDirectory.appendingPathComponent("broker.log"))
  }

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
        log: { log.append($0) }))
    broker.onChange = { [weak self] in self?.onChange?() }
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

  private func fail(_ message: String) {
    failure = message
    log.append("[broker] cannot start: \(message)")
    onChange?()
  }
}
