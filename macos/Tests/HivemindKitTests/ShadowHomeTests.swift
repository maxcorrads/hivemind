import Foundation
import Testing
@testable import HivemindKit

// The shadow home engine (docs/accounts.md, "Codex shadow") over fake trees under the temp dir only.
// A login is only ever checked for existence: its bytes and mtime must not change.

/// A fake home and shadow under a fresh temp folder. Nothing exists yet; each test makes what it needs.
private struct Trees {
  let root: URL
  let home: String
  let shadow: String

  func inHome(_ name: String) -> String { home + "/" + name }
  func inShadow(_ name: String) -> String { shadow + "/" + name }
  func outside(_ name: String) -> String { root.appendingPathComponent(name).path }

  /// A regular file with `text`; its folders are created as needed.
  func file(_ path: String, _ text: String = "") throws {
    try FileManager.default.createDirectory(atPath: URL(fileURLWithPath: path).deletingLastPathComponent().path,
                                            withIntermediateDirectories: true)
    try Data(text.utf8).write(to: URL(fileURLWithPath: path))
  }

  func folder(_ path: String) throws {
    try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
  }

  func link(_ path: String, to target: String) throws {
    try FileManager.default.createSymbolicLink(atPath: path, withDestinationPath: target)
  }

  /// Entries by name, links included (a dangling one too).
  func names(_ folder: String) throws -> [String] {
    try FileManager.default.contentsOfDirectory(atPath: folder).sorted()
  }

  /// The target of the link at `path`, or nil when it is not a link.
  func destination(_ path: String) -> String? {
    try? FileManager.default.destinationOfSymbolicLink(atPath: path)
  }

  func materialize(createShadow: Bool = false, requireLogin: Bool = false) throws {
    try ShadowHome().materialize(home: home, shadow: shadow, layout: .codex, createShadow: createShadow, requireLogin: requireLogin)
  }
}

/// Runs `body` over fresh trees; the temp folder is removed afterwards.
private func withTrees(_ body: (Trees) throws -> Void) throws {
  let root = try temporaryHome()
  defer { try? FileManager.default.removeItem(at: root) }
  try body(Trees(root: root, home: root.appendingPathComponent("codex").path, shadow: root.appendingPathComponent("work").path))
}

private func permissions(_ path: String) throws -> Int? {
  try FileManager.default.attributesOfItem(atPath: path)[.posixPermissions] as? Int
}

private func modified(_ path: String) throws -> Date? {
  try FileManager.default.attributesOfItem(atPath: path)[.modificationDate] as? Date
}

/// The home, the shadow and every entry of both with its link target ("" for a non-link) and its own modification
/// date (a link's, not its target's), for comparing two runs: a link removed and made again shows too.
private func snapshot(_ trees: Trees) throws -> [String] {
  try [trees.home, trees.shadow].flatMap { folder in
    try ["\(folder) @ \(modified(folder)?.timeIntervalSince1970 ?? 0)"] + trees.names(folder).map { name in
      let path = folder + "/" + name
      return "\(path) -> \(trees.destination(path) ?? "") @ \(try modified(path)?.timeIntervalSince1970 ?? 0)"
    }
  }
}

struct ShadowHomeTests {
  @Test func freshShadowGetsItsLinksAndTheHomeFoldersFirst() throws {
    try withTrees { t in
      try t.folder(t.home)
      try t.file(t.inHome("config.toml"), "model = \"x\"\n")
      try t.file(t.inHome("history.jsonl"))
      try t.file(t.inHome("auth.json"), "primary")
      try t.materialize(createShadow: true)

      let homeNames = try t.names(t.home)
      #expect(homeNames == ["auth.json", "config.toml", "history.jsonl", "sessions", "thread-writer-locks"])
      #expect(try permissions(t.inHome("sessions")) == 0o700)
      #expect(try permissions(t.inHome("thread-writer-locks")) == 0o700)
      #expect(try permissions(t.shadow) == 0o700)
      #expect(try t.names(t.shadow) == ["config.toml", "history.jsonl", "sessions", "thread-writer-locks"])
      #expect(t.destination(t.inShadow("config.toml")) == t.inHome("config.toml"))
      #expect(t.destination(t.inShadow("sessions")) == t.inHome("sessions"))
      #expect(t.destination(t.inShadow("thread-writer-locks")) == t.inHome("thread-writer-locks"))
    }
  }

  @Test func aHomeEntryThatIsNotThereIsNotLinked() throws {
    try withTrees { t in
      try t.folder(t.home)
      try t.file(t.inHome("config.toml"))
      try t.materialize(createShadow: true)

      let shadowNames = try t.names(t.shadow)
      #expect(!shadowNames.contains("skills"))
      #expect(!shadowNames.contains("AGENTS.md"))
      #expect(!shadowNames.contains("history.jsonl"))
    }
  }

