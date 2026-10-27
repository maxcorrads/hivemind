import Foundation

// Accounts on remote hosts (docs/remote-hosts.md#accounts). Each account's home exists on every host at the same path,
// logged in there by the user to the same provider account as on this Mac; Hivemind copies no login and stores no token.
// What runs on a host is built here, as RemoteHostScripts builds the launch steps: `/bin/sh` scripts of quoted values,
// read back from marker lines, so the host's shell startup files may print what they like.
//
//   setup       a directory of the account on the host, from a `tar` of this Mac's configuration on stdin (settings,
//               skills, plugins, …, never a login): what the host lacks is copied, what it has is kept, and a Codex
//               home's config.toml gets the `[mcp_servers.hivemind]` block of the host's runtime
//   identity    Codex's `account/read` from `codex app-server` on the host, as a digest
//   taps        the Claude status-line tap's files on the host, for the usage probe
//   conversations
//               Find last conversations with the host's runtime (`hivemind conversations`)
//
// The same-account check compares digests only: a Claude login's `oauthAccount.accountUuid`, a Codex login's account
// type and email, each hashed where it is read. No token, file body or email is sent, logged or kept.

/// Which provider account a home is logged in to, as a digest of what names it; never the name itself.
public enum AccountIdentity: Equatable, Sendable {
  /// Logged in; the digest (an API key login is `api-key`: it names no account).
  case account(String)
  /// No login there.
  case none

  /// A Claude login: the SHA-256 of `oauthAccount.accountUuid`, as the host's perl computes it.
  static func claude(accountUuid: String) -> AccountIdentity { .account(SHA256Hash.hex(Data(accountUuid.utf8))) }

  /// A Codex login from `account/read`: `chatgpt` with the SHA-256 of `chatgpt:<email>` (ASCII letters lowercased, as
  /// the host's perl does), `apiKey` as `api-key`. Nil for an account type this does not know.
  static func codex(type: String, email: String?) -> AccountIdentity? {
    switch type {
    case "chatgpt":
      guard let email, !email.isEmpty else { return nil }
      let lowered = String(String.UnicodeScalarView(email.unicodeScalars.map { scalar in
        ("A"..."Z").contains(scalar) ? Unicode.Scalar(scalar.value + 32)! : scalar
      }))
      return .account(SHA256Hash.hex(Data("chatgpt:\(lowered)".utf8)))
    case "apiKey": return .account("api-key")
    default: return nil
    }
  }
}

/// Where an account's login lives under `home` (this Mac's or a host's), as the CLI looks for it.
public struct AccountLogin: Equatable, Sendable {
  /// The account's own directory: its shadow, else its home, else the driver's default.
  public let directory: String
  /// Claude's `.claude.json`: in the directory, or `~/.claude.json` for a primary with neither path (no
  /// CLAUDE_CONFIG_DIR). Nil for Codex.
  public let configFile: String?

  public init(_ account: LaunchAccount, home: String) {
    switch account.driver {
    case .codex:
      directory = expandingHome(account.shadowPath.isEmpty ? (account.homePath.isEmpty ? account.driver.defaultHome : account.homePath)
                                  : account.shadowPath, home: home)
      configFile = nil
    case .claude:
      directory = ClaudeLiveSessions.directory(of: account, home: home)
      configFile = account.homePath.isEmpty && account.shadowPath.isEmpty
        ? expandingHome("~/.claude.json", home: home) : directory + "/.claude.json"
    }
  }

  /// The file whose change means a new login: Codex's `auth.json`, Claude's `.claude.json`.
  public var loginFile: String { configFile ?? directory + "/auth.json" }
}

extension LaunchAccount {
  /// The command that logs the account in, its paths as stored (src/shared/accounts.ts, accountLoginCommand): the shell
  /// expands a leading `~/` with the home of the Mac it runs on.
  public var loginCommand: String {
    func word(_ path: String) -> String { path.hasPrefix("~/") ? "~/" + shellWord(String(path.dropFirst(2))) : shellWord(path) }
    switch driver {
    case .codex:
      guard shadowPath.isEmpty else {
        let dir = word(shadowPath), home = word(homePath.isEmpty ? driver.defaultHome : homePath)
        return "mkdir -p \(dir) && CODEX_HOME=\(dir) CODEX_SQLITE_HOME=\(home) codex -c cli_auth_credentials_store=file login"
      }
      return homePath.isEmpty ? "codex login" : "CODEX_HOME=\(word(homePath)) codex login"
    case .claude:
      let directory = shadowPath.isEmpty ? homePath : shadowPath
      guard !directory.isEmpty else { return "claude auth login" }
      return "mkdir -p \(word(directory)) && CLAUDE_CONFIG_DIR=\(word(directory)) claude auth login"
    }
  }

