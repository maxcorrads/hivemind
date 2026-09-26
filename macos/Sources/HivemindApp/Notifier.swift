import AppKit
import HivemindKit
import UserNotifications

/// Native notifications for the notices web/native-bridge.ts forwards. The OS
/// permission replaces the web UI's opt-in toggle: it is asked for the first
/// time there is something to show, never at launch.
@MainActor
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
  /// A click: the notice's route and the window that raised it.
  var onOpen: (String?, String?) -> Void = { _, _ in }

  private var deduper = NoticeDeduper()
  private var authorizing: Task<Bool, Never>?

  /// nil outside an app bundle (`swift run`), where UNUserNotificationCenter
  /// traps instead of failing.
  private var center: UNUserNotificationCenter? {
    Bundle.main.bundleIdentifier == nil ? nil : UNUserNotificationCenter.current()
  }

  func install() {
    center?.delegate = self
  }

  func post(_ notice: UIAppNotice) {
    // Each open window sees the same event; the first copy wins.
    guard deduper.admit(tag: notice.tag) else { return }
    // The Human is in the app already; the badge and unread marks say it.
    guard !NSApp.isActive, let center else { return }
    Task {
      guard await authorized(center) else { return }
      let content = UNMutableNotificationContent()
      content.title = notice.title
      content.body = notice.body
      content.sound = .default
      content.userInfo = notice.userInfo
      try? await center.add(UNNotificationRequest(identifier: notice.identifier(), content: content, trigger: nil))
    }
  }

  /// One permission request at a time; later notices wait for its answer.
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
    let destination = UIAppNotice.destination(userInfo: response.notification.request.content.userInfo)
    DispatchQueue.main.async {
      MainActor.assumeIsolated { self.onOpen(destination.target, destination.windowID) }
    }
    completionHandler()
  }

  /// Notices are only posted while the app is in the background, but one can
  /// land just after the user switched back: show it in the list only.
  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler([.list])
  }
}
