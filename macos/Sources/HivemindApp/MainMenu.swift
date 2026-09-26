import AppKit
import HivemindKit

/// The menu bar, built in code: the app has no nib. Hivemind items all send
/// `hivemindCommand:` down the responder chain (the key window's controller
/// first, then the app delegate) with their UIMenuCommand as the tag.
@MainActor
enum MainMenu {
  static func build() -> NSMenu {
    let main = NSMenu()
    let appName = "Hivemind"

    main.addSubmenu("", [
      item("About \(appName)", #selector(NSApplication.orderFrontStandardAboutPanel(_:))),
      .separator(),
      command(.settings),
      .separator(),
      servicesItem(),
      .separator(),
      item("Hide \(appName)", #selector(NSApplication.hide(_:)), "h"),
      item("Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option]),
      item("Show All", #selector(NSApplication.unhideAllApplications(_:))),
      .separator(),
      item("Quit \(appName)", #selector(NSApplication.terminate(_:)), "q"),
    ])

    main.addSubmenu("File", [
      command(.newWindow),
      command(.newChannel),
      .separator(),
      item(UIMenuCommand.closeWindow.title, #selector(NSWindow.performClose(_:)), "w"),
    ])

    main.addSubmenu("Edit", [
      item("Undo", Selector(("undo:")), "z"),
      item("Redo", Selector(("redo:")), "z", [.command, .shift]),
      .separator(),
      item("Cut", #selector(NSText.cut(_:)), "x"),
      item("Copy", #selector(NSText.copy(_:)), "c"),
      item("Paste", #selector(NSText.paste(_:)), "v"),
      item("Paste and Match Style", #selector(NSTextView.pasteAsPlainText(_:)), "v", [.command, .option, .shift]),
      item("Delete", #selector(NSText.delete(_:))),
      item("Select All", #selector(NSText.selectAll(_:)), "a"),
    ])

    // AppKit adds Enter Full Screen and the tab items to a menu titled "View".
    main.addSubmenu("View", [
      command(.reload),
      .separator(),
      command(.actualSize),
      command(.zoomIn),
      command(.zoomOut),
      .separator(),
      command(.toggleTheme),
    ])

    main.addSubmenu("Go", [
      command(.back),
      command(.forward),
      .separator(),
      command(.jump),
      command(.forYou),
    ])

    let window = main.addSubmenu("Window", [
      item("Minimize", #selector(NSWindow.performMiniaturize(_:)), "m"),
      item("Zoom", #selector(NSWindow.performZoom(_:))),
      .separator(),
      item("Bring All to Front", #selector(NSApplication.arrangeInFront(_:))),
    ])
    NSApp.windowsMenu = window

    let help = main.addSubmenu("Help", [command(.help)])
    NSApp.helpMenu = help

    return main
  }

  private static func command(_ command: UIMenuCommand) -> NSMenuItem {
    let menuItem = NSMenuItem(title: command.title, action: #selector(HivemindApp.hivemindCommand(_:)), keyEquivalent: "")
    menuItem.tag = command.tag
    if let shortcut = command.shortcut { apply(shortcut, to: menuItem) }
    return menuItem
  }

  private static func item(
    _ title: String, _ action: Selector, _ key: String = "", _ modifiers: ShortcutModifiers = .command
  ) -> NSMenuItem {
    let menuItem = NSMenuItem(title: title, action: action, keyEquivalent: "")
    if !key.isEmpty { apply(MenuShortcut(key, modifiers), to: menuItem) }
    return menuItem
  }

  private static func servicesItem() -> NSMenuItem {
    let services = NSMenu(title: "Services")
    NSApp.servicesMenu = services
    let menuItem = NSMenuItem(title: "Services", action: nil, keyEquivalent: "")
    menuItem.submenu = services
    return menuItem
  }

  private static func apply(_ shortcut: MenuShortcut, to menuItem: NSMenuItem) {
    menuItem.keyEquivalent = shortcut.key
    var mask: NSEvent.ModifierFlags = []
    if shortcut.modifiers.contains(.command) { mask.insert(.command) }
    if shortcut.modifiers.contains(.shift) { mask.insert(.shift) }
    if shortcut.modifiers.contains(.option) { mask.insert(.option) }
    if shortcut.modifiers.contains(.control) { mask.insert(.control) }
    menuItem.keyEquivalentModifierMask = mask
  }
}

private extension NSMenu {
  @discardableResult
  func addSubmenu(_ title: String, _ items: [NSMenuItem]) -> NSMenu {
    let submenu = NSMenu(title: title)
    items.forEach(submenu.addItem)
    let holder = NSMenuItem(title: title, action: nil, keyEquivalent: "")
    holder.submenu = submenu
    addItem(holder)
    return submenu
  }
}