  /// The directory the account logs in to, as stored, for messages: its shadow, else its home, else the default.
  var storedDirectory: String { shadowPath.isEmpty ? (homePath.isEmpty ? driver.defaultHome : homePath) : shadowPath }
}

/// Reads this Mac's side of the same-account check: LocalAccountIdentity in the app, a fake in the tests.
@MainActor public protocol AccountIdentityReading {
  /// Which account `account` is logged in to on this Mac, or why that cannot be told.
  func identity(of account: LaunchAccount, home: String) async -> Result<AccountIdentity, BrokerFiles.Failure>
}

/// This Mac's logins: Claude's `oauthAccount.accountUuid` from the account's `.claude.json`, Codex's `account/read` from
/// `codex app-server` (the usage probe's runner, which costs no quota). Only the digest leaves here.
public struct LocalAccountIdentity: AccountIdentityReading {
  /// `.claude.json` is a few megabytes; a larger one is not read.
  static let maxClaudeJSONBytes = 64 << 20

  private let codex: any CodexProbeRunning

  public init(codex: any CodexProbeRunning) {
    self.codex = codex
  }

  public func identity(of account: LaunchAccount, home: String) async -> Result<AccountIdentity, BrokerFiles.Failure> {
    let login = AccountLogin(account, home: home)
    switch account.driver {
    case .claude:
      return .success(Self.claudeIdentity(configFile: login.configFile ?? login.directory + "/.claude.json"))
    case .codex:
      let variables = account.environment(home: home)
      let unset = account.controlledNames.filter { name in !variables.contains { $0.name == name } }
      let lines = await codex.probe(set: variables, unset: unset)
      guard let identity = CodexUsage.parseAccountIdentity(lines: lines) else {
        return .failure(.init("codex app-server did not say which account is logged in"))
      }
      return .success(identity)
    }
  }

  /// The digest of `oauthAccount.accountUuid` in a regular `.claude.json`, or none. Nothing else of the file is decoded.
  static func claudeIdentity(configFile: String) -> AccountIdentity {
    struct Config: Decodable {
      struct OAuth: Decodable { let accountUuid: String? }
      let oauthAccount: OAuth?
    }
    var info = stat()
    guard lstat(configFile, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_size <= maxClaudeJSONBytes,
          let data = FileManager.default.contents(atPath: configFile),
          let uuid = (try? JSONDecoder().decode(Config.self, from: data))?.oauthAccount?.accountUuid, !uuid.isEmpty else { return .none }
    return .claude(accountUuid: uuid)
  }

  /// A login file's identity as the host's perl writes it (`dev:ino:size:mtime`), or `none`: a new login changes it.
  public static func stamp(_ path: String) -> String {
    var info = stat()
    guard stat(path, &info) == 0 else { return "none" }
    return "\(info.st_dev):\(info.st_ino):\(info.st_size):\(info.st_mtimespec.tv_sec)"
  }
}

extension CodexUsage {
  /// The requests that ask `codex app-server` only which account is logged in.
  static let identityRequests = [
    #"{"id":1,"method":"initialize","params":{"clientInfo":{"name":"hivemind_account_check","title":"HiveMind account check","version":"1"}}}"#,
    #"{"method":"initialized"}"#,
    #"{"id":2,"method":"account/read","params":{"refreshToken":false}}"#,
  ]

  /// The identity in the reply to `account/read` (request 2) among a probe's lines: `none` when no account is logged in,
  /// nil when there is no such reply or it is an error. The email is hashed here and dropped.
  public static func parseAccountIdentity(lines: [String]) -> AccountIdentity? {
    struct Reply: Decodable {
      struct Result: Decodable {
        struct Account: Decodable { let type: String; let email: String? }
        let account: Account?
      }
      let id: Int?
      let method: String?
      let result: Result?
    }
    for line in lines {
      guard let reply = try? JSONDecoder().decode(Reply.self, from: Data(line.utf8)), reply.method == nil,
            reply.id == accountReplyId else { continue }
      guard let result = reply.result else { return nil }
      guard let account = result.account else { return AccountIdentity.none }
      return AccountIdentity.codex(type: account.type, email: account.email)
    }
    return nil
  }
}

/// How a host's shell runs `codex` for the identity check: the login shell the sessions run, as here
/// (CodexAppServerProbe). The tests give `/bin/sh -c` and a fake codex.
public struct RemoteCodexLookup: Equatable, Sendable {
  public var shell: [String]
  public var codex: String

