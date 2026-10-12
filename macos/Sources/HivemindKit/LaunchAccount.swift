import Foundation

// A named Codex or Claude account a launch runs under (docs/accounts.md;
// web: src/shared/accounts.ts, which checks the same path rules and builds
// the same variables; src/shared/account-paths.vectors.json keeps the two in
// step). The Node server resolves the account from its catalog; the broker
// only receives the result and never reads the catalog. HiveMind keeps paths
// only: the login itself stays in the account's directory or the Keychain.

/// The account a launch resolved to. `homePath` is the shared tree ("" =
/// the CLI's default, `~/.codex` / `~/.claude`); `shadowPath` is this
/// account's own directory ("" = a primary account).
public struct LaunchAccount: Codable, Equatable, Sendable {
  public enum Driver: String, Codable, Sendable, CaseIterable {
    case codex, claude

    /// The variable that points the CLI at the account's directory.
    public var variable: String {
      switch self {
      case .codex: "CODEX_HOME"
      case .claude: "CLAUDE_CONFIG_DIR"
      }
    }

    /// Every variable that decides which login the CLI uses. The broker sets
    /// the account's own and unsets the rest: a login shell's `.zshrc` could
    /// export them, and a token variable outranks the directory's login.
    public var controlledNames: [String] {
      switch self {
      case .codex: ["CODEX_HOME", "CODEX_SQLITE_HOME", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"]
      case .claude: ["CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_SECURESTORAGE_CONFIG_DIR"]
      }
    }

    /// The shared tree when `homePath` is empty.
    public var defaultHome: String {
      switch self {
      case .codex: "~/.codex"
      case .claude: "~/.claude"
      }
    }
  }

  /// UTF-16 code units, as the page counts them.
  public static let maxLabelLength = 80
  /// UTF-8 bytes of one path (macOS PATH_MAX).
  public static let maxPathBytes = 1024
  /// UTF-8 bytes of an id.
  public static let maxIDBytes = 64

  public let id: String
  public let driver: Driver
  public let label: String
  public let homePath: String
  public let shadowPath: String

  public init(id: String, driver: Driver, label: String, homePath: String, shadowPath: String) {
    self.id = id
    self.driver = driver
    self.label = label
    self.homePath = homePath
    self.shadowPath = shadowPath
  }

  /// Why `path` cannot be a home or shadow path, or nil; the page's
  /// accountPathProblem, message for message. "" is the default. Otherwise
  /// absolute or `~/…`, at most 1024 bytes, no control characters, no
  /// trailing `/`, no `//` and no `.` or `..` segment: Claude keys its
  /// keychain login to the exact string, so it is exported as written.
  /// Compared byte by byte, so a combining mark never hides a `/`.
  public static func pathProblem(_ path: String) -> String? {
    let bytes = Array(path.utf8)
    guard !bytes.isEmpty else { return nil }
    let slash = UInt8(ascii: "/"), dot = UInt8(ascii: ".")
    guard bytes[0] == slash || (bytes.count >= 2 && bytes[0] == UInt8(ascii: "~") && bytes[1] == slash) else {
      return "a path starts with / or ~/"
    }
    guard bytes.count <= maxPathBytes else { return "a path is at most \(maxPathBytes) bytes" }
    guard !path.unicodeScalars.contains(where: { $0.value < 0x20 || (0x7F...0x9F).contains($0.value) }) else {
      return "a path cannot hold control characters"
    }
    guard bytes.last != slash else { return "a path cannot end with /" }
    guard !zip(bytes, bytes.dropFirst()).contains(where: { $0 == slash && $1 == slash }) else { return "a path cannot hold //" }
    let segments = bytes.split(separator: slash, omittingEmptySubsequences: false)
    guard !segments.contains(where: { $0.elementsEqual([dot]) || $0.elementsEqual([dot, dot]) }) else {
      return "a path cannot hold a . or .. segment"
    }
    return nil
  }

