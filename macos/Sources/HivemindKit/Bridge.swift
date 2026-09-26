import Foundation

/// The WKScriptMessageHandler name web/native-bridge.ts posts to
/// (window.webkit.messageHandlers.hivemind).
public let bridgeHandlerName = "hivemind"

/// The DOM event native commands arrive as (`CustomEvent` with detail).
public let bridgeEventName = "hivemind:native"

/// Web → native. Parsed from the WKScriptMessage body (a JSON-like
/// dictionary); anything malformed is dropped, never trusted partially.
public enum BridgeMessage: Equatable, Sendable {
  case ready
  /// `target` is the hash route the notice opens ("#" + hashFor(notice.target)).
  case notify(title: String, body: String, tag: String?, target: String?)
  case badge(count: Int)
  /// "Open in Terminal" from the Launch agent sheet: 1–24 terminals, each
  /// validated by TerminalLaunch. One bad launch drops the whole message.
  case launchTerminal([TerminalLaunch])

  static let maxText = 4096

  public init?(body: Any) {
    guard let object = body as? [String: Any], let type = object["type"] as? String else { return nil }
    switch type {
    case "ready":
      self = .ready
    case "notify":
      guard let title = Self.text(object["title"]), !title.isEmpty else { return nil }
      self = .notify(
        title: title,
        body: Self.text(object["body"]) ?? "",
        tag: Self.text(object["tag"]).flatMap { $0.isEmpty ? nil : $0 },
        target: Self.text(object["target"]).flatMap(BridgeCommand.validHash))
    case "badge":
      // WebKit hands JS numbers over as NSNumber; a Bool is an NSNumber too.
      guard let number = object["count"] as? NSNumber,
            CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
      let value = number.doubleValue
      guard value.isFinite, value >= 0, value == value.rounded() else { return nil }
      self = .badge(count: Int(min(value, Double(Int32.max))))
    case "launch-terminal":
      guard let launches = TerminalLaunch.list(object["launches"]) else { return nil }
      self = .launchTerminal(launches)
    default:
      return nil
    }
  }

  private static func text(_ value: Any?) -> String? {
    guard let string = value as? String else { return nil }
    return string.count > maxText ? String(string.prefix(maxText)) : string
  }
}

/// NSApp.dockTile.badgeLabel for an attention total: nothing at zero.
public func dockBadgeLabel(count: Int) -> String? {
  count > 0 ? String(count) : nil
}

/// Native → web commands, delivered by evaluating `javaScript` in the page.
public enum BridgeCommand: Equatable, Sendable {
  case jump
  case forYou
  case newChannel
  case settings
  case toggleTheme
  /// Go to an in-app hash route ("#/…").
  case navigate(hash: String)

  public var name: String {
    switch self {
    case .jump: "jump"
    case .forYou: "for-you"
    case .newChannel: "new-channel"
    case .settings: "settings"
    case .toggleTheme: "toggle-theme"
    case .navigate: "navigate"
    }
  }

  /// A hash route the app may navigate to, normalized to start with "#"
  /// (web/selection.ts hashFor returns it without). Whitespace or control
  /// characters drop it rather than being escaped.
  public static func validHash(_ raw: String) -> String? {
    let value = raw.hasPrefix("#") ? raw : "#" + raw
    guard value.count > 1, value.count <= 2048,
          !value.unicodeScalars.contains(where: { CharacterSet.whitespacesAndNewlines.contains($0) || CharacterSet.controlCharacters.contains($0) })
    else { return nil }
    return value
  }

  /// window.dispatchEvent(new CustomEvent("hivemind:native", {detail})) with
  /// the detail as JSON, so no value is ever spliced into script text raw.
  public var javaScript: String {
    var detail: [String: String] = ["command": name]
    if case .navigate(let hash) = self { detail["hash"] = hash }
    let data = (try? JSONSerialization.data(withJSONObject: detail, options: [.sortedKeys])) ?? Data("{}".utf8)
    // JSON is valid JS except for U+2028/U+2029 in older engines; escape them anyway.
    let json = String(decoding: data, as: UTF8.self)
      .replacingOccurrences(of: "\u{2028}", with: "\\u2028")
      .replacingOccurrences(of: "\u{2029}", with: "\\u2029")
    return "window.dispatchEvent(new CustomEvent(\(Self.quoted(bridgeEventName)), {detail: \(json)}));"
  }

  private static func quoted(_ value: String) -> String {
    let data = (try? JSONSerialization.data(withJSONObject: [value], options: [])) ?? Data("[\"\"]".utf8)
    return String(String(decoding: data, as: UTF8.self).dropFirst().dropLast())
  }
}