  public init(shell: [String], codex: String) {
    self.shell = shell
    self.codex = codex
  }

  public static let standard = RemoteCodexLookup(shell: [TmuxCommand.shell, "-lic"], codex: "codex")
}

/// One agent Find last conversations looks for (`hivemind conversations` on a host, docs/remote-hosts.md#conversations).
public struct ConversationAgent: Codable, Equatable, Sendable {
  public let id: String
  public let name: String
  public let worktree: String?

  public init(id: String, name: String, worktree: String?) {
    self.id = id
    self.name = name
    self.worktree = worktree
  }

  /// `worktree` is always written, `null` when there is none: the host's `hivemind conversations` requires the key
  /// (src/server/cli-conversations.ts), and the synthesized encoding would leave it out.
  public func encode(to encoder: any Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encode(id, forKey: .id)
    try container.encode(name, forKey: .name)
    try container.encode(worktree, forKey: .worktree)
  }

  public var isValid: Bool {
    (1...64).contains(id.utf8.count) && (1...64).contains(name.utf8.count) && (worktree?.utf8.count ?? 0) <= 4096
      && !BrokerText.hasControlCharacters(id) && !BrokerText.hasControlCharacters(name)
  }
}

/// An agent's last conversation on a host (src/shared/cli-conversations.ts, CliConversation), with its host.
public struct BrokerConversation: Codable, Equatable, Sendable {
  public let cli: String
  public let software: String
  public let id: String
  public let cwd: String?
  public let at: Int64
  public let host: String?

  public init(cli: String, software: String, id: String, cwd: String?, at: Int64, host: String?) {
    self.cli = cli
    self.software = software
    self.id = id
    self.cwd = cwd
    self.at = at
    self.host = host
  }

  /// As the page takes it: a CLI it knows and short plain fields.
  public var isValid: Bool {
    ["claude", "codex", "cursor"].contains(cli) && (1...64).contains(software.utf8.count) && (1...128).contains(id.utf8.count)
      && (cwd?.utf8.count ?? 0) <= 4096 && at >= 0 && host.map(RemoteHost.isID) != false
      && ![software, id, cwd ?? ""].contains(where: BrokerText.hasControlCharacters)
  }

  func on(host id: String) -> BrokerConversation {
    BrokerConversation(cli: cli, software: software, id: self.id, cwd: cwd, at: at, host: id)
  }
}

/// What a setup did to one directory.
public struct RemoteSetupResult: Equatable, Sendable {
  public var copied: [String] = []
  public var kept: [String] = []
  /// The `[mcp_servers.hivemind]` block was written (true) or already this runtime's (false); nil when not asked.
  public var mcpWritten: Bool?
  public var error: String?
}

/// One Claude account's tap on a host: its status line and when the tap wrote it, and its last limit error.
public struct RemoteTap: Equatable, Sendable {
  public var statusLine: Data?
  /// Unix ms.
  public var statusModified: Int?
  /// Unix seconds, as the tap writes it.
  public var limitError: Int?
}

public enum RemoteAccountScripts {
  private static func q(_ value: String) -> String { TerminalScript.shellQuoted(value) }

  /// A setup or a copy of plugins may take this long; an identity check, a tap read and a scan 30 s.
  public static let setupTimeout: TimeInterval = 15 * 60
  public static let identityTimeout: TimeInterval = 30
  /// How long `codex app-server` has to answer on the host, as here.
  public static let codexAnswerTimeout = 20

  // MARK: setup

  /// What of this Mac's configuration a host's directory gets (docs/remote-hosts.md#accounts): settings, instructions,
  /// skills, plugins and the like. Never a login (`auth.json`, `.credentials.json`, `.claude.json`), a transcript, a
  /// database or a cache.
  public static func configNames(_ driver: LaunchAccount.Driver) -> [String] {
    switch driver {
    case .codex: ["config.toml", "AGENTS.md", "AGENTS.override.md", "hooks.json", "prompts", "skills", "rules", "plugins"]
    case .claude: ["settings.json", "CLAUDE.md", "agents", "commands", "skills", "plugins", "hooks", "output-styles", "statusline-command.sh"]
    }
  }

