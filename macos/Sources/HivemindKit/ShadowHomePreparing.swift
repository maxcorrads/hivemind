import Foundation

// Builds an account's own directory before a session runs under it (a Codex
// shadow, docs/accounts.md). FileShadowHomes builds a Codex shadow from its
// shared home; Claude shadows come in phase 4. NoShadowHomes stays for the
// broker's tests and for hosts that build no shadows: it refuses every shadow
// and leaves a primary account alone.

/// What the broker asks before it starts a session under an account.
public protocol ShadowHomePreparing {
  /// Makes the account's directory ready. `home` is the Mac's home, which
  /// expands a leading `~/`. Throws when it cannot: the launch fails and runs nothing.
  func prepare(_ account: LaunchAccount, home: String) throws
}

/// Checks a Codex shadow against its shared home and links it (docs/accounts.md,
/// "Codex shadow"). A primary account is left alone. It creates nothing itself:
/// the shadow engine makes the links and the home folders, and a missing
/// shadow or login is an error that names its fix.
public struct FileShadowHomes: ShadowHomePreparing {
  public init() {}

  public func prepare(_ account: LaunchAccount, home: String) throws {
    guard !account.shadowPath.isEmpty else { return }
    guard account.driver == .codex else {
      throw BrokerProtocolError(.internal, "Claude shadow accounts arrive in phase 4")
    }
    let shared = expandingHome(account.homePath.isEmpty ? account.driver.defaultHome : account.homePath, home: home)
    let shadow = expandingHome(account.shadowPath, home: home)
    do {
      try Self.checkConfig(home: shared)
      try ShadowHome().materialize(home: shared, shadow: shadow, layout: .codex, createShadow: false, requireLogin: true)
    } catch let error as ShadowHomeError {
      // The message names the fix; the broker reports it as this item's failure.
      throw BrokerProtocolError(.internal, error.message)
    }
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
}
