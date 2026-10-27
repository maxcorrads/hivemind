import Foundation

// The shadow home engine (docs/accounts.md, "Codex shadow"). A shadow is a
// second account's own folder: it links the names it shares from one home
// (sessions, history, config, writer locks) and keeps its login (auth.json) to
// itself. Codex's SQLite databases stay in the home (CODEX_SQLITE_HOME), so
// they are never linked or copied. The lists in `ShadowLayout.codex` come from
// spike 0.3 and `ShadowLayout.claude` from spike 0.2 (issue #320). Nothing here
// deletes, moves or chmods an existing entry, and nothing reads a login.

/// What to do with a name that is present in both trees and that no list or pattern covers.
public enum UnknownNameRule: Sendable { case conflict, keepPrivate }

/// Which names a shadow shares, keeps private, refuses or ignores, and the
/// tool-specific commands around the login. Paths are absolute: the caller
/// expands a leading `~/`.
public struct ShadowLayout: Sendable {
  public let shared: [String]            // top-level names linked from the home
  public let sharedPatterns: [String]    // regexes on names, also linked
  public let privateNames: [String]      // real files each account keeps
  public let homeOnlyPatterns: [String]  // must never exist in the shadow (a real one is a conflict); never linked
  public let ignoredPatterns: [String]   // never linked, never a conflict
  public let ensureInHome: [String]      // directories created (0700) in the home if missing, before linking
  public let unknownNames: UnknownNameRule
  public let isLoggedIn: @Sendable (URL) -> Bool          // given the shadow; never reads a secret
  public let loginCommand: @Sendable (_ shadow: String, _ home: String) -> String

  public init(shared: [String], sharedPatterns: [String], privateNames: [String], homeOnlyPatterns: [String],
              ignoredPatterns: [String], ensureInHome: [String], unknownNames: UnknownNameRule,
              isLoggedIn: @escaping @Sendable (URL) -> Bool,
              loginCommand: @escaping @Sendable (_ shadow: String, _ home: String) -> String) {
    self.shared = shared
    self.sharedPatterns = sharedPatterns
    self.privateNames = privateNames
    self.homeOnlyPatterns = homeOnlyPatterns
    self.ignoredPatterns = ignoredPatterns
    self.ensureInHome = ensureInHome
    self.unknownNames = unknownNames
    self.isLoggedIn = isLoggedIn
    self.loginCommand = loginCommand
  }
}

