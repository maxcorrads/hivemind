import AppKit
import HivemindKit

// The UI app: WKWebView windows on http://127.0.0.1:<port>/. AppKit rather
// than SwiftUI for multi-window WKWebView, native menus and state
// restoration.
@main
@MainActor
final class HivemindApp: NSObject, NSApplicationDelegate, NSMenuItemValidation {
  // NSApplication holds its delegate weakly; this keeps it alive.
  private(set) static var shared: HivemindApp!

  static func main() {
    let app = NSApplication.shared
    let delegate = HivemindApp()
    shared = delegate
    app.delegate = delegate
    app.setActivationPolicy(.regular)
    app.run()
  }

  let paths = HivemindPaths()
  private(set) lazy var locator = UIServerLocator(discovery: DiscoveryStore(paths: paths))
  let notifier = Notifier()
  /// App-wide so a download outlives the window that started it.
  let downloads = Downloads()
  private(set) var windows: [BrowserWindowController] = []
  private var badge = BadgeAggregator<String>()
  private lazy var terminalLauncher = TerminalLauncher(
    directory: TerminalLauncher.defaultDirectory(),
    home: FileManager.default.homeDirectoryForCurrentUser.path,
    opener: TerminalAppOpener())

  /// The port to try when no live discovery file names one.
  var configuredPort: ServerPort? {
    get { ServerPort(UserDefaults.standard.integer(forKey: SettingsKey.port)) }
    set { UserDefaults.standard.set(newValue?.value, forKey: SettingsKey.port) }
  }

  var pageZoom: Double {
    get {
      let stored = UserDefaults.standard.double(forKey: UIAppSettingsKey.pageZoom)
      return stored == 0 ? PageZoom.actualSize : PageZoom.clamp(stored)
    }
    set { UserDefaults.standard.set(PageZoom.clamp(newValue), forKey: UIAppSettingsKey.pageZoom) }
  }

  var serverAppURL: URL? { NSWorkspace.shared.urlForApplication(withBundleIdentifier: BundleID.server) }

  // MARK: Lifecycle

  func applicationWillFinishLaunching(_ notification: Notification) {
    NSApp.mainMenu = MainMenu.build()
    // Before launch finishes: a click on a notification can be what launched us.
    notifier.onOpen = { [weak self] target, windowID in self?.openNotice(target: target, windowID: windowID) }
    notifier.install()
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    // Restored windows, if any, exist by now.
    if windows.isEmpty { openWindow() }
    NotificationCenter.default.addObserver(
      forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main
    ) { _ in
      MainActor.assumeIsolated { HivemindApp.shared.windows.forEach { $0.revalidate() } }
    }
  }

  func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

  func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool { true }

