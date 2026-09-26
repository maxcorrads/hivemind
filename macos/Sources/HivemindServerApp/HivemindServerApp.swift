import AppKit
import HivemindKit
import SwiftUI

// Menu-bar only (LSUIElement in Info.plist): supervises the bundled
// `hivemind serve`. The menu is a view over ServerAppController.
@main
struct HivemindServerApp: App {
  @NSApplicationDelegateAdaptor(ServerAppDelegate.self) private var delegate

  var body: some Scene {
    MenuBarExtra {
      ServerMenu(model: delegate.model)
    } label: {
      MenuBarLabel(model: delegate.model)
    }
    .menuBarExtraStyle(.menu)
  }
}

@MainActor
final class ServerAppDelegate: NSObject, NSApplicationDelegate {
  let model = ServerMenuModel()
  private var quitting = false
  private var launched = false

  func applicationWillFinishLaunching(_ notification: Notification) {
    // Before launch finishes: a URL can be what launched us.
    NSAppleEventManager.shared().setEventHandler(
      self, andSelector: #selector(handleURLEvent(_:withReply:)),
      forEventClass: AEEventClass(kInternetEventClass), andEventID: AEEventID(kAEGetURL))
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    launched = true
    model.controller.launch()
    model.terminals.start()
    model.remote.startIfEnabled()
    #if DEBUG
    DebugPairingHook.install(model.remote)
    #endif
  }

  /// hivemind-server://start from Hivemind.app's connect screen. Anything
  /// else is ignored (ServerAppURLCommand).
  @objc private func handleURLEvent(_ event: NSAppleEventDescriptor, withReply reply: NSAppleEventDescriptor) {
    guard let string = event.paramDescriptor(forKeyword: AEKeyword(keyDirectObject))?.stringValue,
          let command = ServerAppURLCommand(string: string) else { return }
    switch command {
    case .start:
      // A launch by this URL starts the server in applicationDidFinishLaunching.
      if launched { model.start() }
    }
  }

  /// Quit waits for the server to exit (SIGTERM, SIGKILL after the timeout)
  /// so no orphan keeps the data folder locked. The terminal broker hangs up
  /// its PTY children at once; tmux sessions (and the agents in them) keep
  /// running.
  func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
    model.remote.stop()
    model.terminals.stop()
    let controller = model.controller
    guard controller.hasChild else {
      controller.shutdown {}
      return .terminateNow
    }
    guard !quitting else { return .terminateLater }
    quitting = true
    controller.shutdown { sender.reply(toApplicationShouldTerminate: true) }
    return .terminateLater
  }
}

private struct MenuBarLabel: View {
  @ObservedObject var model: ServerMenuModel

  var body: some View {
    let kind = model.status.kind
    Image(nsImage: MenuBarIcon.image(for: kind))
      .renderingMode(.template)
      .accessibilityLabel(MenuBarIcon.accessibilityLabel(for: kind))
  }
}

private struct ServerMenu: View {
  @ObservedObject var model: ServerMenuModel

  var body: some View {
    let status = model.status
    // Plain Text rows render as disabled menu items: status, not actions.
    Text(status.title)
    if let detail = status.detail { Text(detail) }
    Text(model.terminalsStatus.title)
    if model.remote.isEnabled { Text(model.remote.status.title) }
    Divider()
    Button("Open Hivemind") { model.openHivemind() }
      .keyboardShortcut("o")
    Divider()
    Button("Start Server") { model.start() }
      .disabled(!status.canStart)
    Button("Stop Server") { model.stop() }
      .disabled(!status.canStop)
    Button("Restart Server") { model.restart() }
      .disabled(!status.canRestart)
      .keyboardShortcut("r")
    if let previous = model.previousServer {
      Button("Stop Previous Server (pid \(String(previous.pid)))") { model.stopPreviousServer() }
    }
    Divider()
    Button("Port: \(model.port.description)…") { model.changePort() }
    Menu("Data Folder: \(model.dataFolderLabel)") {
      Button("Choose Folder…") { model.chooseDataFolder() }
      Button("Use Default (~/.hivemind)") { model.useDefaultDataFolder() }
        .disabled(model.usesDefaultDataFolder)
      Divider()
      Button("Show in Finder") { model.showDataFolder() }
    }
    Button("Show Logs") { model.showLogs() }
      .keyboardShortcut("l")
    Toggle(model.launchesAtLogin == .requiresApproval ? "Launch at Login (needs approval)" : "Launch at Login",
           isOn: Binding(get: { model.launchesAtLogin == .enabled }, set: { _ in model.toggleLaunchAtLogin() }))
    Button("Install Command-Line Tool…") { model.installCommandLineTool() }
      .disabled(!model.canInstallCommandLineTool)
    Divider()
    RemoteAccessMenu(model: model)
    Divider()
    Button("About Hivemind Server") { model.showAbout() }
    Button("Quit Hivemind Server") { model.quit() }
      .keyboardShortcut("q")
  }
}

/// Remote access for paired iPhones and iPads (docs/remote-access.md).
private struct RemoteAccessMenu: View {
  // Observed like ServerMenu: a plain RemoteAccessService reference never changes, so SwiftUI would
  // skip re-rendering this submenu and keep showing the state from launch (toggle unchecked, Pair
  // a Device… disabled). RemoteAccessService reports changes through the model's objectWillChange.
  @ObservedObject var model: ServerMenuModel

  var body: some View {
    let remote = model.remote
    Toggle("Remote Access", isOn: Binding(get: { remote.isEnabled }, set: { remote.setEnabled($0) }))
    Button("Pair a Device…") { remote.openPairing() }
      .disabled(!remote.canPair)
    Button("Devices (\(remote.deviceList.count))…") { remote.showDevices() }
    Menu("Remote Access Settings") {
      Button("Port: \(remote.port.description)…") { remote.changePort() }
      Button("Show Remote Access Log") { remote.showLog() }
      Divider()
      Button("Reset Identity…") { remote.resetIdentity() }
    }
  }
}
