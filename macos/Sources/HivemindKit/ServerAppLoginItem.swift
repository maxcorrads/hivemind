import Foundation

/// SMAppService.mainApp's status, without importing ServiceManagement here.
public enum LoginItemStatus: Equatable, Sendable {
  case enabled
  case disabled
  /// Registered, but the user has not allowed it in System Settings yet.
  case requiresApproval
}

/// The login item seam: the app wraps SMAppService.mainApp, tests a fake.
/// Nothing here runs until the user clicks the menu item.
@MainActor
public protocol LoginItemControlling: AnyObject {
  var status: LoginItemStatus { get }
  func register() throws
  func unregister() throws
  func openSystemSettings()
}

public enum LoginItemOutcome: Equatable, Sendable {
  case enabled
  case disabled
  /// macOS wants the user to allow it; System Settings was opened.
  case needsApproval
  case failed(String)
}

@MainActor
public enum LoginItemToggle {
  /// What one click on "Launch at Login" does. A pending approval is not
  /// "on", but unregistering it would lose the request, so it opens the
  /// settings pane where the user can allow it instead.
  public static func toggle(_ item: any LoginItemControlling) -> LoginItemOutcome {
    do {
      switch item.status {
      case .enabled:
        try item.unregister()
        return .disabled
      case .requiresApproval:
        item.openSystemSettings()
        return .needsApproval
      case .disabled:
        try item.register()
        if item.status == .requiresApproval {
          item.openSystemSettings()
          return .needsApproval
        }
        return .enabled
      }
    } catch {
      return .failed(error.localizedDescription)
    }
  }
}
