import HivemindKit
import SwiftUI

/// The connection screen: connecting to a Mac, or why that failed, with
/// what can be done about it. Every Mac is one tap away from here.
struct ConnectionView: View {
  let content: RemoteConnectScreenContent
  let controller: SceneController

  private var connecting: Bool {
    if case .connecting = controller.phase { true } else { false }
  }

  var body: some View {
    ContentUnavailableView {
      if connecting {
        ProgressView()
          .controlSize(.large)
          .padding(.bottom, 8)
        Text(content.title)
      } else {
        Label(content.title, systemImage: symbol)
      }
    } description: {
      if !content.detail.isEmpty { Text(content.detail) }
    } actions: {
      VStack(spacing: 12) {
        if content.offersRetry {
          Button("Try Again") { controller.retry() }
            .buttonStyle(.borderedProminent)
        }
        if content.offersPairAgain {
          Button("Pair Again…") { controller.showingPairing = true }
            .buttonStyle(.bordered)
        }
        Button("Macs…") { controller.showingMacs = true }
      }
    }
  }

  private var symbol: String {
    guard case .failed(_, let problem) = controller.phase else { return "desktopcomputer" }
    switch problem {
    case .unreachable: return "wifi.exclamationmark"
    case .pinMismatch: return "exclamationmark.lock"
    case .revoked: return "lock.slash"
    case .serverStopped: return "stop.circle"
    case .other: return "exclamationmark.triangle"
    }
  }
}