  @Test func theLoginsOfThePrimaryAndTheShadowAreNeverTouched() throws {
    try withTrees { t in
      try t.folder(t.home)
      let when = Date(timeIntervalSince1970: 1_700_000_000)
      try t.file(t.inHome("auth.json"), "primary-login")
      try t.file(t.inShadow("auth.json"), "work-login")
      try FileManager.default.setAttributes([.modificationDate: when], ofItemAtPath: t.inHome("auth.json"))
      try FileManager.default.setAttributes([.modificationDate: when], ofItemAtPath: t.inShadow("auth.json"))

      try t.materialize(requireLogin: true)

      #expect(try Data(contentsOf: URL(fileURLWithPath: t.inHome("auth.json"))) == Data("primary-login".utf8))
      #expect(try Data(contentsOf: URL(fileURLWithPath: t.inShadow("auth.json"))) == Data("work-login".utf8))
      #expect(try modified(t.inHome("auth.json")) == when)
      #expect(try modified(t.inShadow("auth.json")) == when)
    }
  }

  @Test func requireLoginNamesTheLoginCommandOnlyWhenAskedFor() throws {
    try withTrees { t in
      try t.folder(t.home)
      try t.folder(t.shadow)
      let command = ShadowLayout.codex.loginCommand(t.shadow, t.home)

      #expect(throws: ShadowHomeError(path: t.shadow, message: "`\(t.shadow)` has no login yet. Run `\(command)` to log in.")) {
        try t.materialize(requireLogin: true)
      }
      try t.materialize(requireLogin: false)

      try t.file(t.inShadow("auth.json"), "login")
      try t.materialize(requireLogin: true)
    }
  }

  @Test func aSymlinkedAuthJsonIsNotALogin() throws {
    try withTrees { t in
      try t.folder(t.home)
      try t.file(t.inHome("auth.json"), "primary")
      try t.folder(t.shadow)
      try t.link(t.inShadow("auth.json"), to: t.inHome("auth.json"))

      let command = ShadowLayout.codex.loginCommand(t.shadow, t.home)
      #expect(throws: ShadowHomeError(path: t.shadow, message: "`\(t.shadow)` has no login yet. Run `\(command)` to log in.")) {
        try t.materialize(requireLogin: true)
      }
    }
  }

  @Test func aMissingShadowIsCreatedOnlyWhenAskedFor() throws {
    try withTrees { t in
      try t.folder(t.home)
      try t.file(t.inHome("config.toml"))
      let command = ShadowLayout.codex.loginCommand(t.shadow, t.home)

      #expect(throws: ShadowHomeError(path: t.shadow, message: "`\(t.shadow)` does not exist yet. Prepare the account in the Accounts sheet, "
                                        + "then log in with `\(command)`.")) {
        try t.materialize()
      }
      // The refusal comes before anything is written in the home.
      #expect(try t.names(t.home) == ["config.toml"])

      try t.materialize(createShadow: true)
      #expect(try permissions(t.shadow) == 0o700)
      #expect(try t.names(t.shadow) == ["config.toml", "sessions", "thread-writer-locks"])
    }
  }

  @Test func aRealSessionsFolderInTheShadowIsAConflict() throws {
    try withTrees { t in
      try t.folder(t.home)
      try t.folder(t.inHome("sessions"))
      try t.folder(t.inShadow("sessions"))

      #expect(throws: ShadowHomeError(path: t.inShadow("sessions"),
                                      message: "`\(t.inShadow("sessions"))` is a real file; HiveMind shares it from `\(t.home)`. Move it away, then launch again.")) {
        try t.materialize()
      }
    }
  }

  @Test func aRealDatabaseInTheShadowIsAConflict() throws {
    try withTrees { t in
      try t.folder(t.home)
      try t.folder(t.shadow)
      try t.file(t.inShadow("state_5.sqlite"), "database")

      #expect(throws: ShadowHomeError(path: t.inShadow("state_5.sqlite"),
                                      message: "`\(t.inShadow("state_5.sqlite"))` should not be here: Codex keeps its databases in `\(t.home)` (CODEX_SQLITE_HOME). Move it away.")) {
        try t.materialize()
      }
    }
  }

  @Test func anUnknownNameIsAConflictOnlyWhenBothTreesHaveIt() throws {
    try withTrees { t in
      try t.folder(t.home)
      try t.file(t.inHome("only-home.bin"))
      try t.file(t.inShadow("only-shadow.bin"))
      try t.materialize()

      try t.file(t.inHome("mystery.txt"))
      try t.file(t.inShadow("mystery.txt"))
      #expect(throws: ShadowHomeError(path: t.inShadow("mystery.txt"),
                                      message: "Unknown Codex file `mystery.txt` in both homes; HiveMind's shadow layout needs an update.")) {
        try t.materialize()
      }
    }
  }

  @Test func anUnknownNameIsKeptPrivateWhenTheLayoutSaysSo() throws {
    try withTrees { t in
      try t.folder(t.home)
      try t.file(t.inHome("mystery.txt"))
      try t.file(t.inShadow("mystery.txt"))
      let layout = ShadowLayout(shared: [], sharedPatterns: [], privateNames: [], homeOnlyPatterns: [], ignoredPatterns: [],
                                ensureInHome: [], unknownNames: .keepPrivate, isLoggedIn: { _ in true }, loginCommand: { _, _ in "" })

      try ShadowHome().materialize(home: t.home, shadow: t.shadow, layout: layout, createShadow: false, requireLogin: false)
      #expect(t.destination(t.inShadow("mystery.txt")) == nil)
    }
  }

  @Test func ignoredNamesAreNeitherLinkedNorAConflict() throws {
    try withTrees { t in
      try t.folder(t.home)
      try t.file(t.inHome("foo.tmp"))
      try t.file(t.inHome(".DS_Store"))
      try t.file(t.inShadow("foo.tmp"))
      try t.file(t.inShadow(".DS_Store"))
      try t.materialize()

      #expect(t.destination(t.inShadow("foo.tmp")) == nil)
      #expect(t.destination(t.inShadow(".DS_Store")) == nil)
      #expect(try t.names(t.shadow) == [".DS_Store", "foo.tmp", "sessions", "thread-writer-locks"])
    }
  }

  @Test func aSymlinkToSomewhereElseIsAConflict() throws {
    try withTrees { t in
      try t.folder(t.home)
      try t.file(t.inHome("config.toml"))
      try t.folder(t.shadow)
      try t.file(t.outside("elsewhere.toml"))
      try t.link(t.inShadow("config.toml"), to: t.outside("elsewhere.toml"))

      #expect(throws: ShadowHomeError(path: t.inShadow("config.toml"),
                                      message: "`\(t.inShadow("config.toml"))` is a real file; HiveMind shares it from `\(t.home)`. Move it away, then launch again.")) {
        try t.materialize()
      }
    }
  }

  @Test func aSharedConfigNamedLikeAProfileIsLinkedAndOtherTomlIsNot() throws {
    try withTrees { t in
      try t.folder(t.home)
      try t.file(t.inHome("prof.config.toml"))
      try t.file(t.inHome("notes.toml"))
      try t.materialize(createShadow: true)

      #expect(t.destination(t.inShadow("prof.config.toml")) == t.inHome("prof.config.toml"))
      #expect(try t.names(t.shadow) == ["prof.config.toml", "sessions", "thread-writer-locks"])
    }
  }

  @Test func aSecondRunChangesNothing() throws {
    try withTrees { t in
      try t.folder(t.home)
      try t.file(t.inHome("config.toml"))
      try t.file(t.inHome("auth.json"), "primary")
      try t.file(t.inShadow("auth.json"), "work")
      try t.materialize(createShadow: true, requireLogin: true)
      let before = try snapshot(t)

      try t.materialize(createShadow: true, requireLogin: true)
      #expect(try snapshot(t) == before)
    }
  }

  @Test func theHomeIsRefusedAsItsOwnShadow() throws {
    try withTrees { t in
      try t.folder(t.home)
      #expect(throws: ShadowHomeError(path: t.home,
                                      message: "`\(t.home)` is the shared home itself; a shadow needs a folder of its own.")) {
        try ShadowHome().materialize(home: t.home, shadow: t.home, layout: .codex, createShadow: false, requireLogin: false)
      }

      // A symlink that points at the home is no shadow either.
      try t.link(t.shadow, to: t.home)
      #expect(throws: ShadowHomeError(path: t.shadow, message: "`\(t.shadow)` must be a folder, not a symlink or a file.")) {
        try t.materialize()
      }
    }
  }

  @Test func aSymlinkedOrMissingHomeIsRefused() throws {
    try withTrees { t in
      #expect(throws: ShadowHomeError(path: t.home, message: "`\(t.home)` must be an existing folder, not a symlink.")) {
        try t.materialize()
      }

      try t.folder(t.outside("elsewhere"))
      try t.link(t.home, to: t.outside("elsewhere"))
      #expect(throws: ShadowHomeError(path: t.home, message: "`\(t.home)` must be an existing folder, not a symlink.")) {
        try t.materialize()
      }
    }
  }

  @Test func theLoginCommandNamesTheShadowAndTheHome() {
    #expect(ShadowLayout.codex.loginCommand("/Users/me/.codex-work", "/Users/me/.codex")
      == "mkdir -p /Users/me/.codex-work && CODEX_HOME=/Users/me/.codex-work CODEX_SQLITE_HOME=/Users/me/.codex codex -c cli_auth_credentials_store=file login")
    #expect(ShadowLayout.codex.loginCommand("/Users/me/Codex Work", "/Users/me/.codex")
      .hasPrefix("mkdir -p '/Users/me/Codex Work' && CODEX_HOME='/Users/me/Codex Work' "))
    // The page's plain characters (src/shared/accounts.ts shellPath) stay unquoted here too.
    #expect(ShadowLayout.codex.loginCommand("/Users/me/.codex+work@a,b:c", "/Users/me/.codex")
      .hasPrefix("mkdir -p /Users/me/.codex+work@a,b:c && "))
  }
}
