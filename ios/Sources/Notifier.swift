import HivemindKit
import UIKit
import UserNotifications

/// Local notifications for the notices web/native-bridge.ts forwards, and
/// the app icon's badge (docs/ios.md#notifications). While the app is in
/// front a notice shows as a banner (AppModel.post already dropped those
/// about the conversation a window in front shows); in the background it
/// is a normal notification while iOS still lets the app run. Permission is
/// asked for the first time there is something to show, never at launch.
/// There is no push (APNs) yet: once iOS suspends the app, nothing arrives.
@MainActor
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
  /// A tap: the notice's route and the scene that raised it.
  var onOpen: (String?, String?) -> Void = { _, _ in }

  private let center = UNUserNotificationCenter.current()
  private var deduper = NoticeDeduper()
  private var authorizing: Task<Bool, Never>?
  private var badge = 0

  func install() {
    center.delegate = self
  }

  func post(_ notice: UIAppNotice) {
    // Each scene sees the same event; the first copy wins.
    guard deduper.admit(tag: notice.tag) else { return }
    Task {
      guard await authorized(asking: true) else { return }
      let content = UNMutableNotificationContent()
      content.title = notice.title
      content.body = notice.body
      content.sound = .default
      content.userInfo = notice.userInfo
      content.targetContentIdentifier = notice.windowID
      try? await center.add(UNNotificationRequest(identifier: notice.identifier(), content: content, trigger: nil))
    }
  }

  /// The app icon's badge. Setting it needs notification permission, which
  /// is only asked for with the first notice; until then it is remembered.
  func setBadge(_ count: Int) {
    guard count != badge else { return }
    badge = count
    Task {
      guard await authorized(asking: false) else { return }
      try? await center.setBadgeCount(badge)
    }
  }

  /// One permission request at a time; later callers wait for its answer.
  private func authorized(asking: Bool) async -> Bool {
    if let authorizing { return await authorizing.value }
    let center = center
    let task = Task { @MainActor () -> Bool in
      switch await center.notificationSettings().authorizationStatus {
      case .authorized, .provisional, .ephemeral: return true
      case .notDetermined:
        guard asking else { return false }
        return (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
      default: return false
      }
    }
    authorizing = task
    let granted = await task.value
    authorizing = nil
    if granted, asking { try? await center.setBadgeCount(badge) }
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

  /// The app is in front: an in-app banner, also kept in Notification
  /// Center. Only notices worth it get here (AppModel.post).
  nonisolated func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
    withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    completionHandler([.banner, .list, .sound])
  }
}
