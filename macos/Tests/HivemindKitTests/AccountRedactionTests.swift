import Foundation
import Testing
@testable import HivemindKit

// Redaction (docs/accounts.md, "Usage"; #325 ticket 5.9): fake secrets planted in a fake Mac's login files and in the
// payloads the parsers, the usage probe and the broker read. Nothing that comes out of them (the parsed windows and plan,
// the posted body, a thrown error, a launch's result, journal entry, log lines, tmux commands and files) may hold one.
// Fake values only; the fake Mac lives in a temp folder, tmux is a fake, and no codex or claude runs.

private let fakeKey = "sk-ant-FAKE-REDACTION-0001"
private let fakeToken = "FAKE-ACCESS-TOKEN-REDACTION-0002"
private let fakeRefresh = "FAKE-REFRESH-TOKEN-REDACTION-0003"
private let fakeCredentials = "FAKE-CREDENTIALS-BODY-REDACTION-0004"
private let fakeEmail = "fake.person@example.com"
private let fakeMcpValue = "FAKE-MCP-SECRET-VALUE-REDACTION-0005"
private let fakeUUID = "00000000-0000-4000-8000-0000000000aa"

/// Every planted value: none may come out of a parser, a post or an error.
private let planted = [fakeKey, fakeToken, fakeRefresh, fakeCredentials, fakeEmail, fakeMcpValue, fakeUUID]

/// The round's clock, and the cache's `fetchedAtMs` 100 s before it.
private let now = Date(timeIntervalSince1970: 1_791_802_100)
private let fetchedAtMs = 1_791_802_000_000

/// A status line with the fields around `rate_limits`, and a planted key the parser must ignore.
private let statusLine = #"{"session_id":"00000000-0000-4000-8000-000000000001","transcript_path":"/Users/test/shadows/claude-work/projects/x.jsonl","api_key":"\#(fakeKey)","rate_limits":{"five_hour":{"used_percentage":23.5,"resets_at":1791820800},"seven_day":{"used_percentage":41.2,"resets_at":1792252800}}}"#

/// A `.claude.json` with a fake login's email and uuid, a fake mcpServers value, and a fresh usage cache of that login.
private let claudeJSON = #"{"numStartups":3,"oauthAccount":{"accountUuid":"\#(fakeUUID)","emailAddress":"\#(fakeEmail)"},"mcpServers":{"fake":{"command":"fake-mcp","env":{"API_TOKEN":"\#(fakeMcpValue)"}}},"cachedUsageUtilization":{"fetchedAtMs":\#(fetchedAtMs),"accountUuid":"\#(fakeUUID)","utilization":{"five_hour":{"utilization":23.0,"resets_at":"2026-10-12T16:00:00.000000+00:00"},"seven_day":{"utilization":41.0,"resets_at":"2026-10-16T08:00:00.000000+00:00"}}}}"#

/// `codex app-server` replies for a subscriber: the account reply carries the email, the rate-limit reply the windows.
private let subscriberLines = [
  #"{"id":1,"result":{"userAgent":"hivemind_usage_probe/0.162.1","codexHome":"/private/var/folders/xx/T/tmp.FAKE"}}"#,
  #"{"id":3,"result":{"rateLimits":{"limitId":"codex","primary":{"usedPercent":42,"windowDurationMins":300,"resetsAt":1791820800}}}}"#,
  #"{"id":2,"result":{"account":{"type":"chatgpt","email":"\#(fakeEmail)","planType":"plus"}}}"#,
]

/// A probe that failed with a message carrying a planted token and key, then an error line with a planted refresh token.
private let failedLines = [
  #"{"id":3,"error":{"code":-32603,"message":"failed to fetch codex rate limits: \#(fakeToken) \#(fakeKey)"}}"#,
  "codex: \(fakeRefresh)",
]

/// A fake Mac under a fresh temp folder: its home, its Application Support, and the tap's folder there.
private struct RedactionMac {
  let root: URL
  var home: String { root.appendingPathComponent("home").path }
  var paths: HivemindPaths { HivemindPaths(home: URL(fileURLWithPath: home)) }
  var tap: ClaudeStatusTap { ClaudeStatusTap(folder: paths.accounts) }

  /// Writes `text` at the absolute `path`, creating its folder.
  func write(_ text: String, at path: String) throws {
    let url = URL(fileURLWithPath: path)
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data(text.utf8).write(to: url)
  }

