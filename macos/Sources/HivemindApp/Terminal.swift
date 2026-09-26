import AppKit
import HivemindKit

/// Opens a .command script in Terminal.app, like a double-click on it:
/// Terminal runs it in a new window. No Apple Events, so no Automation
/// permission prompt.
@MainActor
final class TerminalAppOpener: TerminalOpening {
  static let bundleID = "com.apple.Terminal"

  func open(script: URL) throws {
    guard let terminal = NSWorkspace.shared.urlForApplication(withBundleIdentifier: Self.bundleID) else {
      throw TerminalLaunchError.terminalMissing
    }
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.activates = true
    NSWorkspace.shared.open([script], withApplicationAt: terminal, configuration: configuration) { _, error in
      guard let error else { return }
      let message = error.localizedDescription
      Task { @MainActor in
        // Terminal never got it, so the script never deletes itself.
        try? FileManager.default.removeItem(at: script)
        TerminalAlerts.show(title: "Terminal could not be opened", lines: [message], window: nil)
      }
    }
  }
}

@MainActor
enum TerminalAlerts {
  /// One alert for everything that did not open, as a sheet on the window
  /// that asked when there is one.
  static func report(_ outcomes: [TerminalLaunchOutcome], window: NSWindow?) {
    var missing: [String] = []
    var failed: [String] = []
    for outcome in outcomes {
      switch outcome {
      case .opened: break
      case .missingFolder(let title, let folder): missing.append("“\(title)”: \(folder)")
      case .failed(let title, let reason): failed.append("“\(title)”: \(reason)")
      }
    }
    if !missing.isEmpty {
      show(title: missing.count == 1 ? "Folder not found" : "Folders not found",
           lines: [missing.count == 1
             ? "This terminal was not opened because its folder does not exist:"
             : "These terminals were not opened because their folders do not exist:"] + missing,
           window: window)
    }
    if !failed.isEmpty {
      show(title: "Could not open Terminal", lines: failed, window: window)
    }
  }

  static func show(title: String, lines: [String], window: NSWindow?) {
    let alert = NSAlert()
    alert.alertStyle = .warning
    alert.messageText = title
    alert.informativeText = lines.joined(separator: "\n")
    if let window, window.attachedSheet == nil {
      alert.beginSheetModal(for: window, completionHandler: nil)
    } else {
      alert.runModal()
    }
  }
}
