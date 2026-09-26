import Foundation

// What one iOS scene (a window showing one Mac through its gateway) decides
// without UIKit: which navigations stay in the web view, which frames may
// use the bridge, how a route becomes a URL, what the page is told about
// the platform, how terminal messages differ from the Mac app's, and what
// the connection screen says. The macOS equivalents (NavigationPolicy,
// BridgeOriginGate, UIWindowState, ConnectScreenContent) take a loopback
// ServerEndpoint; these take the gateway's GatewayEndpoint.

/// The platform name the iOS app reports to the page, on iPhone and iPad
/// alike: the page hides what only a Mac can do (Terminal.app).
public enum RemoteClientPlatform {
  public static let name = "ios"
}

/// Keeps the web view on the gateway's origin, as NavigationPolicy keeps
/// the Mac app's on the loopback one: the device-session cookie must never
/// travel with, or be replaced by, another page.
public enum RemoteClientNavigation {
  static let externalSchemes: Set<String> = ["http", "https", "mailto"]

  public static func decide(_ url: URL, endpoint: GatewayEndpoint, isMainFrame: Bool, userActivated: Bool) -> NavigationDecision {
    let decision = decide(url, endpoint: endpoint)
    // An iframe may only send the person to Safari when they tapped a link in it.
    if decision == .openExternally, !isMainFrame, !userActivated { return .deny }
    return decision
  }

  static func decide(_ url: URL, endpoint: GatewayEndpoint) -> NavigationDecision {
    let scheme = url.scheme?.lowercased() ?? ""
    if scheme == "https", endpoint.isSameOrigin(url) { return .allow }
    // about:blank and about:srcdoc are how iframes and window.open start.
    if scheme == "about" { return url.absoluteString == "about:blank" || url.absoluteString == "about:srcdoc" ? .allow : .deny }
    // blob: URLs the page itself created (downloads, previews) carry its origin.
    if scheme == "blob", let inner = URL(string: String(url.absoluteString.dropFirst("blob:".count))) {
      return inner.scheme?.lowercased() == "https" && endpoint.isSameOrigin(inner) ? .allow : .deny
    }
    if externalSchemes.contains(scheme), url.user == nil, url.password == nil { return .openExternally }
    return .deny
  }

  /// What the app does with the main document's HTTP status.
  public enum MainFrameStatus: Equatable, Sendable {
    /// Show it.
    case show
    /// The gateway no longer knows the device session (401 from the
    /// gateway, which Hivemind Server forgot on a restart): get a new one
    /// and load again, once.
    case renewSession
    /// The Node server is not running behind the gateway (502): show the
    /// connection screen instead of the gateway's JSON.
    case serverStopped
  }

  public static func mainFrameStatus(_ status: Int) -> MainFrameStatus {
    switch status {
    case GatewayErrorCode.unauthorized.httpStatus: .renewSession
    case GatewayErrorCode.serverUnavailable.httpStatus: .serverStopped
    default: .show
    }
  }
}

/// Which pages may talk to the native bridge: the main frame of the
/// gateway's own https origin (BridgeOriginGate on the Mac).
public enum RemoteBridgeOriginGate {
  /// `host` and `port` as WKSecurityOrigin reports them (port 0: the
  /// scheme's default; an IPv6 host with or without brackets).
  public static func accepts(isMainFrame: Bool, scheme: String, host: String, port: Int, endpoint: GatewayEndpoint) -> Bool {
    guard isMainFrame, scheme.lowercased() == "https" else { return false }
    let bare = host.hasPrefix("[") && host.hasSuffix("]") ? String(host.dropFirst().dropLast()) : host
    return GatewayEndpoint.canonicalHost(bare) == endpoint.host && (port == 0 ? 443 : port) == endpoint.port
  }
}

/// A scene's place in the UI, kept across relaunches as its hash route
/// only (UIWindowState on the Mac), so it survives the Mac's address
/// changing.
public enum RemoteWindowRoute {
  /// The hash route of a page on `endpoint`'s origin, still percent-encoded
  /// as hashFor wrote it; nil for other origins or pages other than the UI.
  public static func route(of url: URL?, endpoint: GatewayEndpoint) -> String? {
    guard let url, url.scheme?.lowercased() == "https", endpoint.isSameOrigin(url),
          let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
          components.percentEncodedPath.isEmpty || components.percentEncodedPath == "/",
          let fragment = components.percentEncodedFragment else { return nil }
    return BridgeCommand.validHash(fragment)
  }

  public static func url(hash: String?, endpoint: GatewayEndpoint) -> URL {
    guard let hash = hash.flatMap(BridgeCommand.validHash) else { return endpoint.baseURL }
    // Appended as text: URLComponents.fragment would encode hashFor's "%" again.
    return URL(string: endpoint.baseURL.absoluteString + hash) ?? endpoint.baseURL
  }
}

/// The bridge as the iOS app speaks it: the Mac app's contract
/// (docs/macos.md, docs/terminal-broker.md#bridge) plus the platform.
public enum RemoteClientBridge {
  /// Sent in answer to the page's `ready`: a "hivemind:native" event
  /// `{command: "ready", platform: "ios"}`. A page that does not know it
  /// ignores it (runNativeCommand returns false for unknown commands).
  public static func readyReplyJavaScript(platform: String = RemoteClientPlatform.name) -> String {
    BridgeScript.dispatch(event: bridgeEventName, detail: ["command": "ready", "platform": platform])
  }

