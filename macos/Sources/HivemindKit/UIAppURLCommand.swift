import Foundation

/// The only URL Server.app asks Hivemind.app to open when an approval
/// notification is clicked. The app never treats arbitrary URL text as a
/// browser destination.
public enum UIAppURLCommand: Equatable, Sendable {
  case inbox

  public static let inboxURL = URL(string: "hivemind://inbox")!

  public init?(_ string: String) {
    guard let url = URL(string: string), url.scheme == BundleID.uiURLScheme,
          url.host == "inbox", url.path.isEmpty, url.query == nil,
          url.fragment == nil, url.user == nil, url.password == nil else { return nil }
    self = .inbox
  }

  public var route: String { "#/inbox" }
}
