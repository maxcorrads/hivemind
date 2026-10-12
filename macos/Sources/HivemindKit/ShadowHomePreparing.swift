import Foundation

// Builds an account's own directory before a session runs under it (a Codex
// shadow, docs/accounts.md), and before its login when the Accounts sheet's
// Prepare asks (account.prepare). FileShadowHomes builds a Codex shadow from
// its shared home; Claude shadows come in phase 4. NoShadowHomes stays for the
// broker's tests and for hosts that build no shadows: it refuses every shadow
// and leaves a primary account alone.

/// What the broker asks before it starts a session under an account, or before Human logs it in.
public protocol ShadowHomePreparing {
  /// Makes the account's directory ready. `home` is the Mac's home, which
  /// expands a leading `~/`. Throws when it cannot: the launch fails and runs nothing.
  func prepare(_ account: LaunchAccount, home: String) throws
  /// The Accounts sheet's Prepare: builds a shadow before its login (creating
  /// its folder, asking no login yet) and says whether the account is logged
  /// in. A primary is only checked. Never throws: what went wrong is the answer's `error`.
  func prepareForLogin(_ account: LaunchAccount, home: String) -> AccountPreparation
}

/// What Prepare found (account.prepared): whether the account is logged in,
/// and why it is not ready, naming the fix. Never a token or a file's contents.
public struct AccountPreparation: Equatable, Sendable {
  /// The layout's login check, on the shadow or, for a primary, on the shared home; nothing is read.
  public let loggedIn: Bool
  /// Nil when the account is ready for its login.
  public let error: String?

  public init(loggedIn: Bool, error: String? = nil) {
    self.loggedIn = loggedIn
    self.error = error
  }

  public var ok: Bool { error == nil }
}

/// Checks a Codex shadow against its shared home and links it (docs/accounts.md,
/// "Codex shadow"). A primary account is left alone. Before a launch it
/// creates nothing itself: the shadow engine makes the links and the home
/// folders, and a missing shadow or login is an error that names its fix.
/// Prepare also creates the shadow's folder, so its login finds the links.
public struct FileShadowHomes: ShadowHomePreparing {
  public init() {}

  static let claudeShadows = "Claude shadow accounts arrive in phase 4"

  public func prepare(_ account: LaunchAccount, home: String) throws {
    guard !account.shadowPath.isEmpty else { return }
    guard account.driver == .codex else {
      throw BrokerProtocolError(.internal, Self.claudeShadows)
    }
    let (shared, shadow) = Self.paths(account, home: home)
    do {
      try Self.checkConfig(home: shared)
      try ShadowHome().materialize(home: shared, shadow: shadow, layout: .codex, createShadow: false, requireLogin: true)
    } catch let error as ShadowHomeError {
      // The message names the fix; the broker reports it as this item's failure.
      throw BrokerProtocolError(.internal, error.message)
    }
  }

  public func prepareForLogin(_ account: LaunchAccount, home: String) -> AccountPreparation {
    guard account.driver == .codex else {
      return AccountPreparation(loggedIn: false,
                                error: account.shadowPath.isEmpty ? "Preparing Claude accounts arrives in phase 4" : Self.claudeShadows)
    }
    let (shared, shadow) = Self.paths(account, home: home)
    // A primary logs in to the shared home itself: nothing to build, only its login to report.
    guard !account.shadowPath.isEmpty else {
      return AccountPreparation(loggedIn: ShadowLayout.codex.isLoggedIn(URL(fileURLWithPath: shared)))
    }
    var error: String?
    do {
      try Self.checkConfig(home: shared)
      try ShadowHome().materialize(home: shared, shadow: shadow, layout: .codex, createShadow: true, requireLogin: false)
    } catch let failure as ShadowHomeError {
      error = failure.message
    } catch let failure {
      error = failure.localizedDescription
    }
    return AccountPreparation(loggedIn: ShadowLayout.codex.isLoggedIn(URL(fileURLWithPath: shadow)), error: error)
  }

  /// The shared home (empty: the driver's default) and the shadow, each with a leading `~/` expanded.
  private static func paths(_ account: LaunchAccount, home: String) -> (shared: String, shadow: String) {
    (expandingHome(account.homePath.isEmpty ? account.driver.defaultHome : account.homePath, home: home),
     expandingHome(account.shadowPath, home: home))
  }

  /// A shared config that keeps the login in the keyring (or picks it automatically) cannot
  /// back a shadow, whose login is its own auth.json. Reads `<home>/config.toml` line by line
  /// up to its first table header and nothing else; a missing file sets nothing.
  private static func checkConfig(home: String) throws {
    let path = home + "/config.toml"
    guard let file = fopen(path, "r") else { return }
    defer { fclose(file) }
    let setting = /^\s*cli_auth_credentials_store\s*=\s*"?(keyring|auto)"?/
    var buffer: UnsafeMutablePointer<CChar>?
    var capacity = 0
    defer { free(buffer) }
    while getline(&buffer, &capacity, file) > 0, let buffer {
      let line = String(cString: buffer)
      if line.drop(while: \.isWhitespace).first == "[" { return }
      if let match = line.firstMatch(of: setting) {
        throw ShadowHomeError(path: path,
                              message: "`\(path)` sets cli_auth_credentials_store = `\(match.1)`; shadow accounts need `file` (or no setting).")
      }
    }
  }
}

/// `path` with a leading `~/` replaced by `home`, compared by scalar as LaunchAccount does.
private func expandingHome(_ path: String, home: String) -> String {
  guard path.unicodeScalars.starts(with: "~/".unicodeScalars) else { return path }
  return (home.hasSuffix("/") ? String(home.dropLast()) : home) + String(path.unicodeScalars.dropFirst())
}

/// Refuses a shadow account and does nothing for a primary one.
public struct NoShadowHomes: ShadowHomePreparing {
  public init() {}

  public func prepare(_ account: LaunchAccount, home: String) throws {
    guard account.shadowPath.isEmpty else {
      throw BrokerProtocolError(.internal, "Shadow accounts are not supported yet")
    }
  }

  public func prepareForLogin(_ account: LaunchAccount, home: String) -> AccountPreparation {
    AccountPreparation(loggedIn: false, error: "this broker cannot prepare accounts")
  }
}
