import Foundation

/// Modifier keys, kept free of AppKit so the menu table is testable.
public struct ShortcutModifiers: OptionSet, Hashable, Sendable {
  public let rawValue: Int
  public init(rawValue: Int) { self.rawValue = rawValue }

  public static let command = ShortcutModifiers(rawValue: 1 << 0)
  public static let shift = ShortcutModifiers(rawValue: 1 << 1)
  public static let option = ShortcutModifiers(rawValue: 1 << 2)
  public static let control = ShortcutModifiers(rawValue: 1 << 3)
}

public struct MenuShortcut: Hashable, Sendable {
  /// Lowercase key; Shift is spelled out in `modifiers`.
  public let key: String
  public let modifiers: ShortcutModifiers

  public init(_ key: String, _ modifiers: ShortcutModifiers = .command) {
    self.key = key
    self.modifiers = modifiers
  }
}

/// The Hivemind-specific menu items. Standard ones (Quit, Hide, Edit,
/// Window) come from AppKit's own selectors and are not listed here.
public enum UIMenuCommand: CaseIterable, Sendable {
  case settings
  case newWindow
  case newChannel
  case closeWindow
  case reload
  case actualSize
  case zoomIn
  case zoomOut
  case toggleTheme
  case back
  case forward
  case jump
  case forYou
  case help

  public var title: String {
    switch self {
    case .settings: "Settings…"
    case .newWindow: "New Window"
    case .newChannel: "New Channel…"
    case .closeWindow: "Close"
    case .reload: "Reload"
    case .actualSize: "Actual Size"
    case .zoomIn: "Zoom In"
    case .zoomOut: "Zoom Out"
    case .toggleTheme: "Toggle Theme"
    case .back: "Back"
    case .forward: "Forward"
    case .jump: "Jump to…"
    case .forYou: "For You"
    case .help: "Hivemind Help"
    }
  }

  public var shortcut: MenuShortcut? {
    switch self {
    case .settings: MenuShortcut(",")
    case .newWindow: MenuShortcut("n")
    case .newChannel: MenuShortcut("n", [.command, .shift])
    case .closeWindow: MenuShortcut("w")
    case .reload: MenuShortcut("r")
    case .actualSize: MenuShortcut("0")
    case .zoomIn: MenuShortcut("+")
    case .zoomOut: MenuShortcut("-")
    case .toggleTheme, .help: nil
    case .back: MenuShortcut("[")
    case .forward: MenuShortcut("]")
    case .jump: MenuShortcut("k")
    case .forYou: MenuShortcut("i", [.command, .shift])
    }
  }

  /// What the item asks of the page. nil for items the app handles itself.
  public var bridgeCommand: BridgeCommand? {
    switch self {
    case .settings: .settings
    case .newChannel: .newChannel
    case .toggleTheme: .toggleTheme
    case .jump: .jump
    case .forYou: .forYou
    case .newWindow, .closeWindow, .reload, .actualSize, .zoomIn, .zoomOut, .back, .forward, .help: nil
    }
  }
}
