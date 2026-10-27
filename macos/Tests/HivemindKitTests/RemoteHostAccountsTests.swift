import Foundation
import Testing
@testable import HivemindKit

// Accounts on remote hosts (docs/remote-hosts.md#accounts), end to end on this Mac: the broker runs its host scripts
// through the fake `ssh` (FakeSSH) under a temp remote HOME, the host's `codex app-server` is a fake script
// (fakeCodexScript) and this Mac's logins a fake (FakeAccountIdentity), whose Mac home is a temp folder too. No real
// host, login, codex or home is reached.

private let runtimeFolder = "Library/Application Support/Hivemind/remote/9.9.9"
private let fakeSecret = "FAKE-SECRET-TOKEN-0000"

private func mode(_ path: String) -> mode_t {
  var info = stat()
  return lstat(path, &info) == 0 ? info.st_mode & 0o7777 : 0
}

private func exists(_ path: String) -> Bool {
  var info = stat()
  return lstat(path, &info) == 0
}

@MainActor
@Suite("Accounts on remote hosts")
struct RemoteHostAccountsTests {
  /// Writes `text` at `path`, creating its folders.
  private func write(_ text: String, _ path: String) throws {
    try FileManager.default.createDirectory(atPath: (path as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    try Data(text.utf8).write(to: URL(fileURLWithPath: path))
  }

  private func prepare(_ r: RemoteFixture, _ account: LaunchAccount) async -> BrokerEvent? {
    let (transport, connection) = await r.h.client()
    await r.h.send(connection, .accountPrepare(account: account, host: fakeHost.id), id: "p1")
    return transport.events().first
  }

  @Test func prepareOnAHostCopiesThisMacsConfigurationButNoLoginAndChecksTheAccount() async throws {
    let r = try RemoteFixture()
    defer { r.remove() }
    let mac = r.h.home + "/.codex"
    try write("model = \"gpt-5\"\n\n[mcp_servers.hivemind]\ncommand = \"node\"\nargs = [\"/Users/me/hivemind/cli.js\", \"mcp\"]\n\n"
              + "[mcp_servers.hivemind.env]\nHIVEMIND_URL = \"http://127.0.0.1:7420\"\n\n[mcp_servers.other]\ncommand = \"other-mcp\"\n",
              mac + "/config.toml")
    try write("Be brief.\n", mac + "/AGENTS.md")
    try write("# Skill\n", mac + "/skills/review/SKILL.md")
    try write("model = \"o3\"\n", mac + "/fast.config.toml")
    for secret in ["auth.json", ".credentials.json", "sessions/2026/rollout-x.jsonl", "history.jsonl", "state_5.sqlite"] {
      try write(fakeSecret, mac + "/" + secret)
    }
    await r.h.start()
    let account = LaunchAccount(id: "codex-main", driver: .codex, label: "Codex", homePath: "", shadowPath: "")
    #expect(await prepare(r, account) == .accountPrepared(AccountPreparation(loggedIn: false)), "set up, waiting for its login there")

    let host = r.home + "/.codex"
    #expect(mode(host) == 0o700)
    #expect(r.read(host + "/AGENTS.md") == "Be brief.\n")
    #expect(r.read(host + "/skills/review/SKILL.md") == "# Skill\n")
    #expect(r.read(host + "/fast.config.toml") == "model = \"o3\"\n")
    for secret in ["auth.json", ".credentials.json", "sessions", "history.jsonl", "state_5.sqlite"] {
      #expect(!exists(host + "/" + secret), "\(secret) stays on this Mac")
    }
    let config = try #require(r.read(host + "/config.toml"))
    #expect(config.hasPrefix("model = \"gpt-5\"\n\n[mcp_servers.other]\ncommand = \"other-mcp\"\n\n"), "the rest of the config as here")
    #expect(config.hasSuffix(RemoteAccountScripts.codexMcpBlock(runtimeFolder: runtimeFolder)))
    #expect(!config.contains("/Users/me/hivemind") && !config.contains("7420"), "this Mac's MCP block is not the host's")
    #expect(config.contains(#"exec \"$HOME/Library/Application Support/Hivemind/remote/9.9.9\"/node"#))
    #expect(config.contains("HIVEMIND_URL = \"http://127.0.0.1:7422\""))

    // Prepare again keeps what the host has, and the block stays one.
    try write("Be thorough.\n", mac + "/AGENTS.md")
    try write("Host notes.\n", host + "/AGENTS.md")
    #expect(await prepare(r, account) == .accountPrepared(AccountPreparation(loggedIn: false)))
    #expect(r.read(host + "/AGENTS.md") == "Host notes.\n")
    #expect(r.read(host + "/config.toml") == config)

    // Logged in there to the same account: ready. To another one: refused, naming the host, the home and the account.
    try r.logInCodex(".codex")
    #expect(await prepare(r, account) == .accountPrepared(AccountPreparation(loggedIn: true)))
    try r.logInCodex(".codex", email: "someone.else@example.com")
    #expect(await prepare(r, account) == .accountPrepared(AccountPreparation(loggedIn: true, error:
      "`~/.codex` on Build Mac is logged in to another account than Codex on this Mac. Log in there again with `codex login`, "
        + "then Prepare the account in the Accounts sheet.")))
    // This Mac not logged in: nothing to compare with.
    r.identities.answers["codex-main"] = .success(.none)
    #expect(await prepare(r, account) == .accountPrepared(AccountPreparation(loggedIn: true, error:
      "Codex is not logged in on this Mac, so its login on Build Mac cannot be checked. Log in here first with `codex login`.")))
    let logged = r.h.logs.joined(separator: "\n") + r.hosts.scripts.joined(separator: "\n")
    for secret in [fakeSecret, FakeAccountIdentity.email, "someone.else@example.com"] { #expect(!logged.contains(secret)) }
  }

  @Test func aHostDirectoryThatIsALinkIsRefusedForItsOwnReasonHoweverLargeTheCopy() async throws {
    let r = try RemoteFixture()
    defer { r.remove() }
    let mac = r.h.home + "/.codex"
    try write("model = \"gpt-5\"\n", mac + "/config.toml")
    // Far past a pipe's buffer: the setup refuses before reading it, and this Mac's `tar` is left with no reader.
    try write(String(repeating: "x", count: 4 << 20), mac + "/skills/big/SKILL.md")
    let dotfiles = r.home + "/dotfiles/codex"
    try FileManager.default.createDirectory(atPath: dotfiles, withIntermediateDirectories: true)
    try FileManager.default.createSymbolicLink(atPath: r.home + "/.codex", withDestinationPath: dotfiles)
    await r.h.start()
    let account = LaunchAccount(id: "codex-main", driver: .codex, label: "Codex", homePath: "", shadowPath: "")
    let refused = BrokerEvent.accountPrepared(AccountPreparation(loggedIn: false, error:
      "Build Mac: `\(r.home)/.codex` must be a folder, not a symlink or a file."))
    #expect(await prepare(r, account) == refused)
    #expect((try? FileManager.default.contentsOfDirectory(atPath: dotfiles)) == [], "nothing is written through the link")

    // A file in its place: the same.
    try FileManager.default.removeItem(atPath: r.home + "/.codex")
    try write("", r.home + "/.codex")
    #expect(await prepare(r, account) == refused)
  }

  @Test func aClaudeShadowOnAHostGetsItsOwnSettingsAndItsLinksAndNoLogin() async throws {
    let r = try RemoteFixture()
    defer { r.remove() }
    r.h.shadowHomes = FileShadowHomes()
    let shared = r.h.home + "/.claude", shadow = r.h.home + "/.claude-personal"
    try write(#"{"cleanupPeriodDays":30}"#, shared + "/settings.json")
    try write("# House rules\n", shared + "/CLAUDE.md")
    try write(fakeSecret, shared + "/projects/-x/session.jsonl")
    try write(#"{"cleanupPeriodDays":30,"statusLine":{"type":"command","command":"~/.claude-personal/statusline-command.sh"}}"#,
              shadow + "/settings.json")
    try write("echo hi\n", shadow + "/statusline-command.sh")
    try write(#"{"plugins":{"x@m":[{"installPath":"\#(shadow)/plugins/cache/m/x"}]}}"#, shadow + "/plugins/installed_plugins.json")
    try write(fakeSecret, shadow + "/.credentials.json")
    try write(#"{"oauthAccount":{"accountUuid":"\#(FakeAccountIdentity.uuid)"},"token":"\#(fakeSecret)"}"#, shadow + "/.claude.json")
    await r.h.start()
    let account = LaunchAccount(id: "claude-personal", driver: .claude, label: "Claude personal", homePath: "", shadowPath: "~/.claude-personal")
    #expect(await prepare(r, account) == .accountPrepared(AccountPreparation(loggedIn: false)))

    let hostShared = r.home + "/.claude", hostShadow = r.home + "/.claude-personal"
    #expect(r.read(hostShared + "/settings.json") == #"{"cleanupPeriodDays":30}"#)
    #expect(r.read(hostShared + "/CLAUDE.md") == "# House rules\n")
    #expect(r.read(hostShadow + "/statusline-command.sh") == "echo hi\n")
    #expect(r.read(hostShadow + "/plugins/installed_plugins.json") == #"{"plugins":{"x@m":[{"installPath":"\#(hostShadow)/plugins/cache/m/x"}]}}"#,
            "a plugin's path names the host's home")
    for secret in [".credentials.json", ".claude.json"] { #expect(!exists(hostShadow + "/" + secret)) }
    #expect(!exists(hostShared + "/projects/-x"), "no transcript is copied")
    for name in ["projects", "file-history", "paste-cache", "plans", "tasks"] {
      #expect((try? FileManager.default.destinationOfSymbolicLink(atPath: hostShadow + "/" + name)) == hostShared + "/" + name, "\(name)")
    }

    try r.logInClaude(".claude-personal/.claude.json")
    #expect(await prepare(r, account) == .accountPrepared(AccountPreparation(loggedIn: true)))
    try r.logInClaude(".claude-personal/.claude.json", uuid: "0a1b2c3d-0000-4000-8000-0000000000ff")
    #expect(await prepare(r, account) == .accountPrepared(AccountPreparation(loggedIn: true, error:
      "`~/.claude-personal` on Build Mac is logged in to another account than Claude personal on this Mac. Log in there again with "
        + "`mkdir -p ~/.claude-personal && CLAUDE_CONFIG_DIR=~/.claude-personal claude auth login`, then Prepare the account in the Accounts sheet.")))
    #expect(r.read(r.home + "/.fake-codex-runs") == nil, "a Claude check runs no codex")
  }

  @Test func aLaunchOnAHostNeedsTheSameAccountLoggedInThere() async throws {
    let r = try RemoteFixture()
    defer { r.remove() }
    await r.h.start()
    let (transport, connection) = await r.h.client()
    let account = LaunchAccount(id: "codex-work", driver: .codex, label: "Codex work", homePath: "~/.codex2", shadowPath: "")
    func launched() async throws -> BrokerEvent? {
      await r.h.send(connection, .launch([try r.launch(account: account)]))
      return transport.events().first
    }
    func refused(_ message: String) -> BrokerEvent {
      .launched(names: [nil], created: [], errors: [BrokerLaunchFailure(index: 0, code: .internal, message: "launches[0].account: \(message)")])
    }
    #expect(try await launched() == refused(
      "`~/.codex2` on Build Mac has no login of Codex work yet. Run `CODEX_HOME=~/.codex2 codex login` in a terminal on Build Mac, "
        + "then Prepare the account in the Accounts sheet."))
    try r.logInCodex(".codex2", email: "someone.else@example.com")
    #expect(try await launched() == refused(
      "`~/.codex2` on Build Mac is logged in to another account than Codex work on this Mac. Log in there again with "
        + "`CODEX_HOME=~/.codex2 codex login`, then Prepare the account in the Accounts sheet."))
    #expect(r.launchFiles().isEmpty && !exists(r.home + "/.fake-tmux/sessions"), "nothing started")
    try r.logInCodex(".codex2")
    #expect(try await launched() == .launched(names: [SessionName("hm-acme-atlas")!], created: [SessionName("hm-acme-atlas")!], errors: []))
    #expect(r.read(r.home + "/.codex2/config.toml") == RemoteAccountScripts.codexMcpBlock(runtimeFolder: runtimeFolder),
            "the launch gives the home this runtime's MCP block")
    let runs = r.read(r.home + "/.fake-codex-runs")?.split(separator: "\n") ?? []
    #expect(runs.map(String.init) == [r.home + "/.codex2", r.home + "/.codex2"], "account/read ran under the account's CODEX_HOME")
    // The same logins again: no account/read is asked until a login file changes.
    await r.h.send(connection, .kill(session: SessionName("hm-acme-atlas")!))
    _ = transport.take()
    #expect(try await launched() == .launched(names: [SessionName("hm-acme-atlas")!], created: [SessionName("hm-acme-atlas")!], errors: []))
    #expect(r.read(r.home + "/.fake-codex-runs")?.split(separator: "\n").count == 2)
    #expect(r.identities.asked == ["codex-work", "codex-work"])
  }

  @Test func withoutTheMacsSideOrWithNoHostNothingIsCompared() async throws {
    // No host configured: Prepare and a launch with an account are this Mac's, as before hosts.
    let h = BrokerHarness()
    let identities = FakeAccountIdentity()
    h.accountIdentity = identities
    await h.start()
    let (transport, connection) = await h.client()
    let account = LaunchAccount(id: "codex-main", driver: .codex, label: "Codex", homePath: "", shadowPath: "")
    await h.send(connection, .accountPrepare(account: account), id: "p1")
    #expect(transport.events() == [.accountPrepared(AccountPreparation(loggedIn: false, error: "this broker cannot prepare accounts"))])
    await h.send(connection, .accountPrepare(account: account, host: fakeHost.id), id: "p2")
    #expect(transport.events() == [.accountPrepared(AccountPreparation(loggedIn: false, error: "That host is not configured in Hivemind Server"))])
    await h.send(connection, .launch([try BrokerLaunch(project: "acme", agent: "Atlas", title: "Acme", cwd: "/Users/me/acme",
                                                        command: "codex", account: account)]))
    #expect(transport.events().first == .launched(names: [SessionName("hm-acme-atlas")!], created: [SessionName("hm-acme-atlas")!], errors: []))
    #expect(identities.asked.isEmpty, "no login is compared on this Mac")

    // A broker that cannot read this Mac's logins launches no account on a host.
    let r = try RemoteFixture()
    defer { r.remove() }
    r.h.accountIdentity = nil
    try r.logInCodex(".codex")
    await r.h.start()
    let (hostTransport, hostConnection) = await r.h.client()
    await r.h.send(hostConnection, .launch([try r.launch(account: account)]))
    #expect(hostTransport.events().first == .launched(names: [nil], created: [], errors: [BrokerLaunchFailure(index: 0, code: .internal,
      message: "launches[0].account: This Hivemind Server cannot check accounts on a host")]))
    // Without an account a launch there checks nothing.
    await r.h.send(hostConnection, .launch([try r.launch()]))
    #expect(hostTransport.events().first == .launched(names: [SessionName("hm-acme-atlas")!], created: [SessionName("hm-acme-atlas")!], errors: []))
  }

  @Test func findLastConversationsOnAHostRunsItsRuntimeAndCarriesTheHost() async throws {
    let r = try RemoteFixture()
    defer { r.remove() }
    let runtime = r.home + "/" + runtimeFolder
    try write("", runtime + "/server/bin/hivemind.mjs")
    // The host's node: records its arguments and stdin, then answers as `hivemind conversations` does.
    try write("""
      #!/bin/sh
      printf '%s\\n' "$*" > "$HOME/.node-args"
      cat > "$HOME/.node-stdin"
      echo "node: a warning"
      # As the real command's schema: every agent names its worktree, null when it has none.
      /usr/bin/perl -MJSON::PP -e 'my $in = decode_json(do { local $/; <STDIN> }); exists $_->{worktree} or exit 1 for @{$in->{agents}}' \\
        < "$HOME/.node-stdin" || { echo "Error: conversations: stdin must be {agents: [{id, name, worktree}]}"; exit 1; }
      if [ -f "$HOME/.node-fails" ]; then echo "Error: conversations: stdin is not JSON"; exit 1; fi
      echo '{"conversations":{"a1":{"cli":"claude","software":"claude2","id":"c1a2b3c4-0000-4000-8000-000000000001","cwd":"/Users/me/acme","at":1700000000000}}}'
      """, runtime + "/node")
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: runtime + "/node")
    await r.h.start()
    let (transport, connection) = await r.h.client()
    let agents = [ConversationAgent(id: "a1", name: "Atlas", worktree: "/Users/me/acme"), ConversationAgent(id: "b1", name: "Bea", worktree: nil)]
    await r.h.send(connection, .conversationsFind(host: fakeHost.id, agents: agents), id: "c1")
    #expect(transport.events() == [.conversations(["a1": BrokerConversation(cli: "claude", software: "claude2",
      id: "c1a2b3c4-0000-4000-8000-000000000001", cwd: "/Users/me/acme", at: 1_700_000_000_000, host: fakeHost.id)])])
    #expect(r.read(r.home + "/.node-args") == runtime + "/server/bin/hivemind.mjs conversations\n")
    let sent = try #require(r.read(r.home + "/.node-stdin"))
    #expect(try JSONDecoder().decode([String: [ConversationAgent]].self, from: Data(sent.utf8)) == ["agents": agents])
    let written = try #require(JSONSerialization.jsonObject(with: Data(sent.utf8)) as? [String: [[String: Any]]])
    #expect(written["agents"]?.last?["worktree"] is NSNull, "no worktree is written as null, not left out")

    try write("", r.home + "/.node-fails")
    await r.h.send(connection, .conversationsFind(host: fakeHost.id, agents: agents), id: "c2")
    #expect(transport.events() == [.error(code: .internal, message: "Build Mac: node: a warning", stream: nil)])
  }

  @Test func theUsageProbeReadsEachHostsTapOverItsMaster() async throws {
    let ssh = try FakeSSH()
    defer { ssh.remove() }
    let hosts = ShellHosts(ssh: ssh, hosts: [BrokerRemoteHost(id: fakeHost.id, label: fakeHost.label, ready: true, runtimeFolder: runtimeFolder)])
    let folder = ssh.remoteHome.path + "/Library/Application Support/Hivemind/accounts/claude-work"
    let status = #"{"rate_limits":{"five_hour":{"used_percentage":12,"resets_at":1791820800}}}"#
    try write(status, folder + "/statusline.json")
    try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSince1970: 1_791_800_000)], ofItemAtPath: folder + "/statusline.json")
    try write("1791801000\n", folder + "/limit-error")
    try write("{}", ssh.remoteHome.path + "/Library/Application Support/Hivemind/accounts/other/statusline.json")
    let taps = await HostTaps(hosts: hosts).taps(of: ["claude-work", "missing", "../escape"])
    #expect(taps == ["claude-work": RemoteTap(statusLine: Data(status.utf8), statusModified: 1_791_800_000_000, limitError: 1_791_801_000)])
    #expect(hosts.scripts.count == 1, "one round trip for every account")
    // An offline host is not asked.
    hosts.hosts = [BrokerRemoteHost(id: fakeHost.id, label: fakeHost.label, ready: false, runtimeFolder: runtimeFolder)]
    #expect(await HostTaps(hosts: hosts).taps(of: ["claude-work"]) == [:])
    #expect(hosts.scripts.count == 1)
    // With no host configured nothing is read and no ssh runs, as before hosts.
    hosts.hosts = []
    #expect(await HostTaps(hosts: hosts).taps(of: ["claude-work"]) == [:])
    #expect(hosts.scripts.count == 1 && ssh.calls().count == 1)
  }

  @Test func theNewerTapWinsAndTheLaterLimitError() {
    let older = RemoteTap(statusLine: Data("a".utf8), statusModified: 1, limitError: 9)
    let newer = RemoteTap(statusLine: Data("b".utf8), statusModified: 2, limitError: nil)
    #expect(HostTaps.newer(older, newer) == RemoteTap(statusLine: Data("b".utf8), statusModified: 2, limitError: 9))
    #expect(HostTaps.newer(newer, older) == RemoteTap(statusLine: Data("b".utf8), statusModified: 2, limitError: 9))
    #expect(HostTaps.newer(nil, older) == older)
  }

  @Test func theIdentitiesAreDigestsAndTheLoginCommandsMatchThePages() {
    #expect(AccountIdentity.codex(type: "chatgpt", email: "User@Example.com") == AccountIdentity.codex(type: "chatgpt", email: "user@example.com"))
    #expect(AccountIdentity.codex(type: "chatgpt", email: "a@example.com") != AccountIdentity.codex(type: "chatgpt", email: "b@example.com"))
    #expect(AccountIdentity.codex(type: "apiKey", email: nil) == .account("api-key"))
    #expect(AccountIdentity.codex(type: "chatgpt", email: nil) == nil)
    guard case .account(let digest)? = AccountIdentity.codex(type: "chatgpt", email: "user@example.com") else { Issue.record(); return }
    #expect(digest.count == 64 && !digest.contains("example"))
    #expect(CodexUsage.parseAccountIdentity(lines: ["noise", #"{"method":"x"}"#, #"{"id":2,"result":{"account":null}}"#]) == AccountIdentity.none)
    #expect(CodexUsage.parseAccountIdentity(lines: [#"{"id":2,"error":{"code":-1,"message":"x"}}"#]) == nil)
    #expect(CodexUsage.parseAccountIdentity(lines: []) == nil)
    // src/shared/accounts.ts, accountLoginCommand.
    let commands: [(LaunchAccount, String)] = [
      (LaunchAccount(id: "a", driver: .codex, label: "A", homePath: "", shadowPath: ""), "codex login"),
      (LaunchAccount(id: "b", driver: .codex, label: "B", homePath: "~/.codex work", shadowPath: ""), "CODEX_HOME=~/'.codex work' codex login"),
      (LaunchAccount(id: "c", driver: .codex, label: "C", homePath: "", shadowPath: "~/.codex_personal"),
       "mkdir -p ~/.codex_personal && CODEX_HOME=~/.codex_personal CODEX_SQLITE_HOME=~/.codex codex -c cli_auth_credentials_store=file login"),
      (LaunchAccount(id: "d", driver: .claude, label: "D", homePath: "", shadowPath: ""), "claude auth login"),
      (LaunchAccount(id: "e", driver: .claude, label: "E", homePath: "/Volumes/x/.claude", shadowPath: ""),
       "mkdir -p /Volumes/x/.claude && CLAUDE_CONFIG_DIR=/Volumes/x/.claude claude auth login"),
    ]
    for (account, command) in commands { #expect(account.loginCommand == command, "\(account.id)") }
  }

  @Test func theCodexBlockReplacesEveryHivemindTableAndKeepsTheRest() throws {
    let root = try temporaryHome()
    defer { try? FileManager.default.removeItem(at: root) }
    let config = root.appendingPathComponent("config.toml").path
    let block = RemoteAccountScripts.codexMcpBlock(runtimeFolder: runtimeFolder)
    func run() throws -> String {
      let process = Process()
      process.executableURL = URL(fileURLWithPath: "/bin/sh")
      process.arguments = ["-c", RemoteAccountScripts.ensureCodexBlock(config: config, block: block)]
      try process.run()
      process.waitUntilExit()
      return (try? String(contentsOfFile: config, encoding: .utf8)) ?? ""
    }
    #expect(try run() == block, "a missing file gets the block alone")
    #expect(mode(config) == 0o600)
    try Data("a = 1\n[mcp_servers.\"hivemind\"]\ncommand = \"x\"\n[mcp_servers.hivemind.env]\nK = \"v\"\n[profiles.fast]\nmodel = \"o3\"\n".utf8)
      .write(to: URL(fileURLWithPath: config))
    chmod(config, 0o644)
    #expect(try run() == "a = 1\n[profiles.fast]\nmodel = \"o3\"\n\n" + block)
    #expect(mode(config) == 0o644, "the file keeps its mode")
    let written = try run()
    #expect(try run() == written, "a second run changes nothing")

    // The temporary file is the user's alone until it is complete, whatever the umask (a launch's start sets none):
    // a hook on chmod records its mode, and whether it is a link, just before it gets the file's.
    let seen = root.appendingPathComponent("seen").path
    let hook = #"BEGIN { *CORE::GLOBAL::chmod = sub { my ($m, @f) = @_; open(my $s, '>>', $ENV{SEEN}); "#
      + #"printf {$s} "%o %d\n", (lstat($_))[2] & 07777, -l $_ ? 1 : 0 for @f; close($s); CORE::chmod($m, @f) } }"#
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/sh")
    process.arguments = ["-c", "umask 000; exec /usr/bin/perl -e \"$1\" -e \"$2\" \"$3\" \"$4\"", "sh", hook,
                         RemoteAccountScripts.codexBlockProgram, config, block + "# again\n"]
    process.environment = ["SEEN": seen, "PATH": "/usr/bin:/bin"]
    process.standardOutput = FileHandle.nullDevice
    try process.run()
    process.waitUntilExit()
    #expect(process.terminationStatus == 0)
    #expect(try String(contentsOfFile: seen, encoding: .utf8) == "600 0\n")
    #expect(mode(config) == 0o644, "then the file's mode")
  }
}
