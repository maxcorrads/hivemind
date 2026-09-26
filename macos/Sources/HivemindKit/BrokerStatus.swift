import Foundation

/// The terminal broker as Hivemind Server.app's menu shows it: one disabled
/// "Terminals: …" line. Kept apart from SwiftUI so every wording is tested.
public struct BrokerStatus: Equatable, Sendable {
  public enum State: Equatable, Sendable {
    case stopped
    /// Serving on its socket.
    case listening
    /// It could not start (a file it needs, the socket); `reason` says why.
    case failed(String)
  }

  public var state: State
  /// Where tmux is, or nil when it was not found.
  public var tmuxPath: String?
  /// Sessions on Hivemind's tmux server; nil until the first list.
  public var sessionCount: Int?
  /// Streams attached through the broker right now.
  public var streamCount: Int

  public init(state: State, tmuxPath: String?, sessionCount: Int?, streamCount: Int = 0) {
    self.state = state
    self.tmuxPath = tmuxPath
    self.sessionCount = sessionCount
    self.streamCount = streamCount
  }

  public var title: String {
    switch state {
    case .stopped:
      return "Terminals: stopped"
    case .failed(let reason):
      return ServerAppStatus.clipped("Terminals: unavailable (\(reason))")
    case .listening:
      guard tmuxPath != nil else { return "Terminals: tmux not found (brew install tmux)" }
      guard let sessionCount else { return "Terminals: tmux found" }
      let sessions = switch sessionCount {
      case 0: "no sessions"
      case 1: "1 session"
      default: "\(sessionCount) sessions"
      }
      return streamCount == 0 ? "Terminals: \(sessions)" : "Terminals: \(sessions), \(streamCount) open in Hivemind"
    }
  }
}