  func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
    if !flag {
      if let window = windows.first(where: \.isPrimary) { window.showWindow(nil) } else { openWindow() }
    }
    return true
  }

  // MARK: Windows

  @discardableResult
  func openWindow(state: UIWindowState? = nil) -> BrowserWindowController {
    let controller = BrowserWindowController(app: self, state: state ?? UIWindowState(zoom: pageZoom))
    place(controller)
    return controller
  }

  /// A same-origin page the UI opened in a new tab (an attachment, say). It
  /// needs the session cookie, so the default browser is no place for it.
  func openAuxiliaryWindow(url: URL, endpoint: ServerEndpoint) {
    place(BrowserWindowController(app: self, auxiliaryURL: url, endpoint: endpoint, zoom: pageZoom))
  }

  /// Every controller registers itself, restored ones included.
  func adopt(_ controller: BrowserWindowController) {
    windows.append(controller)
  }

  private func place(_ controller: BrowserWindowController) {
    if let last = windows.last(where: { $0 !== controller })?.window, let window = controller.window {
      window.setFrameTopLeftPoint(window.cascadeTopLeft(from: NSPoint(x: last.frame.minX, y: last.frame.maxY)))
    } else {
      controller.window?.center()
    }
    controller.showWindow(nil)
  }

  func windowDidClose(_ controller: BrowserWindowController) {
    windows.removeAll { $0 === controller }
    clearBadge(for: controller.id)
  }

  // MARK: Bridge fan-in

  func setBadge(_ count: Int, for windowID: String) {
    badge.set(count, for: windowID)
    NSApp.dockTile.badgeLabel = dockBadgeLabel(count: badge.count)
  }

  func clearBadge(for windowID: String) {
    badge.remove(windowID)
    NSApp.dockTile.badgeLabel = dockBadgeLabel(count: badge.count)
  }

  /// A notification was clicked: back to the window that raised it, else any
  /// Hivemind window, else a new one, at the notice's route.
  func openNotice(target: String?, windowID: String?) {
    NSApp.activate(ignoringOtherApps: true)
    let primary = windows.filter(\.isPrimary)
    guard let controller = primary.first(where: { $0.id == windowID }) ?? primary.first else {
      openWindow(state: UIWindowState(hash: target, zoom: pageZoom))
      return
    }
    controller.showWindow(nil)
    if let target { controller.navigate(to: target) }
  }

  /// "Open in Terminal" from a window's Launch agent sheet.
  func openTerminals(_ launches: [TerminalLaunch], from window: NSWindow?) {
    TerminalAlerts.report(terminalLauncher.launch(launches), window: window)
  }

  // MARK: Actions

  /// Menu items land here when no window takes them first.
  @objc func hivemindCommand(_ sender: NSMenuItem) {
    guard let command = UIMenuCommand(tag: sender.tag) else { return }
    perform(command)
  }

  func perform(_ command: UIMenuCommand) {
    switch command {
    case .newWindow: openWindow()
    case .help: NSWorkspace.shared.open(documentationURL)
    default:
      // A page command from no window or an attachment window: the
      // frontmost Hivemind window takes it, or a new one whose page it
      // waits for.
      guard command.bridgeCommand != nil else { return }
      let front = NSApp.orderedWindows.lazy.compactMap { $0.windowController as? BrowserWindowController }.first(where: \.isPrimary)
      let target = front ?? openWindow()
      target.showWindow(nil)
      target.perform(command)
    }
  }

  func validateMenuItem(_ item: NSMenuItem) -> Bool {
    guard item.action == #selector(hivemindCommand(_:)), let command = UIMenuCommand(tag: item.tag) else { return true }
    return command == .newWindow || command == .help || command.bridgeCommand != nil
  }

  /// Launches Hivemind Server.app, or asks the running one to start its
  /// server (it may be stopped or failed): hivemind-server://start does both.
  func startServerApp() {
    guard let url = serverAppURL else { return }
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = false
    NSWorkspace.shared.open([ServerAppURLCommand.start.url], withApplicationAt: url, configuration: configuration) { _, error in
      guard let error else { return }
      let message = error.localizedDescription
      DispatchQueue.main.async {
        let alert = NSAlert()
        alert.messageText = "Hivemind Server could not be started"
        alert.informativeText = message
        alert.runModal()
      }
    }
  }
}

extension UIMenuCommand {
  /// Menu items carry their command as a tag: its index in allCases.
  var tag: Int { Self.allCases.firstIndex(of: self)! }

  init?(tag: Int) {
    guard Self.allCases.indices.contains(tag) else { return nil }
    self = Self.allCases[tag]
  }
}

/// Recreates windows from the last session. Only the route and zoom are
/// ours (UIWindowState); AppKit restores the frame.
final class WindowRestorer: NSObject, NSWindowRestoration {
  static let routeKey = "route"
  static let zoomKey = "zoom"

  static func restoreWindow(
    withIdentifier identifier: NSUserInterfaceItemIdentifier, state: NSCoder,
    completionHandler: @escaping (NSWindow?, (any Error)?) -> Void
  ) {
    MainActor.assumeIsolated {
      let route = state.decodeObject(of: NSString.self, forKey: routeKey) as String?
      let zoom = state.containsValue(forKey: zoomKey) ? state.decodeDouble(forKey: zoomKey) : PageZoom.actualSize
      let controller = BrowserWindowController(app: HivemindApp.shared, state: UIWindowState(hash: route, zoom: zoom))
      completionHandler(controller.window, nil)
    }
  }
}
