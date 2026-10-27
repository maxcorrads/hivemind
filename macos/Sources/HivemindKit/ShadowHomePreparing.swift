import Foundation

// Builds an account's own directory before a session runs under it (a Codex or
// Claude shadow, docs/accounts.md), and before its login when the Accounts
// sheet's Prepare asks (account.prepare). FileShadowHomes builds a shadow from
// its shared home. NoShadowHomes stays for the broker's tests and for hosts
// that build no shadows: it refuses every shadow and leaves a primary account
// alone.

/// What the broker asks before it starts a session under an account, or before Human logs it in.
public protocol ShadowHomePreparing {
  /// Makes the account's directory ready. `home` is the Mac's home, which
  /// expands a leading `~/`. Throws when it cannot: the launch fails and runs nothing.
  func prepare(_ account: LaunchAccount, home: String) throws
  /// The Accounts sheet's Prepare: builds a shadow before its login (creating
  /// its folder, asking no login yet) and says whether the account is logged
  /// in. A primary is only checked. Never throws: what went wrong is the answer's `error`.
  func prepareForLogin(_ account: LaunchAccount, home: String) -> AccountPreparation
  /// `prepare` on a remote host's files (docs/remote-hosts.md#launch): `home` is the host's, and `files` its snapshot,
  /// whose recorded writes the launch then applies there.
  func prepare(_ account: LaunchAccount, home: String, files: any ShadowFiles) throws
}

extension ShadowHomePreparing {
  /// A broker that builds no shadow on a host leaves a primary account alone there and refuses a shadow.
  public func prepare(_ account: LaunchAccount, home: String, files: any ShadowFiles) throws {
    guard account.shadowPath.isEmpty else {
      throw BrokerProtocolError(.internal, "This broker cannot prepare shadow accounts on a host")
    }
  }
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

/// Checks a Codex or Claude shadow against its shared home and links it
/// (docs/accounts.md, "Codex shadow" and "Claude shadow"). A primary account is
/// left alone. Before a launch it creates nothing itself: the shadow engine
/// makes the links and the home folders, and a missing shadow or login is an
/// error that names its fix. Prepare also creates the shadow's folder, so its
/// login finds the links.
public struct FileShadowHomes: ShadowHomePreparing {
  public init() {}

  public func prepare(_ account: LaunchAccount, home: String) throws {
    try prepare(account, home: home, files: LocalShadowFiles())
  }

  public func prepare(_ account: LaunchAccount, home: String, files: any ShadowFiles) throws {
    guard !account.shadowPath.isEmpty else { return }
    let (shared, shadow) = Self.paths(account, home: home)
    do {
      try Self.checkShadow(account.driver, shared: shared, shadow: shadow, files: files)
      try ShadowHome().materialize(home: shared, shadow: shadow, layout: Self.layout(account.driver),
                                   createShadow: false, requireLogin: true, files: files)
    } catch let error as ShadowHomeError {
      // The message names the fix; the broker reports it as this item's failure.
      throw BrokerProtocolError(.internal, error.message)
    }
  }

  public func prepareForLogin(_ account: LaunchAccount, home: String) -> AccountPreparation {
    let layout = Self.layout(account.driver)
    let (shared, shadow) = Self.paths(account, home: home)
    // A primary logs in to the shared home itself: nothing to build, only its login to report.
    guard !account.shadowPath.isEmpty else {
      var loggedIn = layout.isLoggedIn(URL(fileURLWithPath: shared))
      // Without CLAUDE_CONFIG_DIR, Claude keeps `.claude.json` in the Mac home, next to `~/.claude`, not inside it.
      if !loggedIn, account.driver == .claude, account.homePath.isEmpty {
        loggedIn = ShadowLayout.hasClaudeLogin(configFile: URL(fileURLWithPath: expandingHome("~/.claude.json", home: home)))
      }
      return AccountPreparation(loggedIn: loggedIn)
    }
    var error: String?
    do {
      try Self.checkShadow(account.driver, shared: shared, shadow: shadow, files: LocalShadowFiles(), seedRetention: true)
      try ShadowHome().materialize(home: shared, shadow: shadow, layout: layout, createShadow: true, requireLogin: false)
    } catch let failure as ShadowHomeError {
      error = failure.message
    } catch let failure {
      error = failure.localizedDescription
    }
    return AccountPreparation(loggedIn: layout.isLoggedIn(URL(fileURLWithPath: shadow)), error: error)
  }

