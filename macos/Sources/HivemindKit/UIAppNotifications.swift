import Foundation

/// A notice as the UI app posts it through UNUserNotificationCenter, and
/// what a click on it carries back.
public struct UIAppNotice: Equatable, Sendable {
  public let title: String
  public let body: String
  public let tag: String?
  /// The hash route the click opens.
  public let target: String?
  /// The window that raised it, so the click returns there if it is open.
  public let windowID: String?

  static let targetKey = "target"
  static let windowKey = "window"

  public init(title: String, body: String, tag: String?, target: String?, windowID: String?) {
    self.title = title
    self.body = body
    self.tag = tag
    self.target = target.flatMap(BridgeCommand.validHash)
    self.windowID = windowID
  }

  /// A notice with a tag replaces an earlier one with the same tag, like the
  /// browser Notification API does; untagged ones never collide.
  public func identifier(fallback: @autoclosure () -> String = UUID().uuidString) -> String {
    "hivemind.notice." + (tag ?? fallback())
  }

  public var userInfo: [String: String] {
    var info: [String: String] = [:]
    info[Self.targetKey] = target
    info[Self.windowKey] = windowID
    return info
  }

  /// Where a clicked notification should go. The target is revalidated: the
  /// dictionary comes back from the system, not from us.
  public static func destination(userInfo: [AnyHashable: Any]) -> (target: String?, windowID: String?) {
    let target = (userInfo[targetKey] as? String).flatMap(BridgeCommand.validHash)
    return (target, userInfo[windowKey] as? String)
  }
}

/// Drops the copies of one notice: every open window sees the same live
/// event and may forward it.
public struct NoticeDeduper: Sendable {
  private var seen: [String] = []
  private var lookup: Set<String> = []
  public let capacity: Int

  public init(capacity: Int = 256) { self.capacity = max(1, capacity) }

  /// True the first time a tag is offered. Untagged notices always pass.
  public mutating func admit(tag: String?) -> Bool {
    guard let tag else { return true }
    guard lookup.insert(tag).inserted else { return false }
    seen.append(tag)
    if seen.count > capacity { lookup.remove(seen.removeFirst()) }
    return true
  }
}
