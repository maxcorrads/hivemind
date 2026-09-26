import AppKit
import HivemindKit

/// The few modal dialogs the menu opens. A menu-bar app is never active on
/// its own, so each one activates it first or the dialog opens behind others.
@MainActor
enum Dialogs {
  static func activate() {
    if #available(macOS 14, *) {
      NSApp.activate()
    } else {
      NSApp.activate(ignoringOtherApps: true)
    }
  }

  static func error(_ title: String, _ message: String) {
    show(title, message, style: .warning)
  }

  static func info(_ title: String, _ message: String) {
    show(title, message, style: .informational)
  }

  private static func show(_ title: String, _ message: String, style: NSAlert.Style) {
    activate()
    let alert = NSAlert()
    alert.alertStyle = style
    alert.messageText = title
    alert.informativeText = message
    alert.runModal()
  }

  static func confirm(_ title: String, _ message: String, action: String) -> Bool {
    activate()
    let alert = NSAlert()
    alert.alertStyle = .warning
    alert.messageText = title
    alert.informativeText = message
    alert.addButton(withTitle: action)
    alert.addButton(withTitle: "Cancel")
    return alert.runModal() == .alertFirstButtonReturn
  }

  /// The raw text typed, or nil on Cancel; the caller validates it.
  static func askPort(title: String = "Server Port", current: ServerPort, defaultPort: ServerPort = .default, info: String) -> String? {
    activate()
    let alert = NSAlert()
    alert.messageText = title
    alert.informativeText = info
    let field = NSTextField(string: current.description)
    field.placeholderString = defaultPort.description
    field.frame = NSRect(x: 0, y: 0, width: 120, height: 24)
    alert.accessoryView = field
    alert.addButton(withTitle: "Save")
    alert.addButton(withTitle: "Cancel")
    alert.addButton(withTitle: "Use Default")
    alert.window.initialFirstResponder = field
    switch alert.runModal() {
    case .alertFirstButtonReturn: return field.stringValue
    case .alertThirdButtonReturn: return defaultPort.description
    default: return nil
    }
  }

  static func chooseFolder(starting: URL, message: String) -> URL? {
    activate()
    let panel = NSOpenPanel()
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.canCreateDirectories = true
    panel.allowsMultipleSelection = false
    panel.showsHiddenFiles = true
    panel.prompt = "Use Folder"
    panel.message = message
    let existing = FileManager.default.fileExists(atPath: starting.path) ? starting : starting.deletingLastPathComponent()
    panel.directoryURL = existing
    return panel.runModal() == .OK ? panel.url : nil
  }

  static func chooseCommandLineDestination(system: URL, user: URL, userLabel: String) -> URL? {
    activate()
    let userFolder = (userLabel as NSString).deletingLastPathComponent
    let alert = NSAlert()
    alert.messageText = "Install the hivemind command-line tool"
    alert.informativeText = """
      Installs a small “hivemind” script that runs the CLI with this app’s bundled Node.js, \
      so “hivemind” works in Terminal without installing Node.

      \(system.deletingLastPathComponent().path) may ask for an administrator password. \
      \(userFolder) does not, but it must be on your PATH.
      """
    alert.addButton(withTitle: "Install in \(system.deletingLastPathComponent().path)")
    alert.addButton(withTitle: "Install in \(userFolder)")
    alert.addButton(withTitle: "Cancel")
    switch alert.runModal() {
    case .alertFirstButtonReturn: return system
    case .alertSecondButtonReturn: return user
    default: return nil
    }
  }
}