  /// Names that are never copied, whatever a list says.
  public static let neverCopied: Set<String> = ["auth.json", ".credentials.json", ".claude.json"]

  /// The configuration entries of this Mac's `directory` a host gets, in name order: a Codex profile
  /// (`<name>.config.toml`) as well as the list. Only regular files and folders (symlinks followed).
  public static func configEntries(_ driver: LaunchAccount.Driver, in directory: String) -> [String] {
    let names = (try? FileManager.default.contentsOfDirectory(atPath: directory)) ?? []
    let listed = Set(configNames(driver))
    return names.filter { name in
      guard !neverCopied.contains(name),
            listed.contains(name) || (driver == .codex && name.wholeMatch(of: /[A-Za-z0-9_-]+\.config\.toml/) != nil) else { return false }
      var isDirectory: ObjCBool = false
      return FileManager.default.fileExists(atPath: directory + "/" + name, isDirectory: &isDirectory)
    }.sorted()
  }

  /// The `tar` of `entries` of this Mac's `directory`, as `setup` reads it: links followed, no macOS metadata.
  public static func archiveSpec(directory: String, entries: [String]) -> LaunchSpec {
    LaunchSpec(executable: URL(fileURLWithPath: "/usr/bin/tar"),
               arguments: ["-c", "-f", "-", "--no-mac-metadata", "-L", "--exclude", ".DS_Store", "-C", directory] + entries,
               environment: ["COPYFILE_DISABLE": "1", "PATH": "/usr/bin:/bin"], workingDirectory: URL(fileURLWithPath: directory))
  }

  /// The `[mcp_servers.hivemind]` block of a Codex home on a host: the host's runtime (`runtimeFolder`, relative to
  /// its home) runs the MCP against the agent forward, as remoteHivemindMcp (src/shared/hosts.ts) gives a Claude launch.
  public static func codexMcpBlock(runtimeFolder: String) -> String {
    let runtime = "\"$HOME/\(runtimeFolder)\""
    let script = "support=\"$HOME/\(RemoteHostScripts.supportFolder)\"; HIVEMIND_HOME=\"$support/clients\" exec "
      + "\(runtime)/node \(runtime)/server/bin/hivemind.mjs mcp"
    return """
      \(codexMarker)
      [mcp_servers.hivemind]
      command = "/bin/sh"
      args = ["-c", \(toml(script))]
      tool_timeout_sec = 28800
      env_vars = ["HIVEMIND_TMUX_SESSION", "HIVEMIND_ROLE"]

      [mcp_servers.hivemind.env]
      HIVEMIND_URL = "http://127.0.0.1:\(HostsService.defaultAgentPort.value)"
      HIVEMIND_TOKEN = ""

      """
  }

  /// The comment above the block, which a later write replaces with it.
  static let codexMarker = "# Hivemind on this host (written by Hivemind Server; docs/remote-hosts.md#accounts)"

  /// A TOML basic string: JSON's escapes.
  static func toml(_ value: String) -> String {
    var out = "\""
    for scalar in value.unicodeScalars {
      switch scalar {
      case "\"": out += "\\\""
      case "\\": out += "\\\\"
      case "\n": out += "\\n"
      case "\t": out += "\\t"
      case _ where scalar.value < 0x20 || scalar.value == 0x7F: out += String(format: "\\u%04X", scalar.value)
      default: out.unicodeScalars.append(scalar)
      }
    }
    return out + "\""
  }

