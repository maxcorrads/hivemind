import AppKit
import HivemindKit
import UserNotifications

/// Server.app stays up without a Hivemind.app window, so it presents the Mac
/// approval notice itself. The signed queue supplies IDs and public reason
/// only; no launch command, claim ticket or environment reaches a notice.
@MainActor
final class ServerApprovalNotifier: NSObject, LauncherApprovalNotifying, UNUserNotificationCenterDelegate {
  private var authorizing: Task<Bool, Never>?

  private var center: UNUserNotificationCenter? {
    Bundle.main.bundleIdentifier == nil ? nil : UNUserNotificationCenter.current()
  }

  func install() { center?.delegate = self }

  func notify(_ approval: LauncherApproval) {
    guard let center else { return }
    Task {
      guard await authorized(center) else { return }
      let content = UNMutableNotificationContent()
      content.title = "Worker awaiting approval"
      content.body = approval.reason.map { String($0.prefix(140)) } ?? "Open Hivemind to review the request."
      content.sound = .default
      try? await center.add(UNNotificationRequest(
        identifier: "hivemind.approval.\(approval.id)", content: content, trigger: nil))
    }
  }

  private func authorized(_ center: UNUserNotificationCenter) async -> Bool {
    if let authorizing { return await authorizing.value }
    let task = Task { @MainActor () -> Bool in
      switch await center.notificationSettings().authorizationStatus {
      case .authorized, .provisional: return true
      case .notDetermined: return (try? await center.requestAuthorization(options: [.alert, .sound])) ?? false
      default: return false
      }
    }
    authorizing = task
    let granted = await task.value
    authorizing = nil
    return granted
  }

  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
    withCompletionHandler completionHandler: @escaping () -> Void
  ) {
    DispatchQueue.main.async {
      guard let app = NSWorkspace.shared.urlForApplication(withBundleIdentifier: BundleID.ui) else { return }
      NSWorkspace.shared.open([UIAppURLCommand.inboxURL], withApplicationAt: app,
                              configuration: NSWorkspace.OpenConfiguration()) { _, _ in }
    }
    completionHandler()
  }

  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler([.banner, .list, .sound])
  }
}