  /// A terminal event for the page; terminal-status also carries the platform.
  public static func javaScript(for event: BridgeTerminalEvent, platform: String = RemoteClientPlatform.name) -> String {
    var detail = event.detail
    if case .status = event { detail["platform"] = platform }
    return BridgeScript.dispatch(event: bridgeTerminalEventName, detail: detail)
  }
}

/// How the iOS app handles the page's terminal messages before
/// TerminalBridgeRouter sees them. Terminals run on the Mac's broker; there
/// is no Terminal.app on the device, so a launch opens nothing (the page
/// shows the in-app terminal), and terminal-open is answered with an error.
public enum RemoteTerminalPolicy {
  public enum Decision: Equatable, Sendable {
    /// Hand this (possibly changed) message to the router.
    case forward(BridgeMessage)
    /// Answer the page with this and send nothing to the broker.
    case answer(BridgeTerminalEvent)
  }

  public static let terminalAppMessage = "Terminal.app is on your Mac. Open the session in Hivemind instead."
  public static let noHomeMessage = "This Hivemind Server does not tell the device your Mac's home folder, so a launch without a folder, or with one starting with ~, cannot start. Give the workspace an absolute path (/…), or update Hivemind Server."

  /// `home` is the Mac user's home folder when the gateway sent it
  /// (RemoteDeviceSession.home).
  public static func decide(_ message: BridgeMessage, home: String?) -> Decision {
    switch message {
    case .terminalLaunch(let id, let launches, _):
      if home == nil, launches.contains(where: { launch in launch.cwd.map { $0 == "~" || $0.hasPrefix("~/") } ?? true }) {
        return .answer(.error(id: id, code: .badMessage, message: noHomeMessage, stream: nil))
      }
      return .forward(.terminalLaunch(id: id, launches: launches, openInTerminal: false))
    case .terminalOpen:
      return .answer(.error(id: nil, code: .internal, message: terminalAppMessage, stream: nil))
    default:
      return .forward(message)
    }
  }

  /// The router's stand-in for "~" when the gateway sent no home: never
  /// used, since decide(_:home:) refuses every launch that would need it.
  public static let placeholderHome = "/"
}

/// The app icon's badge across scenes and Macs: scenes of one Mac report
/// the same Human's attention total, so a Mac counts its largest; Macs add up.
public struct RemoteBadgeAggregator: Sendable {
  private var counts: [String: (mac: UUID, count: Int)] = [:]

  public init() {}

  public var count: Int {
    var perMac: [UUID: Int] = [:]
    for entry in counts.values { perMac[entry.mac] = max(perMac[entry.mac] ?? 0, entry.count) }
    return perMac.values.reduce(0, +)
  }

  public mutating func set(_ count: Int, scene: String, mac: UUID) { counts[scene] = (mac, max(0, count)) }

  public mutating func remove(scene: String) { counts[scene] = nil }

  public mutating func remove(mac: UUID) { counts = counts.filter { $0.value.mac != mac } }
}

/// Why a scene cannot show its Mac, as its connection screen says it.
public enum RemoteConnectionProblem: Equatable, Sendable {
  /// No host answered.
  case unreachable(String)
  /// The Mac presents another certificate: pair again.
  case pinMismatch
  /// The Mac no longer knows this device: pair again.
  case revoked
  /// The gateway answered, but Hivemind (the Node server) is not running.
  case serverStopped
  /// Anything else the gateway or the app said.
  case other(String)

  public init(_ error: RemoteClientError) {
    switch error {
    case .unreachable(let reason): self = .unreachable(reason)
    case .pinMismatch: self = .pinMismatch
    case .gateway(let error) where error.code == .unauthorized: self = .revoked
    case .gateway(let error) where error.code == .serverUnavailable: self = .serverStopped
    case .gateway(let error) where error.code == .rateLimited: self = .other("Too many attempts from this device. Wait a minute, then try again.")
    case .gateway, .badResponse, .invalid: self = .other(error.errorDescription ?? "Something went wrong.")
    }
  }
}

/// The words and buttons of the connection screen.
public struct RemoteConnectScreenContent: Equatable, Sendable {
  public let title: String
  public let detail: String
  /// "Pair Again": the pairing is gone on the Mac's side.
  public let offersPairAgain: Bool
  public let offersRetry: Bool

  public init(problem: RemoteConnectionProblem?, macName: String) {
    switch problem {
    case nil:
      title = "Connecting to \(macName)…"
      detail = ""
      offersPairAgain = false
      offersRetry = false
    case .unreachable(let reason):
      title = "Can’t reach \(macName)"
      detail = "Make sure the Mac is awake, Hivemind Server is running with Remote Access on, and this device is on the same network or VPN. (\(reason))"
      offersPairAgain = false
      offersRetry = true
    case .pinMismatch:
      title = "\(macName) has a new identity"
      detail = "The Mac presented a different certificate than the one this device paired with. If you chose Reset Identity… in Hivemind Server on the Mac, pair again. Otherwise, something else may be answering on its address."
      offersPairAgain = true
      offersRetry = true
    case .revoked:
      title = "This device is no longer paired"
      detail = "\(macName) removed this device. Pair it again from Hivemind Server’s menu: Pair a Device…"
      offersPairAgain = true
      offersRetry = false
    case .serverStopped:
      title = "Hivemind isn’t running on \(macName)"
      detail = "Remote Access is on, but the Hivemind server is stopped. Start it from Hivemind Server’s menu on the Mac."
      offersPairAgain = false
      offersRetry = true
    case .other(let message):
      title = "Can’t connect to \(macName)"
      detail = message
      offersPairAgain = false
      offersRetry = true
    }
  }
}
