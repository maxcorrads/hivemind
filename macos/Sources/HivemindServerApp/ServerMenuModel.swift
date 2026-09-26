import AppKit
import HivemindKit

/// The menu's view model: publishes the controller's changes to SwiftUI and
/// runs the menu actions that need AppKit (dialogs, Finder, other apps).
@MainActor
final class ServerMenuModel: ObservableObject {
  let controller: ServerAppController
  /// The terminal broker: tmux sessions and the PTYs attached to them. It
  /// runs for the life of the app, whether or not the server does.
  let terminals: TerminalBrokerService
  private let loginItem: any LoginItemControlling
  private let installer: CommandLineInstaller

  init() {
    let paths = HivemindPaths()
    let server = BundledServer(bundle: .main)
    let version = server?.version()
      ?? Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
    controller = ServerAppController(
      paths: paths, server: server, version: version, store: ServerAppSettingsStore(),
      log: RotatingLog(file: paths.serverLog), dependencies: .live())
    loginItem = MainAppLoginItem()
    installer = CommandLineInstaller(paths: paths)
    terminals = TerminalBrokerService(paths: paths)
    controller.onChange = { [weak self] in self?.objectWillChange.send() }
    terminals.onChange = { [weak self] in self?.objectWillChange.send() }
  }

  private var paths: HivemindPaths { controller.paths }

  var status: ServerAppStatus { controller.status }
  var terminalsStatus: BrokerStatus { terminals.status }
  var port: ServerPort { controller.settings.port }
  var dataFolderLabel: String { paths.abbreviated(controller.dataHome) }
  var usesDefaultDataFolder: Bool { controller.settings.dataHome == nil }
  var previousServer: ServerDiscovery? { controller.previousServer }
  var launchesAtLogin: LoginItemStatus { loginItem.status }
  var canInstallCommandLineTool: Bool { controller.server != nil }

  // MARK: Server

  func start() { controller.start() }
  func stop() { controller.stop() }
  func restart() { controller.restart() }
  func stopPreviousServer() { controller.stopPreviousServer() }

  /// Hivemind.app finds the server itself (and shows its own connect screen
  /// while it starts); a browser needs the server up first.
  func openHivemind() {
    if controller.state == .stopped { controller.start() }
    let uiApp = NSWorkspace.shared.urlForApplication(withBundleIdentifier: BundleID.ui)
    switch OpenHivemindAction.decide(uiApp: uiApp, endpoint: controller.endpoint) {
    case .launchApp(let app):
      NSWorkspace.shared.openApplication(at: app, configuration: NSWorkspace.OpenConfiguration()) { _, error in
        guard let error else { return }
        Task { @MainActor in Dialogs.error("Could not open Hivemind", error.localizedDescription) }
      }
    case .openInBrowser:
      controller.whenReady { NSWorkspace.shared.open($0.baseURL) }
    }
  }

  // MARK: Settings

  func changePort() {
    var problem: String?
    while true {
      let info = "Hivemind Server listens on this port at 127.0.0.1. The default is \(ServerPort.default)."
      guard let answer = Dialogs.askPort(current: port, info: problem.map { "\($0)\n\n\(info)" } ?? info) else { return }
      guard let chosen = ServerPort(answer) else {
        problem = "“\(answer)” is not a port. Enter a number from 1 to 65535."
        continue
      }
      var settings = controller.settings
      settings.port = chosen
      controller.update(settings)
      return
    }
  }

  func chooseDataFolder() {
    guard let folder = Dialogs.chooseFolder(
      starting: controller.dataHome,
      message: "Choose where the server keeps its data (HIVEMIND_HOME). A new folder starts an empty hive; the server restarts on it."
    ) else { return }
    var settings = controller.settings
    settings.dataHome = folder
    controller.update(settings)
  }

  func useDefaultDataFolder() {
    var settings = controller.settings
    settings.dataHome = nil
    controller.update(settings)
  }

  func showDataFolder() {
    let folder = controller.dataHome
    if FileManager.default.fileExists(atPath: folder.path) {
      NSWorkspace.shared.activateFileViewerSelecting([folder])
    } else {
      Dialogs.error("The data folder does not exist yet", "The server creates \(folder.path) when it starts.")
    }
  }

  func showLogs() {
    let log = paths.serverLog
    let fm = FileManager.default
    if !fm.fileExists(atPath: log.path) {
      try? fm.createDirectory(at: log.deletingLastPathComponent(), withIntermediateDirectories: true)
      fm.createFile(atPath: log.path, contents: nil, attributes: [.posixPermissions: 0o600])
    }
    // .log opens in Console, which follows the file as it grows.
    NSWorkspace.shared.open(log)
  }

  func toggleLaunchAtLogin() {
    if case .failed(let message) = LoginItemToggle.toggle(loginItem) {
      Dialogs.error("Could not change Launch at Login", message)
    }
    objectWillChange.send()
  }

  // MARK: Command-line tool

  func installCommandLineTool() {
    guard let server = controller.server else { return }
    let system = paths.systemCommandLineTool
    let user = paths.userCommandLineTool
    guard let destination = Dialogs.chooseCommandLineDestination(
      system: system, user: user, userLabel: paths.abbreviated(user)) else { return }
    let plan = installer.plan(for: destination)
    if case .other(let what) = plan.existing,
       !Dialogs.confirm("Replace \(destination.path)?", "It is currently \(what). The new script runs this app’s bundled hivemind instead.",
                        action: "Replace") {
      return
    }
    let script = CommandLineTool.script(server: server, discoveryFile: paths.discoveryFile)
    do {
      if plan.needsAdmin {
        let staged = try installer.stage(script)
        defer { installer.unstage(staged) }
        switch AdminScript.run(installer.adminAppleScript(staged: staged, destination: destination)) {
        case .done: break
        case .cancelled: return
        case .failed(let message): throw InstallError(message: message)
        }
      } else {
        try installer.installDirectly(script, at: destination)
      }
    } catch {
      Dialogs.error("Could not install the command-line tool", error.localizedDescription)
      return
    }
    var info = "Run “hivemind --help” in a new Terminal window."
    if destination == user { info += " \(paths.abbreviated(user.deletingLastPathComponent())) must be on your PATH." }
    info += " If you move this app, install the tool again."
    Dialogs.info("Installed \(paths.abbreviated(destination))", info)
  }

  private struct InstallError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
  }

  // MARK: App

  func showAbout() {
    Dialogs.activate()
    NSApp.orderFrontStandardAboutPanel(options: [
      .applicationName: "Hivemind Server",
      .credits: NSAttributedString(string: "Runs hivemind serve \(controller.version) with its own Node.js."),
    ])
  }

  func quit() { NSApp.terminate(nil) }
}
