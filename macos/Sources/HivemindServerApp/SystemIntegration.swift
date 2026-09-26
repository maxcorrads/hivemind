import AppKit
import HivemindKit
import ServiceManagement

/// Launch at login through SMAppService.mainApp: the app itself is the login
/// item, so there is no helper to ship. Touched only from the menu.
@MainActor
final class MainAppLoginItem: LoginItemControlling {
  private var service: SMAppService { .mainApp }

  var status: LoginItemStatus {
    switch service.status {
    case .enabled: .enabled
    case .requiresApproval: .requiresApproval
    // .notFound: never registered from this copy of the app.
    default: .disabled
    }
  }

  func register() throws { try service.register() }
  func unregister() throws { try service.unregister() }
  func openSystemSettings() { SMAppService.openSystemSettingsLoginItems() }
}

/// Runs an AppleScript that asks for an administrator password. NSAppleScript
/// blocks until the user answers, which is what the menu action wants.
@MainActor
enum AdminScript {
  enum Outcome { case done, cancelled, failed(String) }

  static func run(_ source: String) -> Outcome {
    guard let script = NSAppleScript(source: source) else { return .failed("Could not prepare the installer script") }
    var error: NSDictionary?
    script.executeAndReturnError(&error)
    guard let error else { return .done }
    // -128: the user pressed Cancel in the password prompt.
    if (error[NSAppleScript.errorNumber] as? Int) == -128 { return .cancelled }
    return .failed(error[NSAppleScript.errorMessage] as? String ?? "The installer failed")
  }
}
