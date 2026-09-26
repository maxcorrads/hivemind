import HivemindKit
import SwiftUI

// The iOS/iPadOS app: the Human UI of a Hivemind server on the user's Mac,
// reached through Hivemind Server.app's remote gateway (docs/remote-access.md,
// docs/ios.md). Every scene is its own window with its own web view and
// terminal connection; the logic that can be tested without UIKit lives in
// HivemindKit (the Remote* types).
@main
struct HivemindApp: App {
  static let windowGroupID = "hivemind"

  @State private var model = AppModel()
  @Environment(\.scenePhase) private var scenePhase

  var body: some Scene {
    WindowGroup(id: Self.windowGroupID) {
      SceneRoot()
        .environment(model)
    }
    .commands { HivemindCommands() }
    .onChange(of: scenePhase) { _, phase in model.appPhaseChanged(phase) }
  }
}

/// What the app says about itself, checked against HivemindKit by the tests.
enum AppInfo {
  static var bundleIdentifier: String? { Bundle.main.bundleIdentifier }
  static let expectedBundleIdentifier = BundleID.ios
}