  /// The tap's file `name` of `account`, absolute.
  func tapFile(_ account: LaunchAccount, _ name: String) -> String {
    tap.accountFolder(account.id)!.appendingPathComponent(name).path
  }

  /// The text of every file under `folder`, each prefixed by its path.
  func texts(under folder: URL) -> [String] {
    let files = FileManager.default.enumerator(at: folder, includingPropertiesForKeys: nil)?.allObjects as? [URL] ?? []
    return files.compactMap { url in
      (try? String(contentsOf: url, encoding: .utf8)).map { "\(url.path)\n\($0)" }
    }
  }
}

/// The fake Mac sits at its real path (the temp dir is behind a symlink, and a Claude shadow must be given its real path).
@MainActor private func withRedactionMac(_ body: @MainActor (RedactionMac) async throws -> Void) async throws {
  let root = FileManager.default.temporaryDirectory.resolvingSymlinksInPath()
    .appendingPathComponent("hivemind-redaction-\(UUID().uuidString)")
  defer { try? FileManager.default.removeItem(at: root) }
  let mac = RedactionMac(root: root)
  try FileManager.default.createDirectory(atPath: mac.home, withIntermediateDirectories: true)
  try await body(mac)
}

/// The server: its instance proof, `GET /api/launcher/accounts`, a usage post answered with `postStatus` and `postBody`,
/// and the launcher queue, whose `next` gives each of `commands` in turn and whose result posts are kept.
private actor RedactionHTTPFake: LauncherHTTP {
  let secret: InstanceSecret
  let accounts: [LaunchAccount]
  let postStatus: Int
  let postBody: Data
  var commands: [LauncherCommand]
  var requests: [URLRequest] = []

  init(secret: InstanceSecret, accounts: [LaunchAccount] = [], commands: [LauncherCommand] = [], postStatus: Int = 200,
       postBody: Data = Data("{\"ok\":true}".utf8)) {
    self.secret = secret; self.accounts = accounts; self.commands = commands; self.postStatus = postStatus; self.postBody = postBody
  }

  func send(_ request: URLRequest) async throws -> (status: Int, body: Data) {
    requests.append(request)
    let url = request.url!
    if url.path == "/api/health/instance" {
      let nonce = InstanceNonce(hex: URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!.first!.value!)!
      let proof = InstanceProof.proof(secret: secret, nonce: nonce, port: ServerPort(url.port!)!)
      return (200, Data("{\"proof\":\"\(proof)\"}".utf8))
    }
    if url.path == "/api/launcher/accounts" { return (200, try JSONEncoder().encode(["accounts": accounts])) }
    if url.path == "/api/launcher/usage" { return (postStatus, postBody) }
    if url.path == "/api/launcher/next" {
      let command = commands.isEmpty ? nil : commands.removeFirst()
      return (200, try JSONEncoder().encode(["command": command]))
    }
    if url.path.hasSuffix("/result") { return (200, Data("{}".utf8)) }
    return (404, Data())
  }

  /// The body of each usage post, in order.
  func postBodies() -> [Data] {
    requests.filter { $0.url?.path == "/api/launcher/usage" }.map { $0.httpBody ?? Data() }
  }

  /// The body of each launcher result post, in order.
  func resultBodies() -> [Data] {
    requests.filter { $0.url?.path.hasSuffix("/result") == true }.map { $0.httpBody ?? Data() }
  }

  /// Every usage post body, as text.
  func postedText() -> String {
    postBodies().map { String(decoding: $0, as: UTF8.self) }.joined()
  }
}

/// `codex app-server`: each probe takes the next of `responses` (the last one again when they run out).
@MainActor private final class RedactionCodexProbe: CodexProbeRunning {
  var responses: [[String]]

  init(_ responses: [[String]]) { self.responses = responses }

  func probe(set: [(name: String, value: String)], unset: [String]) async -> [String] {
    if responses.count > 1 { return responses.removeFirst() }
    return responses.first ?? []
  }
}

@Suite("Account redaction")
@MainActor struct AccountRedactionTests {
  let secret = InstanceSecret.generate()

