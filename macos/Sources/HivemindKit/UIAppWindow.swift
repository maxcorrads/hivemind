import Foundation

/// WKWebView.pageZoom steps, the same ladder Safari uses.
public enum PageZoom {
  public static let levels: [Double] = [0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0]
  public static let actualSize = 1.0
  static let epsilon = 0.005

  public static func clamp(_ zoom: Double) -> Double {
    guard zoom.isFinite else { return actualSize }
    return min(max(zoom, levels.first!), levels.last!)
  }

  /// The next step above `zoom`, even when `zoom` sits between two steps.
  public static func zoomIn(from zoom: Double) -> Double {
    levels.first { $0 > zoom + epsilon } ?? levels.last!
  }

  public static func zoomOut(from zoom: Double) -> Double {
    levels.last { $0 < zoom - epsilon } ?? levels.first!
  }
}

/// What a window keeps across relaunches. Only the hash route is stored,
/// never the URL, so a server that comes back on another port still opens
/// the same place.
public struct UIWindowState: Equatable, Sendable {
  public let hash: String?
  public let zoom: Double

  public init(hash: String? = nil, zoom: Double = PageZoom.actualSize) {
    self.hash = hash.flatMap(BridgeCommand.validHash)
    self.zoom = PageZoom.clamp(zoom)
  }

  /// The hash route of a page on `endpoint`'s origin, still percent-encoded
  /// as hashFor wrote it. nil for other origins or pages other than the UI.
  public static func route(of url: URL?, endpoint: ServerEndpoint) -> String? {
    guard let url, endpoint.isSameOrigin(url),
          let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
          components.percentEncodedPath.isEmpty || components.percentEncodedPath == "/",
          let fragment = components.percentEncodedFragment else { return nil }
    return BridgeCommand.validHash(fragment)
  }

  public func url(endpoint: ServerEndpoint) -> URL {
    guard let hash else { return endpoint.baseURL }
    // Appended as text: URLComponents.fragment would encode hashFor's "%" again.
    return URL(string: endpoint.baseURL.absoluteString + hash) ?? endpoint.baseURL
  }
}

/// Native → web commands wait here until the page has said `ready`, so a
/// menu item or notification click during a load is delivered, not lost.
public struct BridgeOutbox: Sendable {
  public private(set) var isReady = false
  private var queued: [BridgeCommand] = []
  static let capacity = 16

  public init() {}

  /// Commands to evaluate now: this one if the page is ready, else none.
  public mutating func send(_ command: BridgeCommand) -> [BridgeCommand] {
    if isReady { return [command] }
    // Only the latest route matters; older ones would just flicker past.
    if case .navigate = command { queued.removeAll { if case .navigate = $0 { true } else { false } } }
    queued.append(command)
    if queued.count > Self.capacity { queued.removeFirst(queued.count - Self.capacity) }
    return []
  }

  /// The page loaded web/native-bridge.ts and listens: flush.
  public mutating func ready() -> [BridgeCommand] {
    isReady = true
    defer { queued.removeAll() }
    return queued
  }

  /// A new document is loading; its listener is not there yet.
  public mutating func pageWillLoad() { isReady = false }

  public mutating func discard() {
    isReady = false
    queued.removeAll()
  }
}

/// The Dock badge across windows. Every window reports the same Human's
/// attention total, so the badge is their maximum: a window still loading
/// (or on the connect screen) must not blank what another one shows.
public struct BadgeAggregator<Window: Hashable>: Sendable where Window: Sendable {
  private var counts: [Window: Int] = [:]

  public init() {}

  public var count: Int { counts.values.max() ?? 0 }

  public mutating func set(_ count: Int, for window: Window) { counts[window] = max(0, count) }

  public mutating func remove(_ window: Window) { counts[window] = nil }
}

/// Which pages may talk to the native bridge: the main frame of the local
/// server's own origin. Anything else (an iframe, a page that slipped past
/// the navigation policy) is ignored.
public enum BridgeOriginGate {
  /// `port` as WKSecurityOrigin reports it: 0 for the scheme's default.
  public static func accepts(isMainFrame: Bool, scheme: String, host: String, port: Int, endpoint: ServerEndpoint) -> Bool {
    isMainFrame && scheme.lowercased() == "http" && host == ServerEndpoint.host
      && (port == 0 ? 80 : port) == endpoint.port.value
  }
}

/// NavigationPolicy, plus the frame context WKWebView gives: an iframe may
/// only send the user to the browser when they clicked a link in it.
public enum UIAppNavigation {
  public static func decide(_ url: URL, endpoint: ServerEndpoint, isMainFrame: Bool, userActivated: Bool) -> NavigationDecision {
    let decision = NavigationPolicy.decide(url, endpoint: endpoint)
    if decision == .openExternally, !isMainFrame, !userActivated { return .deny }
    return decision
  }
}

/// UserDefaults keys only the UI app reads (the port is SettingsKey.port).
public enum UIAppSettingsKey {
  /// The zoom new windows open at: the last one the user picked.
  public static let pageZoom = "pageZoom"
  /// `defaults write com.maxcorrads.hivemind webInspector -bool true` makes
  /// the web views inspectable from Safari's Develop menu (macOS 13.3+).
  public static let webInspector = "webInspector"
}
