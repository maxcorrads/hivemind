import HivemindKit
import SwiftUI

extension FocusedValues {
  /// The scene the keyboard and menu commands go to.
  @Entry var sceneController: SceneController?
}

/// The menu bar and keyboard shortcuts on iPad (and a hardware keyboard on
/// iPhone): the same commands and shortcuts as Hivemind.app on the Mac
/// (UIMenuCommand), sent to the scene in front.
struct HivemindCommands: Commands {
  @FocusedValue(\.sceneController) private var scene
  @Environment(\.openWindow) private var openWindow
  @Environment(\.openURL) private var openURL

  var body: some Commands {
    CommandGroup(replacing: .newItem) {
      Button(UIMenuCommand.newWindow.title) { openWindow(id: HivemindApp.windowGroupID) }
        .shortcut(.newWindow)
      item(.newChannel)
      Divider()
      Button("Switch Mac…") { scene?.showingMacs = true }
        .keyboardShortcut("m", modifiers: [.command, .shift])
        .disabled(scene == nil)
      Button("Pair with a Mac…") { scene?.showingPairing = true }
        .disabled(scene == nil)
    }
    CommandGroup(replacing: .appSettings) {
      item(.settings)
    }
    CommandGroup(before: .toolbar) {
      item(.reload)
      item(.toggleTheme)
      Divider()
      item(.actualSize)
      item(.zoomIn)
      item(.zoomOut)
      Divider()
    }
    CommandMenu("Go") {
      item(.back)
      item(.forward)
      Divider()
      item(.jump)
      item(.forYou)
    }
    CommandGroup(replacing: .help) {
      Button(UIMenuCommand.help.title) { openURL(documentationURL) }
    }
  }

  private func item(_ command: UIMenuCommand) -> some View {
    Button(command.title) { scene?.perform(command) }
      .shortcut(command)
      .disabled(!(scene?.canPerform(command) ?? false))
  }
}

private extension View {
  /// UIMenuCommand's shortcut, as SwiftUI spells it.
  @ViewBuilder func shortcut(_ command: UIMenuCommand) -> some View {
    if let shortcut = command.shortcut, let key = shortcut.key.first {
      keyboardShortcut(KeyEquivalent(key), modifiers: shortcut.modifiers.eventModifiers)
    } else {
      self
    }
  }
}

private extension ShortcutModifiers {
  var eventModifiers: EventModifiers {
    var modifiers: EventModifiers = []
    if contains(.command) { modifiers.insert(.command) }
    if contains(.shift) { modifiers.insert(.shift) }
    if contains(.option) { modifiers.insert(.option) }
    if contains(.control) { modifiers.insert(.control) }
    return modifiers
  }
}
