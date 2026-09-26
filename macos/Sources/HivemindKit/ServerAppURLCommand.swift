import Foundation

/// What Hivemind.app can ask a running Hivemind Server.app to do, as a
/// `hivemind-server://<command>` URL (an Apple Event, so no port, socket or
/// Automation permission). Only exact, known URLs are commands; anything else
/// is ignored. Anyone able to open a URL can send it, so it only ever does
/// what the menu's Start Server does.
public enum ServerAppURLCommand: String, Equatable, Sendable, CaseIterable {
  /// Start the server if it is stopped or failed; a no-op while it runs.
  case start

  public var url: URL { URL(string: "\(BundleID.serverURLScheme)://\(rawValue)")! }

  public init?(url: URL) {
    guard url.scheme?.lowercased() == BundleID.serverURLScheme,
          let host = url.host?.lowercased(), let command = Self(rawValue: host),
          url.user == nil, url.password == nil, url.port == nil,
          url.path.isEmpty || url.path == "/", url.query == nil, url.fragment == nil
    else { return nil }
    self = command
  }

  public init?(string: String) {
    guard let url = URL(string: string) else { return nil }
    self.init(url: url)
  }
}