  /// Makes `target` a folder of the user's (0700) if it is missing, and, when `entries` is not empty, reads their
  /// `tar` from stdin into a private folder inside it and moves each entry the folder lacks into place; one it has
  /// is kept. Copied plugin manifests (`plugins/*.json`) name this Mac's home: it becomes the host's. With `codexBlock`
  /// the folder's config.toml then gets that block in place of any `[mcp_servers.hivemind]` it had.
  public static func setup(target: String, entries: [String], macHome: String, codexBlock: String?) -> String {
    var script = "umask 077\nfail() { printf 'hivemind-error %s\\n' \"$1\"; exit 0; }\n"
      + "target=\(q(target))\n"
      + "if [ -L \"$target\" ] || { [ -e \"$target\" ] && [ ! -d \"$target\" ]; }; then fail \(q("`\(target)` must be a folder, not a symlink or a file.")); fi\n"
      + "[ -d \"$target\" ] || mkdir -p -m 700 -- \"$target\" || fail \(q("Cannot create `\(target)`"))\n"
    if !entries.isEmpty {
      script += "work=$(mktemp -d \"$target/.hivemind-setup.XXXXXX\") || fail \(q("Cannot write in `\(target)`"))\n"
        + "trap 'rm -rf \"$work\"' EXIT\n"
        + "tar -xf - -C \"$work\" || fail \(q("The copy of this Mac's configuration did not arrive"))\n"
        + "for name in \(entries.map(q).joined(separator: " ")); do\n"
        + "  [ -e \"$work/$name\" ] || [ -L \"$work/$name\" ] || continue\n"
        + "  if [ -e \"$target/$name\" ] || [ -L \"$target/$name\" ]; then printf 'hivemind-kept %s\\n' \"$name\"; continue; fi\n"
        + "  mv -- \"$work/$name\" \"$target/$name\" || fail \"Cannot write \\`$target/$name\\`\"\n"
        + "  printf 'hivemind-copied %s\\n' \"$name\"\n"
        + "  if [ \"$name\" = plugins ] && [ -d \"$target/plugins\" ]; then\n"
        + "    /usr/bin/perl -e \(q(homeProgram)) \(q(macHome)) \"$HOME\" \"$target\"/plugins/*.json 2>/dev/null\n"
        + "  fi\n"
        + "done\n"
    }
    if let codexBlock {
      script += "/usr/bin/perl -e \(q(codexBlockProgram)) \"$target/config.toml\" \(q(codexBlock)) || fail \(q("Cannot write `\(target)/config.toml`"))\n"
    }
    return script + "echo hivemind-setup-done\n"
  }