  private static func layout(_ driver: LaunchAccount.Driver) -> ShadowLayout {
    switch driver {
    case .codex: .codex
    case .claude: .claude
    }
  }

  /// The checks that run before `materialize`, for each driver's shadow. Prepare (`seedRetention`) first gives a new
  /// Claude shadow the home's `cleanupPeriodDays`, so its first check can pass.
  private static func checkShadow(_ driver: LaunchAccount.Driver, shared: String, shadow: String, files: any ShadowFiles,
                                  seedRetention: Bool = false) throws {
    switch driver {
    case .codex:
      try checkConfig(home: shared, files: files)
    case .claude:
      try checkExactPath(shadow, files: files)
      if seedRetention { try Self.seedRetention(home: shared, shadow: shadow) }
      try checkRetention(home: shared, shadow: shadow, files: files)
    }
  }

  /// When the shadow has no `settings.json` and the home's sets `cleanupPeriodDays`, writes a `settings.json` (0600)
  /// holding only that key, creating the shadow folder (0700) if needed. Reads nothing else of the home's file.
  private static func seedRetention(home: String, shadow: String) throws {
    let target = shadow + "/settings.json"
    guard !FileManager.default.fileExists(atPath: target),
          let data = FileManager.default.contents(atPath: home + "/settings.json"),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let days = json["cleanupPeriodDays"], !(days is NSNull) else { return }
    if mkdir(shadow, 0o700) != 0 && errno != EEXIST {
      throw ShadowHomeError(path: shadow, message: "Cannot create `\(shadow)`: \(String(cString: strerror(errno)))")
    }
    let body = try JSONSerialization.data(withJSONObject: ["cleanupPeriodDays": days], options: [.prettyPrinted, .sortedKeys])
    guard FileManager.default.createFile(atPath: target, contents: body + Data("\n".utf8), attributes: [.posixPermissions: 0o600]) else {
      throw ShadowHomeError(path: target, message: "Cannot write `\(target)`.")
    }
  }

  /// Claude keys its keychain login to the exact `CLAUDE_CONFIG_DIR` string, so the shadow must be
  /// written as its real path: no trailing `/`, and no symlink in it.
  private static func checkExactPath(_ shadow: String, files: any ShadowFiles) throws {
    let real = files.resolved(shadow)
    guard !shadow.hasSuffix("/"), shadow == real else {
      throw ShadowHomeError(path: shadow, message: "Use the real path of `\(real)`: Claude keys its login to the exact folder name.")
    }
  }

  /// A shadow and its home share one `projects/`, and each account's `cleanupPeriodDays` deletes
  /// transcripts from it, so both must set the same value. Reads only that top-level key of each `settings.json`.
  private static func checkRetention(home: String, shadow: String, files: any ShadowFiles) throws {
    let shadowDays = try files.cleanupPeriodDays(in: shadow + "/settings.json")
    let homeDays = try files.cleanupPeriodDays(in: home + "/settings.json")
    guard shadowDays == homeDays else {
      throw ShadowHomeError(path: shadow + "/settings.json",
                            message: "`\(shadow)/settings.json` has cleanupPeriodDays `\(shadowDays)` but `\(home)/settings.json` has `\(homeDays)`. "
                              + "Set the same value: each account cleans the shared transcripts with its own value.")
    }
  }

  /// The shared home (empty: the driver's default) and the shadow, each with a leading `~/` expanded.
  private static func paths(_ account: LaunchAccount, home: String) -> (shared: String, shadow: String) {
    (expandingHome(account.homePath.isEmpty ? account.driver.defaultHome : account.homePath, home: home),
     expandingHome(account.shadowPath, home: home))
  }

  /// A shared config that keeps the login in the keyring, picks it automatically or keeps it
  /// in memory only cannot back a shadow, whose login is its own auth.json. Reads `<home>/config.toml` line by line
  /// up to its first table header and nothing else; a missing file sets nothing.
  private static func checkConfig(home: String, files: any ShadowFiles) throws {
    if let store = files.credentialStore(home: home) {
      let path = home + "/config.toml"
      throw ShadowHomeError(path: path, message: "`\(path)` sets cli_auth_credentials_store = `\(store)`; shadow accounts need `file` (or no setting).")
    }
  }
}

/// `path` with a leading `~/` replaced by `home`, compared by scalar as LaunchAccount does.
func expandingHome(_ path: String, home: String) -> String {
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