  /// Throws bad-message naming the field when the id, the label or a path
  /// breaks the page's rules, or when the shadow is the shared tree itself
  /// (compared canonically, as Swift compares strings: the page compares
  /// NFC forms, APFS ignores normalization and Claude hashes the NFC form).
  public func validate() throws(BrokerProtocolError) {
    try validate(field: "account")
  }

  /// validate(), naming the field as a launch carries it (`launches[0].account`).
  func validate(field: String) throws(BrokerProtocolError) {
    guard (1...Self.maxIDBytes).contains(id.utf8.count) else { throw .invalid("\(field).id", "must be 1–\(Self.maxIDBytes) bytes") }
    guard !label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, label.utf16.count <= Self.maxLabelLength else {
      throw .invalid("\(field).label", "must be 1–\(Self.maxLabelLength) characters")
    }
    if let problem = Self.pathProblem(homePath) { throw .invalid("\(field).homePath", problem) }
    if let problem = Self.pathProblem(shadowPath) { throw .invalid("\(field).shadowPath", problem) }
    if !shadowPath.isEmpty, shadowPath == (homePath.isEmpty ? driver.defaultHome : homePath) {
      throw .invalid("\(field).shadowPath", "a shadow is its own directory, not the shared tree")
    }
  }

  /// The driver's controlled variables, for the launch script's `unset`.
  public var controlledNames: [String] { driver.controlledNames }

  /// Why a launch's variables or secret names cannot go with this account,
  /// or nil: any of the controlled names, compared without case, even for an
  /// account that sets no variable (nil = a launch with no variables). Names
  /// the variable as it was written, never a value; the page's
  /// accountEnvironmentConflict, message for message. The variables come in
  /// name order, the page's in insertion order: with two conflicts the two
  /// sides may name different ones (src/shared/account-environment.vectors.json).
  public func environmentConflict(in environment: LaunchEnvironment?, secretNames: [String]) -> String? {
    let controlled = Set(controlledNames)
    let names = (environment?.names ?? []) + secretNames
    guard let name = names.first(where: { controlled.contains($0.uppercased()) }) else { return nil }
    return "\(name) is managed by the account \(label); remove it."
  }

  /// The variables for the launch file, with a leading `~/` expanded with
  /// `home`; the page's accountEnvironment, pair for pair:
  /// - Codex shadow: `CODEX_HOME=<shadowPath>`, `CODEX_SQLITE_HOME=<homePath or ~/.codex>`;
  /// - Codex primary: `CODEX_HOME=<homePath>` when set;
  /// - Claude: `CLAUDE_CONFIG_DIR=<shadowPath or homePath>` when one is set.
  ///
  /// A primary with an empty `homePath` sets nothing, since an explicit
  /// `CLAUDE_CONFIG_DIR=~/.claude` is another login than the default.
  public func environment(home: String) -> [(name: String, value: String)] {
    // By scalar, as pathProblem checks it: "~/" then a combining mark is still "~/".
    func expanded(_ path: String) -> String {
      guard path.unicodeScalars.starts(with: "~/".unicodeScalars) else { return path }
      return (home.hasSuffix("/") ? String(home.dropLast()) : home) + String(path.unicodeScalars.dropFirst())
    }
    switch driver {
    case .codex:
      if !shadowPath.isEmpty {
        return [(driver.variable, expanded(shadowPath)), ("CODEX_SQLITE_HOME", expanded(homePath.isEmpty ? driver.defaultHome : homePath))]
      }
      return homePath.isEmpty ? [] : [(driver.variable, expanded(homePath))]
    case .claude:
      let directory = shadowPath.isEmpty ? homePath : shadowPath
      return directory.isEmpty ? [] : [(driver.variable, expanded(directory))]
    }
  }

  /// Whether a variable needs the Mac's home: a path written `~/…`, or a
  /// Codex shadow's default shared tree. With "~" standing in for the home,
  /// what the broker would expand still starts with `~/`.
  public var usesHome: Bool {
    environment(home: "~").contains { $0.value.unicodeScalars.starts(with: "~/".unicodeScalars) }
  }
}
