import Foundation

public enum NavigationDecision: Equatable, Sendable {
  case allow
  /// Hand to the default browser (NSWorkspace.open) and cancel in the web view.
  case openExternally
  case deny
}

/// Keeps every WKWebView pinned to the local server's origin: the Human
/// session cookie must never travel with, or be replaced by, another page.
public enum NavigationPolicy {
  static let externalSchemes: Set<String> = ["http", "https", "mailto"]

  public static func decide(_ url: URL, endpoint: ServerEndpoint) -> NavigationDecision {
    if endpoint.isSameOrigin(url) { return .allow }
    let scheme = url.scheme?.lowercased() ?? ""
    // about:blank and about:srcdoc are how iframes and window.open start.
    if scheme == "about" { return url.absoluteString == "about:blank" || url.absoluteString == "about:srcdoc" ? .allow : .deny }
    // blob: URLs the page itself created (downloads, previews) carry its origin.
    if scheme == "blob", let inner = URL(string: String(url.absoluteString.dropFirst("blob:".count))) {
      return endpoint.isSameOrigin(inner) ? .allow : .deny
    }
    if externalSchemes.contains(scheme), !(url.user != nil || url.password != nil) { return .openExternally }
    return .deny
  }
}