extension ShadowLayout {
  /// Codex (docs/accounts.md, "Codex shadow"). The login is the shadow's own
  /// `auth.json`; the shared config must not move it to the keyring.
  public static let codex = ShadowLayout(
    shared: [
      "sessions", "archived_sessions", "session_index.jsonl", "history.jsonl", "thread-writer-locks", "rollout-migrations",
      "external_agent_session_imports.json", "attachments", "generated_images", "visualizations",
      "tui-thread-reference-capabilities",
      "config.toml", "AGENTS.md", "AGENTS.override.md", "hooks.json", "prompts", "skills", "rules", "memories", "plugins", "pets",
      ".sandbox_migration", ".personality_migration", "mcp-oauth-locks", ".credentials.json",
    ],
    sharedPatterns: [#"^[A-Za-z0-9_-]+\.config\.toml$"#],
    privateNames: [
      "auth.json", "installation_id", "models_cache.json", "version.json", "cache", ".tmp", "tmp", "shell_snapshots", "log",
      "app-server-control", "app-server-daemon", "packages", "ipc", "process_manager",
    ],
    homeOnlyPatterns: [#"^[a-z][a-z0-9_]*_[0-9]+\.sqlite(-wal|-shm|-journal)?$"#, #"^\.sqlite-maintenance\.lock$"#, #"^db-backups$"#],
    ignoredPatterns: [#"\.tmp$"#, #"\.tmp-"#, #"^\.tmp"#, #"\.bak"#, #"^\.DS_Store$"#],
    ensureInHome: ["sessions", "thread-writer-locks"],
    unknownNames: .conflict,
    isLoggedIn: { shadow in
      // lstat only: a symlinked or missing auth.json is not a login, and nothing is read.
      var info = stat()
      return lstat(shadow.appendingPathComponent("auth.json").path, &info) == 0 && (info.st_mode & S_IFMT) == S_IFREG
    },
    loginCommand: { shadow, home in
      "mkdir -p \(shellWord(shadow)) && CODEX_HOME=\(shellWord(shadow)) CODEX_SQLITE_HOME=\(shellWord(home)) codex -c cli_auth_credentials_store=file login"
    }
  )
}

extension ShadowLayout {
  /// Claude (docs/accounts.md, "Claude shadow"). The login is the shadow's own
  /// `.credentials.json`, or the `oauthAccount` key of its `.claude.json`; the
  /// transcripts (`projects`) are shared, so `claude --resume` finds them from
  /// either account. The lists come from spike 0.2 (issue #320).
  public static let claude = ShadowLayout(
    shared: ["projects", "history.jsonl", "file-history", "paste-cache", "plans", "tasks"],
    sharedPatterns: [],
    privateNames: [
      ".claude.json", ".claude.json.lock", ".config.json", ".credentials.json", "backups", "settings.json", "settings.local.json",
      "settings.json.bak",
      "sessions", "session-env", "shell-snapshots", "daemon", "daemon.log", "daemon-auth-status.json", "daemon-auth-cooldown",
      "jobs", "debug", "state", "ide",
      "policy-limits.json", "policy-limits.json.stamp.json", "remote-settings.json", "mcp-needs-auth-cache.json", "plugins", "skills",
      "chrome", "telemetry", "feedback", "feedback-bundles", "statusline-command.sh",
      "cache", "stats-cache.json", "gh-pr-status-cache.json", ".last-cleanup", ".last-update-result.json", "usage-data", "downloads",
    ],
    homeOnlyPatterns: [],
    ignoredPatterns: [#"^\.DS_Store$"#],
    ensureInHome: ["projects", "file-history", "paste-cache", "plans", "tasks"],
    unknownNames: .keepPrivate,
    isLoggedIn: { shadow in
      // lstat only, as for Codex: a symlinked file is not this shadow's login. Of `.claude.json` only the
      // top-level `oauthAccount` key is looked at, never its value.
      func regularFile(_ name: String) -> Bool {
        var info = stat()
        return lstat(shadow.appendingPathComponent(name).path, &info) == 0 && (info.st_mode & S_IFMT) == S_IFREG
      }
      if regularFile(".credentials.json") { return true }
      return ShadowLayout.hasClaudeLogin(configFile: shadow.appendingPathComponent(".claude.json"))
    },
    loginCommand: { shadow, _ in
      "mkdir -p \(shellWord(shadow)) && CLAUDE_CONFIG_DIR=\(shellWord(shadow)) claude auth login"
    }
  )
}

/// Why a shadow is wrong: `path` is the entry at fault, `message` names the fix.
public struct ShadowHomeError: Error, Equatable {
  public let path: String
  public let message: String

  public init(path: String, message: String) {
    self.path = path
    self.message = message
  }
}

/// Makes a shadow ready for a CLI to run from a shared home.
public struct ShadowHome {
  public init() {}

  /// Checks and links in a fixed order: the home, the shadow, the home's
  /// folders, the links, then the conflicts and the login. Only the shadow's
  /// links, the shadow folder (when `createShadow`) and the `ensureInHome`
  /// folders are ever written; a second run on a good shadow changes nothing.
  /// `files` is this Mac's, or a remote host's snapshot (SnapshotShadowFiles).
  public func materialize(home: String, shadow: String, layout: ShadowLayout,
                          createShadow: Bool, requireLogin: Bool, files: any ShadowFiles = LocalShadowFiles()) throws {
    let sharedPatterns = try Self.compile(layout.sharedPatterns)
    let homeOnlyPatterns = try Self.compile(layout.homeOnlyPatterns)
    let ignoredPatterns = try Self.compile(layout.ignoredPatterns)

    // 1. The home is an existing folder, not a symlink.
    guard try files.kind(of: home) == S_IFDIR else {
      throw ShadowHomeError(path: home, message: "`\(home)` must be an existing folder, not a symlink.")
    }

    // 2. The shadow is a folder of its own, never the home. A login into a
    // missing one would create real files where the links belong, so the
    // refusal sends Human to Prepare first.
    let shadowKind = try files.kind(of: shadow)
    if shadowKind == nil {
      guard createShadow else {
        throw ShadowHomeError(path: shadow, message: "`\(shadow)` does not exist yet. Prepare the account in the Accounts sheet, "
                                + "then log in with `\(layout.loginCommand(shadow, home))`.")
      }
      try files.makeFolder(shadow)
    } else if shadowKind != S_IFDIR {
      throw ShadowHomeError(path: shadow, message: "`\(shadow)` must be a folder, not a symlink or a file.")
    }
    guard files.canonical(shadow) != files.canonical(home) else {
      throw ShadowHomeError(path: shadow, message: "`\(shadow)` is the shared home itself; a shadow needs a folder of its own.")
    }

    // 3. The folders the CLI needs in the home exist before anything links to them.
    for name in layout.ensureInHome {
      let path = Self.join(home, name)
      if try files.kind(of: path) == nil { try files.makeFolder(path) }
    }

    // 4. Each shared name in the home is linked from the shadow; a correct link is kept.
    let homeNames = try files.names(in: home)
    for name in homeNames where layout.shared.contains(name) || Self.matches(name, sharedPatterns) {
      let link = Self.join(shadow, name)
      let target = Self.join(home, name)
      let kind = try files.kind(of: link)
      if kind == nil {
        try files.link(link, to: target)
      } else if kind != S_IFLNK || files.destination(of: link) != target {
        throw ShadowHomeError(path: link, message: "`\(link)` is a real file; HiveMind shares it from `\(home)`. Move it away, then launch again.")
      }
    }

    // 5. Codex's databases never live in the shadow.
    let shadowNames = try files.names(in: shadow)
    if let name = shadowNames.first(where: { Self.matches($0, homeOnlyPatterns) }) {
      let path = Self.join(shadow, name)
      throw ShadowHomeError(path: path,
                            message: "`\(path)` should not be here: Codex keeps its databases in `\(home)` (CODEX_SQLITE_HOME). Move it away.")
    }

    // 6. A name present in both trees that no list or pattern covers is a conflict, unless ignored.
    if layout.unknownNames == .conflict {
      let unknown = shadowNames.first { name in
        homeNames.contains(name) && !layout.shared.contains(name) && !layout.privateNames.contains(name)
          && !Self.matches(name, sharedPatterns) && !Self.matches(name, homeOnlyPatterns) && !Self.matches(name, ignoredPatterns)
      }
      if let name = unknown {
        throw ShadowHomeError(path: Self.join(shadow, name),
                              message: "Unknown Codex file `\(name)` in both homes; HiveMind's shadow layout needs an update.")
      }
    }

    // 7. A login is required only when asked for, and only checked, never read.
    if requireLogin, !files.isLoggedIn(layout, shadow: shadow) {
      throw ShadowHomeError(path: shadow, message: "`\(shadow)` has no login yet. Run `\(layout.loginCommand(shadow, home))` to log in.")
    }
  }

  /// Whether `name` matches any pattern anywhere in it, as a search, not a whole match.
  private static func matches(_ name: String, _ patterns: [Regex<AnyRegexOutput>]) -> Bool {
    patterns.contains { name.contains($0) }
  }

  private static func compile(_ patterns: [String]) throws -> [Regex<AnyRegexOutput>] {
    try patterns.map { try Regex($0) }
  }

  private static func join(_ folder: String, _ name: String) -> String {
    folder.hasSuffix("/") ? folder + name : folder + "/" + name
  }
}

/// A path as the shell reads it: as written when it has no special characters, else single-quoted.
/// The same plain characters as the page's `shellPath` (src/shared/accounts.ts), so both show one command.
private func shellWord(_ path: String) -> String {
  let plain = Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_./+@,:-")
  guard !path.allSatisfy({ plain.contains($0) }) else { return path }
  return "'" + path.replacingOccurrences(of: "'", with: "'\\''") + "'"
}

extension ShadowLayout {
  /// Whether a Claude `.claude.json` holds a login: a regular file (lstat) whose top-level `oauthAccount` key is
  /// present. Only the key is looked at, never its value.
  static func hasClaudeLogin(configFile: URL) -> Bool {
    var info = stat()
    guard lstat(configFile.path, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG,
          let data = FileManager.default.contents(atPath: configFile.path),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
    return json["oauthAccount"] != nil
  }
}