  @Test func theParsersGiveNoPlantedValue() throws {
    let windows = try #require(ClaudeUsage.parseStatusLine(Data(statusLine.utf8)))
    let cache = try #require(ClaudeUsage.parseUsageCache(claudeJSON: Data(claudeJSON.utf8), now: now))
    guard case .success(let probe) = CodexUsage.parseCodexProbe(lines: subscriberLines) else {
      Issue.record("the subscriber's probe should parse")
      return
    }
    guard case .failure(let failure) = CodexUsage.parseCodexProbe(lines: failedLines) else {
      Issue.record("the failing probe should not parse")
      return
    }
    #expect(probe.plan == "subscription", "the parse ran on the subscriber's replies")
    #expect(!windows.isEmpty && !cache.isEmpty)

    let outputs = [String(describing: windows), String(describing: cache), String(describing: probe), failure.message]
    for output in outputs {
      for value in planted { #expect(!output.contains(value), "a planted value came out of a parser") }
    }
  }

  @Test func aRoundPostsNoPlantedValueAndKeepsOnlyFixedErrors() async throws {
    try await withRedactionMac { mac in
      let codexPrimary = LaunchAccount(id: "20000000-0000-4000-8000-000000000001", driver: .codex, label: "Codex",
                                       homePath: "", shadowPath: "")
      let codexShadow = LaunchAccount(id: "20000000-0000-4000-8000-000000000002", driver: .codex, label: "Codex personal",
                                      homePath: "", shadowPath: "~/.codex_personal")
      let claudeShadow = LaunchAccount(id: "20000000-0000-4000-8000-000000000003", driver: .claude, label: "Claude work",
                                       homePath: "", shadowPath: "~/.claude-work")
      let claudePrimary = LaunchAccount(id: "20000000-0000-4000-8000-000000000004", driver: .claude, label: "Claude",
                                        homePath: "", shadowPath: "")
      // The fake logins: auth.json and .credentials.json where a launch keeps them, and .claude.json in both Claude homes.
      try mac.write(#"{"auth_mode":"chatgpt","tokens":{"access_token":"\#(fakeToken)","refresh_token":"\#(fakeRefresh)"}}"#,
                    at: mac.home + "/.codex_personal/auth.json")
      try mac.write(#"{"claudeAiOauth":{"accessToken":"\#(fakeKey)","refreshToken":"\#(fakeCredentials)"}}"#,
                    at: mac.home + "/.claude-work/.credentials.json")
      try mac.write(claudeJSON, at: mac.home + "/.claude-work/.claude.json")
      try mac.write(claudeJSON, at: mac.home + "/.claude.json")
      try mac.write(statusLine, at: mac.tapFile(claudeShadow, "statusline.json"))

      let http = RedactionHTTPFake(secret: secret, accounts: [codexPrimary, codexShadow, claudeShadow, claudePrimary])
      let codex = RedactionCodexProbe([subscriberLines, failedLines])
      let sut = UsageProbeService(server: { [secret] in .init(endpoint: ServerEndpoint(port: ServerPort(7520)!), secret: secret) },
                                  http: http, codex: codex, shadowHomes: FakeShadowHomes(), tap: mac.tap, home: mac.home, now: { now })
      try await sut.refreshOnce()

      let posted = await http.postedText()
      #expect(!posted.isEmpty, "the round posted its snapshots")
      for value in planted { #expect(!posted.contains(value), "a planted value reached the usage post") }
      let body = try #require(await http.postBodies().first)
      let object = try #require(try JSONSerialization.jsonObject(with: body) as? [String: Any])
      let snapshots = try #require(object["snapshots"] as? [[String: Any]])
      #expect(snapshots.count == 4)
      // The only error is the fixed message of a probe that failed; the probe's own output never goes in.
      #expect(Set(snapshots.compactMap { $0["error"] as? String }) == ["Usage read failed"])
    }
  }

  @Test func aRefusedPostThrowsItsStatusNotItsBody() async throws {
    try await withRedactionMac { mac in
      let account = LaunchAccount(id: "20000000-0000-4000-8000-000000000005", driver: .codex, label: "Codex",
                                  homePath: "", shadowPath: "")
      let body = Data("{\"error\":\"\(fakeToken) \(fakeEmail)\"}".utf8)
      let http = RedactionHTTPFake(secret: secret, accounts: [account], postStatus: 500, postBody: body)
      let sut = UsageProbeService(server: { [secret] in .init(endpoint: ServerEndpoint(port: ServerPort(7520)!), secret: secret) },
                                  http: http, codex: RedactionCodexProbe([subscriberLines]), shadowHomes: FakeShadowHomes(),
                                  tap: mac.tap, home: mac.home, now: { now })
      do {
        try await sut.refreshOnce()
        Issue.record("a refused usage post should throw")
      } catch {
        let text = "\(error) \(error.localizedDescription)"
        #expect(text.contains("500"))
        for value in planted { #expect(!text.contains(value), "a planted value reached a thrown error") }
      }
    }
  }

  @Test func aShadowLaunchLeavesNoPlantedValueInItsResultJournalLogsCommandsOrFiles() async throws {
    try await withRedactionMac { mac in
      let codexShadow = LaunchAccount(id: "20000000-0000-4000-8000-000000000006", driver: .codex, label: "Codex personal",
                                      homePath: "", shadowPath: "~/.codex_personal")
      let claudeShadow = LaunchAccount(id: "20000000-0000-4000-8000-000000000007", driver: .claude, label: "Claude work",
                                       homePath: "", shadowPath: "~/.claude-work")
      // The logins in both shadows, a fake mcpServers value in the shared Codex config and in the shadow's .claude.json,
      // and the shadow's own settings.json (the tap's chained statusLine) with a planted key.
      try mac.write("[mcp_servers.fake]\ncommand = \"fake-mcp\"\nenv = { API_TOKEN = \"\(fakeMcpValue)\" }\n",
                    at: mac.home + "/.codex/config.toml")
      try mac.write(#"{"auth_mode":"chatgpt","tokens":{"access_token":"\#(fakeToken)","refresh_token":"\#(fakeRefresh)"}}"#,
                    at: mac.home + "/.codex_personal/auth.json")
      try FileManager.default.createDirectory(atPath: mac.home + "/.claude", withIntermediateDirectories: true)
      try mac.write(#"{"claudeAiOauth":{"accessToken":"\#(fakeKey)","refreshToken":"\#(fakeCredentials)"}}"#,
                    at: mac.home + "/.claude-work/.credentials.json")
      try mac.write(claudeJSON, at: mac.home + "/.claude-work/.claude.json")
      try mac.write(#"{"env":{"ANTHROPIC_API_KEY":"\#(fakeKey)"},"statusLine":{"type":"command","command":"echo \#(fakeToken)"}}"#,
                    at: mac.home + "/.claude-work/settings.json")

      let h = BrokerHarness()
      h.secretStore = LaunchSecretStore(folder: mac.paths.launchSecrets)
      h.home = mac.home
      h.shadowHomes = FileShadowHomes()
      h.claudeTap = mac.tap
      await h.start()
      let command = { (id: String, agent: String, account: LaunchAccount) in
        LauncherCommand(id: id, kind: .launch, requestId: UUID().uuidString, templateId: "11111111-1111-4111-8111-111111111111",
                        project: "acme", agent: agent, title: "Acme - \(agent)",
                        session: SessionName(project: "acme", agent: agent).rawValue, cwd: "/Users/me/acme",
                        command: account.driver.rawValue, environment: ["TASK_ENV": "safe"], account: account)
      }
      let http = RedactionHTTPFake(secret: secret, commands: [
        command("30000000-0000-4000-8000-000000000001", "codex-task", codexShadow),
        command("30000000-0000-4000-8000-000000000002", "claude-task", claudeShadow),
      ])
      let journal = mac.paths.appSupport.appendingPathComponent("launcher-journal")
      let sut = LauncherService(server: { [secret] in .init(endpoint: ServerEndpoint(port: ServerPort(7520)!), secret: secret) },
                                http: http, broker: InProcessLauncherBroker(current: { h.broker }),
                                journal: FileLauncherJournal(folder: journal))
      try await sut.pollOnce()
      try await sut.pollOnce()

      let results = try await http.resultBodies().map { try JSONDecoder().decode(LauncherResult.self, from: $0) }
      #expect(results == [.launched(SessionName(project: "acme", agent: "codex-task")),
                          .launched(SessionName(project: "acme", agent: "claude-task"))], "both shadows launched")
      // Everything Server.app wrote: the journal, the launch files and the tap's settings.
      let files = mac.texts(under: mac.paths.appSupport)
      #expect(mac.texts(under: journal).count == 2)
      #expect(files.contains { $0.contains("CODEX_HOME=") } && files.contains { $0.contains(ClaudeStatusTap.variable) })
      let surfaces = [
        "result": await http.resultBodies().map { String(decoding: $0, as: UTF8.self) }.joined(separator: "\n"),
        "log": h.logs.joined(separator: "\n"),
        "tmux command": h.tmux.calls.flatMap { $0 }.joined(separator: "\n"),
        "file": files.joined(separator: "\n"),
      ]
      for (surface, text) in surfaces {
        for value in planted { #expect(!text.contains(value), "a planted value reached a \(surface)") }
      }
    }
  }
}
