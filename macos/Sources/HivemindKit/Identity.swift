import Foundation

/// Bundle identifiers the two apps use to find and launch each other.
public enum BundleID {
  public static let ui = "com.maxcorrads.hivemind"
  public static let server = "com.maxcorrads.hivemind.server"
  /// The server app's URL scheme (CFBundleURLTypes, written by build.sh).
  public static let serverURLScheme = "hivemind-server"
}

/// Keys both apps read from their own UserDefaults. The server app owns
/// `port` and `dataHome`; the UI app keeps its own `port` as the fallback when
/// no discovery file exists.
public enum SettingsKey {
  public static let port = "port"
  public static let dataHome = "dataHome"
}

/// Where the docs live; Help opens it in the default browser.
public let documentationURL = URL(string: "https://github.com/maxcorrads/hivemind#readme")!