  /// Replaces `<mac home>/` with `<host home>/` in each file given, written through a temporary file (created as
  /// `writerProgram` creates the launch file: exclusively, no link followed, 0600) and a rename; a file without it is
  /// left alone.
  static let homeProgram = #"""
    use strict;
    use Fcntl qw(O_WRONLY O_CREAT O_EXCL O_NOFOLLOW);
    my ($from, $to, @files) = @ARGV;
    exit 0 if $from eq $to;
    for my $file (@files) {
      next unless -f $file && !-l $file;
      open(my $in, '<', $file) or next;
      my $text = do { local $/; <$in> };
      close($in);
      next unless defined $text && index($text, "$from/") >= 0;
      $text =~ s/\Q$from\E\//$to\//g;
      my $temporary = "$file.hivemind-$$";
      sysopen(my $out, $temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600) or next;
      print {$out} $text;
      close($out) or do { unlink($temporary); next; };
      chmod((stat($file))[2] & 07777, $temporary);
      rename($temporary, $file) or unlink($temporary);
    }
    """#

  /// Puts the block (second argument) into the config.toml (first) in place of every `[mcp_servers.hivemind]` table
  /// and its sub-tables and of the marker line, at the end; a missing file is created (0600). The new text goes to a
  /// temporary file created exclusively, no link followed, at 0600 whatever the umask (a launch's start sets none, and
  /// the file may hold an MCP server's token), and gets the file's mode only once written. Prints whether it wrote.
  static let codexBlockProgram = #"""
    use strict;
    use Fcntl qw(O_WRONLY O_CREAT O_EXCL O_NOFOLLOW);
    my ($path, $block) = @ARGV;
    my $marker = (split(/\n/, $block))[0];
    my $old = '';
    if (-e $path) { open(my $in, '<', $path) or exit 1; $old = do { local $/; <$in> }; close($in); $old = '' unless defined $old; }
    my ($kept, $skipping) = ('', 0);
    for my $line (split(/^/, $old)) {
      my $bare = $line; $bare =~ s/\r?\n\z//;
      next if $bare eq $marker;
      if ($bare =~ /\A\s*\[/) { $skipping = $bare =~ /\A\s*\[\s*mcp_servers\s*\.\s*(?:hivemind|"hivemind")\s*(?:\]|\.)/ ? 1 : 0; }
      $kept .= $line unless $skipping;
    }
    $kept =~ s/\s+\z//;
    my $new = length($kept) ? "$kept\n\n$block" : $block;
    if ($new eq $old) { print "hivemind-mcp current\n"; exit 0; }
    my $mode = -e $path ? (stat($path))[2] & 07777 : 0600;
    my $temporary = "$path.hivemind-$$";
    sysopen(my $out, $temporary, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0600) or exit 1;
    print {$out} $new;
    close($out) or do { unlink($temporary); exit 1; };
    chmod($mode, $temporary);
    rename($temporary, $path) or do { unlink($temporary); exit 1; };
    print "hivemind-mcp written\n";
    """#

  public static func parseSetup(_ output: String) -> RemoteSetupResult? {
    let lines = output.split(whereSeparator: \.isNewline).map(String.init)
    var result = RemoteSetupResult()
    if let error = lines.last(where: { $0.hasPrefix("hivemind-error ") }) {
      result.error = String(error.dropFirst("hivemind-error ".count).prefix(300))
      return result
    }
    guard lines.contains("hivemind-setup-done") else { return nil }
    result.copied = lines.filter { $0.hasPrefix("hivemind-copied ") }.map { String($0.dropFirst("hivemind-copied ".count)) }
    result.kept = lines.filter { $0.hasPrefix("hivemind-kept ") }.map { String($0.dropFirst("hivemind-kept ".count)) }
    if let mcp = lines.last(where: { $0.hasPrefix("hivemind-mcp ") }) { result.mcpWritten = mcp == "hivemind-mcp written" }
    return result
  }

  /// The block alone, for a launch: puts it in `config` when it differs, and says nothing else.
  public static func ensureCodexBlock(config: String, block: String) -> String {
    "/usr/bin/perl -e \(q(codexBlockProgram)) \(q(config)) \(q(block)) >/dev/null 2>&1 || printf 'hivemind-mcp-failed\\n'\n"
  }

  // MARK: shadow

  /// The writes a shadow's steps recorded on the host's snapshot (SnapshotShadowFiles), each refused when something
  /// appeared there meanwhile. Shared with the launch's start.
  static func applying(_ actions: [SnapshotShadowFiles.Action], again: String) -> String {
    actions.map { action in
      switch action {
      case .makeFolder(let folder):
        "if [ -e \(q(folder)) ] || [ -L \(q(folder)) ]; then fail \(q("`\(folder)` appeared on the host meanwhile; \(again).")); fi\n"
          + "mkdir -m 700 -- \(q(folder)) || fail \(q("Cannot create `\(folder)`"))\n"
      case .link(let link, let target):
        "if [ -e \(q(link)) ] || [ -L \(q(link)) ]; then fail \(q("`\(link)` appeared on the host meanwhile; \(again).")); fi\n"
          + "ln -s -- \(q(target)) \(q(link)) || fail \(q("Cannot link `\(link)` to `\(target)`"))\n"
      }
    }.joined()
  }

  /// Applies a prepare's recorded shadow writes on the host.
  public static func applyShadow(_ actions: [SnapshotShadowFiles.Action]) -> String {
    "fail() { printf 'hivemind-error %s\\n' \"$1\"; exit 0; }\n" + applying(actions, again: "Prepare again") + "echo hivemind-applied\n"
  }

  /// Nil when the writes were made, else why not; a script that answered nothing is a failure too.
  public static func parseApplied(_ output: String) -> String? {
    let lines = output.split(whereSeparator: \.isNewline).map(String.init)
    if let error = lines.last(where: { $0.hasPrefix("hivemind-error ") }) { return String(error.dropFirst("hivemind-error ".count)) }
    return lines.contains("hivemind-applied") ? nil : "the host did not answer"
  }

  // MARK: identity

  /// Runs `codex app-server` on the host with `set` exported and `unset` removed, as a session there would, asks it
  /// `account/read` and prints the identity's digest: the email is hashed on the host and never leaves it.
  public static func codexIdentity(_ codex: RemoteCodexLookup, set: [(name: String, value: String)], unset: [String]) -> String {
    let command = codex.shell + [CodexAppServerScript.script(codex: codex.codex, set: set, unset: unset)]
    let requests = CodexUsage.identityRequests.joined(separator: "\n") + "\n"
    return "PATH=/opt/homebrew/bin:/usr/local/bin:$PATH; export PATH\n"
      + "exec /usr/bin/perl -e \(q(identityProgram)) \(codexAnswerTimeout) \(q(requests)) \(command.map(q).joined(separator: " "))\n"
  }

  static let identityProgram = #"""
    use strict; use warnings;
    use IPC::Open2; use IO::Select; use JSON::PP; use Digest::SHA qw(sha256_hex); use POSIX qw(:sys_wait_h);
    my ($timeout, $requests, @command) = @ARGV;
    $| = 1;
    open(STDERR, '>', '/dev/null');
    $SIG{PIPE} = 'IGNORE';
    my ($out, $in);
    my $pid = eval { open2($out, $in, @command) };
    unless ($pid) { print "hivemind-identity error codex could not start on this host\n"; exit 0; }
    print {$in} $requests;
    $in->flush();
    # stdin stays open until the reply arrives: on its end codex drops a reply still pending.
    my ($select, $buffer, $answer) = (IO::Select->new($out), '', undef);
    my $deadline = time() + $timeout;
    READ: while (!defined $answer) {
      my $left = $deadline - time();
      last if $left <= 0 || !$select->can_read($left);
      my $read = sysread($out, my $chunk, 65536);
      last unless $read;
      $buffer .= $chunk;
      last if length($buffer) > 1048576;
      while ($buffer =~ s/\A([^\n]*)\n//) {
        my $reply = eval { JSON::PP->new->decode($1) };
        next unless ref($reply) eq 'HASH' && !exists $reply->{method} && defined $reply->{id} && !ref($reply->{id}) && $reply->{id} eq '2';
        $answer = $reply;
        last READ;
      }
    }
    close($in);
    for my $signal (0, 'TERM', 'KILL') {
      kill($signal, $pid) if $signal;
      my $until = time() + 2;
      while (waitpid($pid, WNOHANG) == 0 && time() < $until) { select(undef, undef, undef, 0.05); }
      last if waitpid($pid, WNOHANG) != 0;
    }
    unless (defined $answer) { print "hivemind-identity error codex app-server did not answer on this host\n"; exit 0; }
    unless (ref($answer->{result}) eq 'HASH') { print "hivemind-identity error account/read failed on this host\n"; exit 0; }
    my $account = $answer->{result}{account};
    if (!ref($account)) { print "hivemind-identity none\n"; exit 0; }
    my $type = defined $account->{type} ? "$account->{type}" : '';
    if ($type eq 'apiKey') { print "hivemind-identity account api-key\n"; exit 0; }
    my $email = $account->{email};
    if ($type eq 'chatgpt' && defined $email && !ref($email) && length $email) {
      $email =~ tr/A-Z/a-z/;
      my $text = "chatgpt:$email";
      utf8::encode($text);
      print "hivemind-identity account ", sha256_hex($text), "\n";
      exit 0;
    }
    print "hivemind-identity error codex reported an account type Hivemind does not know\n";
    """#

  /// What the identity script printed: the identity, or why it could not be told.
  public static func parseIdentity(_ output: String) -> Result<AccountIdentity, BrokerFiles.Failure> {
    let lines = output.split(whereSeparator: \.isNewline).map(String.init)
    guard let line = lines.last(where: { $0.hasPrefix("hivemind-identity ") }) else {
      return .failure(.init(SSHTransport.reason(in: lines) ?? "the host did not answer"))
    }
    let fields = line.dropFirst("hivemind-identity ".count).split(separator: " ", maxSplits: 1).map(String.init)
    switch fields.first {
    case "none": return .success(.none)
    case "account" where fields.count == 2 && (fields[1] == "api-key" || fields[1].wholeMatch(of: /[0-9a-f]{64}/) != nil):
      return .success(.account(fields[1]))
    case "error" where fields.count == 2: return .failure(.init(String(fields[1].prefix(200))))
    default: return .failure(.init("the host's answer could not be read"))
    }
  }

  // MARK: taps

  /// Prints each account's tap files under the host's `accounts` folder: the status line (at most 1 MiB, base64, with
  /// its modification time) and the limit error's time. A missing file prints nothing.
  public static func taps(_ ids: [String]) -> String {
    "exec /usr/bin/perl -e \(q(tapsProgram)) \"$HOME/\(RemoteHostScripts.supportFolder)/accounts\" \(ids.map(q).joined(separator: " "))\n"
  }

  static let tapsProgram = #"""
    use strict;
    use MIME::Base64 qw(encode_base64); use Time::HiRes qw(stat);
    my ($folder, @ids) = @ARGV;
    for my $id (@ids) {
      next unless $id =~ /\A[A-Za-z0-9_-]{1,64}\z/;
      my $status = "$folder/$id/statusline.json";
      my @info = stat($status);
      if (@info && -f _ && $info[7] <= 1048576 && open(my $fh, '<', $status)) {
        binmode($fh);
        my $data = do { local $/; <$fh> };
        close($fh);
        printf("hivemind-status %s %d %s\n", $id, int($info[9] * 1000), encode_base64(defined $data ? $data : '', ''));
      }
      my $limit = "$folder/$id/limit-error";
      if (-f $limit && -s _ <= 64 && open(my $lh, '<', $limit)) {
        my $text = do { local $/; <$lh> };
        close($lh);
        $text =~ s/\s+//g if defined $text;
        printf("hivemind-limit %s %s\n", $id, $text) if defined $text && $text =~ /\A[0-9]{1,13}\z/;
      }
    }
    print "hivemind-taps\n";
    """#

  /// The taps a host printed, by account id; nil when it did not finish.
  public static func parseTaps(_ output: String) -> [String: RemoteTap]? {
    let lines = output.split(whereSeparator: \.isNewline).map(String.init)
    guard lines.contains("hivemind-taps") else { return nil }
    var taps: [String: RemoteTap] = [:]
    for line in lines {
      let fields = line.split(separator: " ", omittingEmptySubsequences: false).map(String.init)
      if fields.count == 4, fields[0] == "hivemind-status", let modified = Int(fields[2]), let data = Data(base64Encoded: fields[3]) {
        taps[fields[1], default: RemoteTap()].statusLine = data
        taps[fields[1], default: RemoteTap()].statusModified = modified
      } else if fields.count == 3, fields[0] == "hivemind-limit", let seconds = Int(fields[2]) {
        taps[fields[1], default: RemoteTap()].limitError = seconds
      }
    }
    return taps
  }

  // MARK: conversations

  /// Runs `hivemind conversations` with the host's runtime, the agents on stdin.
  public static func conversations(runtimeFolder: String) -> String {
    let runtime = "\"$HOME\"/\(q(runtimeFolder))"
    return """
      out=$(\(runtime)/node \(runtime)/server/bin/hivemind.mjs conversations 2>&1)
      printf 'hivemind-conversations %s\\n' "$?"
      printf '%s\\n' "$out"

      """
  }

  /// The conversations a host's scan found, each carrying the host; or why the scan failed.
  public static func parseConversations(_ output: String, host: String) -> Result<[String: BrokerConversation], BrokerFiles.Failure> {
    struct Answer: Decodable { let conversations: [String: BrokerConversation] }
    let lines = output.split(whereSeparator: \.isNewline).map(String.init)
    guard let marker = lines.lastIndex(where: { $0.hasPrefix("hivemind-conversations ") }) else {
      return .failure(.init(SSHTransport.reason(in: lines) ?? "the host did not answer"))
    }
    let after = Array(lines[(marker + 1)...])
    guard lines[marker] == "hivemind-conversations 0" else {
      return .failure(.init(String((after.first ?? "the scan failed").prefix(200))))
    }
    guard let json = after.last(where: { $0.hasPrefix("{") }),
          let answer = try? JSONDecoder().decode(Answer.self, from: Data(json.utf8)) else {
      return .failure(.init("the host's scan could not be read"))
    }
    return .success(answer.conversations.mapValues { $0.on(host: host) }.filter { $0.value.isValid })
  }
}

/// The Claude taps of the remote hosts, for the usage probe (docs/remote-hosts.md#usage): HostTaps in the app, a fake in
/// the tests. Nil in the probe: only this Mac's taps are read, as before hosts.
@MainActor public protocol RemoteTapReading: AnyObject {
  /// Each account's newest status line across the ready hosts, and its latest limit error. A host that fails is skipped.
  func taps(of ids: [String]) async -> [String: RemoteTap]
}

/// The taps of every ready host, read over its master, one host after another.
@MainActor public final class HostTaps: RemoteTapReading {
  private let hosts: any BrokerRemoteHosts

  public init(hosts: any BrokerRemoteHosts) {
    self.hosts = hosts
  }

  public func taps(of ids: [String]) async -> [String: RemoteTap] {
    guard !ids.isEmpty else { return [:] }
    var merged: [String: RemoteTap] = [:]
    for host in hosts.brokerHosts where host.ready {
      let ran = await hosts.run(onHost: host.id, script: RemoteAccountScripts.taps(ids), stdin: Data(),
                                timeout: RemoteAccountScripts.identityTimeout)
      guard ran.succeeded, let taps = RemoteAccountScripts.parseTaps(ran.stdout) else { continue }
      for (id, tap) in taps { merged[id] = Self.newer(merged[id], tap) }
    }
    return merged
  }

  /// The newer status line of the two, and the later limit error.
  static func newer(_ a: RemoteTap?, _ b: RemoteTap) -> RemoteTap {
    guard let a else { return b }
    var out = (a.statusModified ?? -1) >= (b.statusModified ?? -1) ? a : b
    out.limitError = [a.limitError, b.limitError].compactMap { $0 }.max()
    return out
  }
}
