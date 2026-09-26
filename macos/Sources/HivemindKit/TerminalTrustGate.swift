import Foundation

/// Stands between a window's page and its TerminalBridgeRouter
/// (docs/macos.md#verifying-the-server). Terminal messages reach the router
/// only while the page is from a verified server. While the app is checking
/// a page it did not load itself, they wait here; a page that is not (or no
/// longer) verified gets `terminal-status` broker `unverified` and an error
/// for every request instead. Other bridge messages (ready, badge, notify)
/// never pass through here.
public struct TerminalTrustGate: Equatable, Sendable {
  public enum Mode: Equatable, Sendable {
    /// Relay to the router.
    case open
    /// Keep, to relay or refuse once the check is done.
    case held
    /// Refuse: terminals are off for this page.
    case closed
  }

  public enum Route: Equatable, Sendable {
    case relay(BridgeMessage)
    case answer(BridgeTerminalEvent)
    case drop
  }

  public nonisolated static let unverifiedMessage =
    "Terminals are off in this window: Hivemind couldn't verify that Hivemind Server started this server."
  /// Held messages kept at most; older ones are refused first.
  public static let capacity = 32

  public private(set) var mode: Mode
  public private(set) var held: [BridgeMessage] = []

  public init(mode: Mode = .closed) {
    self.mode = mode
  }

  /// What to do with one terminal message from the page. `held` may push
  /// out the oldest waiting message, which is refused.
  public mutating func route(_ message: BridgeMessage) -> [Route] {
    switch mode {
    case .open: return [.relay(message)]
    case .closed: return [Self.refusal(message)]
    case .held:
      held.append(message)
      guard held.count > Self.capacity else { return [] }
      return [Self.refusal(held.removeFirst())]
    }
  }

  /// The page is verified: what waited goes to the router, in order.
  public mutating func open() -> [BridgeMessage] {
    mode = .open
    defer { held = [] }
    return held
  }

  /// Checking: messages wait from now on.
  public mutating func hold() {
    if mode != .held { mode = .held }
  }

  /// Not verified: what waited is refused.
  public mutating func close() -> [BridgeTerminalEvent] {
    mode = .closed
    defer { held = [] }
    return held.compactMap { if case .answer(let event) = Self.refusal($0) { event } else { nil } }
  }

  /// A new document: nothing of the old page's waits any more.
  public mutating func pageDidChange() {
    held = []
  }

  /// How a page that may not use terminals is answered: its subscription
  /// with the `unverified` status, each request with an `unauthorized`
  /// error carrying its id, and the rest (input, resize, detach, ack,
  /// unsubscribe, for streams it cannot have) not at all.
  public static func refusal(_ message: BridgeMessage) -> Route {
    let error = { (id: String?) in
      Route.answer(.error(id: id, code: .unauthorized, message: unverifiedMessage, stream: nil))
    }
    switch message {
    case .sessionsSubscribe: return .answer(.status(tmux: .unknown, broker: .unverified))
    case .terminalLaunch(let id, _, _), .terminalAttach(let id, _, _), .terminalKill(let id, _): return error(id)
    case .terminalOpen: return error(nil)
    default: return .drop
    }
  }
}
