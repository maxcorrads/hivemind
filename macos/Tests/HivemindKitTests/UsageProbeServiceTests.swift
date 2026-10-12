import Foundation
import Testing
@testable import HivemindKit

// Hivemind Server.app's usage probe (docs/accounts.md, "Usage probe"): one round over a fake server (a fake HTTP that
// answers the instance proof, the accounts and the post), a fake Codex probe that gives the spike 0.3 fixtures, and fake
// Claude files under a fake Mac in the temp dir. The live Codex runner runs a fake `codex` script; no real codex runs.

private let fakeEmail = "fake.person@example.com"
private let fakeMcpValue = "FAKE-MCP-SECRET-VALUE"
private let fakeUUID = "00000000-0000-4000-8000-0000000000aa"
private let fakeKey = "sk-ant-FAKE-0000"
private let fakeToken = "FAKE-ACCESS-TOKEN-0000"

/// The round's clock, and fixture D's `fetchedAtMs` 100 s before it.
private let now = Date(timeIntervalSince1970: 1_791_802_100)
private let nowMs = 1_791_802_100_000
private let fetchedAtMs = 1_791_802_000_000

private let codexPrimary = LaunchAccount(id: "10000000-0000-4000-8000-000000000001", driver: .codex, label: "Codex",
                                         homePath: "", shadowPath: "")
private let codexShadow = LaunchAccount(id: "10000000-0000-4000-8000-000000000002", driver: .codex, label: "Codex personal",
                                        homePath: "", shadowPath: "~/.codex_personal")
private let claudeShadow = LaunchAccount(id: "10000000-0000-4000-8000-000000000003", driver: .claude, label: "Claude work",
                                         homePath: "", shadowPath: "~/.claude-work")
private let claudePrimary = LaunchAccount(id: "10000000-0000-4000-8000-000000000004", driver: .claude, label: "Claude",
                                          homePath: "", shadowPath: "")

/// Spike 0.3's subscriber replies, trimmed: a notification, the rate-limit reply (the main bucket and `codex_other`), then
/// the account reply with an email.
private let subscriberLines = [
  #"{"id":1,"result":{"userAgent":"hivemind_usage_probe/0.162.1","codexHome":"/private/var/folders/xx/T/tmp.FAKE"}}"#,
  #"{"method":"remoteControl/status/changed","params":{"status":"disabled"}}"#,
  #"{"id":3,"result":{"rateLimits":{"limitId":"codex","limitName":null,"primary":{"usedPercent":42,"windowDurationMins":300,"resetsAt":1791820800},"secondary":{"usedPercent":17,"windowDurationMins":10080,"resetsAt":1792252800}},"rateLimitsByLimitId":{"codex_other":{"limitId":"codex_other","limitName":"codex_other","primary":{"usedPercent":88,"windowDurationMins":30,"resetsAt":null},"secondary":null}}}}"#,
  #"{"id":2,"result":{"account":{"type":"chatgpt","email":"\#(fakeEmail)","planType":"plus"}}}"#,
]

private var subscriberWindows: [[String: Any]] { [
  ["key": "codex.primary", "label": "5 h", "usedPercent": 42, "resetsAt": 1_791_820_800_000],
  ["key": "codex.secondary", "label": "Week", "usedPercent": 17, "resetsAt": 1_792_252_800_000],
  ["key": "codex_other.primary", "label": "codex_other 30 min", "usedPercent": 88, "resetsAt": NSNull()],
] }

/// Spike 0.2's fixture A, trimmed: a status line with both windows and the fields around them.
private let statusLine = #"{"session_id":"00000000-0000-4000-8000-000000000001","cwd":"/Users/test/repo","cost":{"total_cost_usd":1.25},"rate_limits":{"five_hour":{"used_percentage":23.5,"resets_at":1791820800},"seven_day":{"used_percentage":41.2,"resets_at":1792252800}}}"#

private var statusWindows: [[String: Any]] { [
  ["key": "five_hour", "label": "Session (5 h)", "usedPercent": 23.5, "resetsAt": 1_791_820_800_000],
  ["key": "seven_day", "label": "Week", "usedPercent": 41.2, "resetsAt": 1_792_252_800_000],
] }

/// A `.claude.json` with spike 0.2's cache D, trimmed, fetched at `fetched`, and a fake email and mcpServers value.
private func claudeJSON(fetched: Int = fetchedAtMs, uuid: String = fakeUUID) -> String {
  #"{"numStartups":3,"oauthAccount":{"accountUuid":"\#(fakeUUID)","emailAddress":"\#(fakeEmail)"},"mcpServers":{"fake":{"command":"fake-mcp","env":{"API_TOKEN":"\#(fakeMcpValue)"}}},"cachedUsageUtilization":{"fetchedAtMs":\#(fetched),"accountUuid":"\#(uuid)","utilization":{"five_hour":{"utilization":23.0,"resets_at":"2026-10-12T16:00:00.000000+00:00"},"seven_day":{"utilization":41.0,"resets_at":"2026-10-16T08:00:00.000000+00:00"},"seven_day_opus":{"utilization":12.0,"resets_at":"2026-10-16T08:00:00.000000+00:00"},"seven_day_sonnet":null}}}"#
}

private var cacheWindows: [[String: Any]] { [
  ["key": "five_hour", "label": "Session (5 h)", "usedPercent": 23, "resetsAt": 1_791_820_800_000],
  ["key": "seven_day", "label": "Week", "usedPercent": 41, "resetsAt": 1_792_137_600_000],
  ["key": "seven_day_opus", "label": "Opus (week)", "usedPercent": 12, "resetsAt": 1_792_137_600_000],
] }

/// The server: its instance proof, `GET /api/launcher/accounts` and `POST /api/launcher/usage`.
private actor UsageHTTPFake: LauncherHTTP {
  let secret: InstanceSecret
  var accounts: [LaunchAccount]
  var postStatus = 200
  var validProof = true
  var requests: [URLRequest] = []

  init(secret: InstanceSecret, accounts: [LaunchAccount]) {
    self.secret = secret; self.accounts = accounts
  }

  func send(_ request: URLRequest) async throws -> (status: Int, body: Data) {
    requests.append(request)
    let url = request.url!
    if url.path == "/api/health/instance" {
      let nonce = InstanceNonce(hex: URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!.first!.value!)!
      let proof = validProof ? InstanceProof.proof(secret: secret, nonce: nonce, port: ServerPort(url.port!)!) : String(repeating: "0", count: 64)
      return (200, Data("{\"proof\":\"\(proof)\"}".utf8))
    }
    if url.path == "/api/launcher/accounts" { return (200, try JSONEncoder().encode(["accounts": accounts])) }
    if url.path == "/api/launcher/usage" { return (postStatus, Data("{\"ok\":true}".utf8)) }
    return (404, Data())
  }

  func recorded() -> [URLRequest] { requests }
  func invalidateProof() { validProof = false }

  /// The body of each usage post, in order.
  func postBodies() -> [Data] {
    requests.filter { $0.url?.path == "/api/launcher/usage" }.map { $0.httpBody ?? Data() }
  }

  /// Every post body, as text.
  func postedText() -> String {
    requests.filter { $0.url?.path == "/api/launcher/usage" }.map { String(decoding: $0.httpBody ?? Data(), as: UTF8.self) }.joined()
  }
}

/// `codex app-server`: each probe takes the next of `responses` (the last one again when they run out).
@MainActor private final class CodexProbeFake: CodexProbeRunning {
  var responses: [[String]]
  var calls: [(set: [String], unset: [String])] = []

  init(_ responses: [[String]]) { self.responses = responses }

  func probe(set: [(name: String, value: String)], unset: [String]) async -> [String] {
    calls.append((set.map { "\($0.name)=\($0.value)" }, unset))
    return responses.count > 1 ? responses.removeFirst() : responses.first ?? []
  }
}

/// What the service tells the broker.
@MainActor private final class AccountsRecorder {
  var calls: [[LaunchAccount]] = []
}

/// A fake Mac under a fresh temp folder: its home, and the tap's folder in its Application Support.
private struct FakeMac {
  let root: URL
  var home: String { root.appendingPathComponent("home").path }
  var tap: ClaudeStatusTap { ClaudeStatusTap(folder: HivemindPaths(home: URL(fileURLWithPath: home)).accounts) }

  /// Writes `text` at `path` (relative to the home), creating its folder, modified at `modified` when given.
  func write(_ text: String, at path: String, modified: Date? = nil) throws {
    let url = URL(fileURLWithPath: home).appendingPathComponent(path)
    try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data(text.utf8).write(to: url)
    if let modified { try FileManager.default.setAttributes([.modificationDate: modified], ofItemAtPath: url.path) }
  }

  /// The tap's file `name` of `account`, relative to the home.
  func tapFile(_ account: LaunchAccount, _ name: String) -> String {
    String(tap.accountFolder(account.id)!.appendingPathComponent(name).path.dropFirst(home.count + 1))
  }
}

@MainActor private func withFakeMac(_ body: @MainActor (FakeMac) async throws -> Void) async throws {
  let root = try temporaryHome()
  defer { try? FileManager.default.removeItem(at: root) }
  let mac = FakeMac(root: root)
  try FileManager.default.createDirectory(atPath: mac.home, withIntermediateDirectories: true)
  try await body(mac)
}

/// The snapshots of each usage post `http` took, in order.
private func posts(_ http: UsageHTTPFake) async throws -> [NSArray] {
  try await http.postBodies().map { body in
    let json = try #require(try JSONSerialization.jsonObject(with: body) as? NSDictionary)
    return try #require(json["snapshots"] as? NSArray)
  }
}

/// A snapshot as the post carries it.
private func snapshot(_ account: LaunchAccount, at capturedAt: Int = nowMs, plan: String = "subscription",
                      windows: [[String: Any]] = [], error: String? = nil, limitErrorAt: Int? = nil) -> NSDictionary {
  ["accountId": account.id, "capturedAt": capturedAt, "source": account.driver.rawValue, "plan": plan,
   "windows": windows, "error": error ?? NSNull(), "limitErrorAt": limitErrorAt ?? NSNull()]
}

@Suite("Usage probe")
@MainActor struct UsageProbeServiceTests {
  let secret = InstanceSecret.generate()

  private func service(_ mac: FakeMac, http: UsageHTTPFake, codex: CodexProbeFake, shadowHomes: FakeShadowHomes = FakeShadowHomes(),
                       onAccounts: @escaping @MainActor ([LaunchAccount]) -> Void = { _ in }) -> UsageProbeService {
    UsageProbeService(server: { [secret] in .init(endpoint: ServerEndpoint(port: ServerPort(7520)!), secret: secret) },
                      http: http, codex: codex, shadowHomes: shadowHomes, tap: mac.tap, home: mac.home, now: { now },
                      onAccounts: onAccounts)
  }

  @Test func aRoundReadsEveryAccountInCatalogOrderAndPostsTheirSnapshotsSigned() async throws {
    try await withFakeMac { mac in
      let accounts = [codexPrimary, codexShadow, claudeShadow, claudePrimary]
      let http = UsageHTTPFake(secret: secret, accounts: accounts)
      let codex = CodexProbeFake([subscriberLines])
      let shadowHomes = FakeShadowHomes()
      let told = AccountsRecorder()
      try mac.write(statusLine, at: mac.tapFile(claudeShadow, "statusline.json"), modified: now.addingTimeInterval(-60))
      try mac.write("1791801000\n", at: mac.tapFile(claudeShadow, "limit-error"))
      try mac.write(claudeJSON(), at: ".claude.json")
      try await service(mac, http: http, codex: codex, shadowHomes: shadowHomes, onAccounts: { told.calls.append($0) }).refreshOnce()

      let posts = try await posts(http)
      #expect(posts.count == 1)
      #expect(posts.first == [
        snapshot(codexPrimary, windows: subscriberWindows),
        snapshot(codexShadow, windows: subscriberWindows),
        snapshot(claudeShadow, at: nowMs - 60_000, windows: statusWindows, limitErrorAt: 1_791_801_000_000),
        snapshot(claudePrimary, at: fetchedAtMs, windows: cacheWindows),
      ] as NSArray)
      // Only the account's variables are set, and the other controlled names unset, as a launch's are.
      #expect(codex.calls.map(\.set) == [[], ["CODEX_HOME=\(mac.home)/.codex_personal", "CODEX_SQLITE_HOME=\(mac.home)/.codex"]])
      #expect(codex.calls.map(\.unset) == [["CODEX_HOME", "CODEX_SQLITE_HOME", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"],
                                           ["CODEX_API_KEY", "CODEX_ACCESS_TOKEN"]])
      #expect(shadowHomes.prepared.map(\.account) == [codexShadow], "only a Codex shadow is prepared, as before a launch")
      #expect(shadowHomes.prepared.map(\.home) == [mac.home])
      #expect(told.calls == [[claudeShadow, claudePrimary]], "the broker learns the catalog's Claude accounts")
      let requests = await http.recorded()
      #expect(requests.map { "\($0.httpMethod ?? "") \($0.url!.path)" }
        == ["GET /api/health/instance", "GET /api/launcher/accounts", "GET /api/health/instance", "POST /api/launcher/usage"])
      for request in requests where request.url!.path.hasPrefix("/api/launcher/") {
        #expect(request.value(forHTTPHeaderField: "X-Hivemind-Signature")?.count == 64)
      }
      let text = await http.postedText()
      for secret in [fakeEmail, fakeMcpValue, fakeUUID, "API_TOKEN", "fake-mcp", "tmp.FAKE"] { #expect(!text.contains(secret)) }
    }
  }

  @Test func errorsAreFixedMessagesAndNeverTheProbesOutput() async throws {
    try await withFakeMac { mac in
      let notLoggedIn = [#"{"id":3,"error":{"code":-32600,"message":"codex account authentication required to read rate limits"}}"#]
      let failed = [#"{"id":3,"error":{"code":-32603,"message":"failed to fetch codex rate limits: \#(fakeToken) \#(fakeKey)"}}"#,
                    "codex: \(fakeEmail) \(fakeKey)"]
      let apiKey = [#"{"id":3,"error":{"code":-32600,"message":"chatgpt authentication required to read rate limits"}}"#]
      let codexWork = LaunchAccount(id: "10000000-0000-4000-8000-000000000005", driver: .codex, label: "Codex work",
                                    homePath: "~/.codex-work", shadowPath: "")
      let codexKey = LaunchAccount(id: "10000000-0000-4000-8000-000000000006", driver: .codex, label: "Codex key",
                                   homePath: "~/.codex-key", shadowPath: "")
      let http = UsageHTTPFake(secret: secret, accounts: [codexPrimary, codexWork, codexShadow, codexKey, claudeShadow, claudePrimary])
      let codex = CodexProbeFake([notLoggedIn, failed, apiKey])
      let shadowHomes = FakeShadowHomes()
      shadowHomes.failure = "`\(mac.home)/.codex_personal` has no login yet. Run `codex login` to log in."
      // A cache that is not the login's, and a limit error with no usage data.
      try mac.write(claudeJSON(uuid: "00000000-0000-4000-8000-0000000000bb"), at: ".claude.json")
      try mac.write("1791801000\n", at: mac.tapFile(claudePrimary, "limit-error"))
      try await service(mac, http: http, codex: codex, shadowHomes: shadowHomes).refreshOnce()

      let posts = try await posts(http)
      #expect(posts.first == [
        snapshot(codexPrimary, plan: "unknown", error: "Not logged in"),
        snapshot(codexWork, plan: "unknown", error: "Usage read failed"),
        snapshot(codexShadow, plan: "unknown", error: UsageProbeService.shadowNotReady),
        snapshot(codexKey, plan: "api-key"),
        snapshot(claudeShadow, plan: "unknown", error: UsageProbeService.noClaudeData),
        snapshot(claudePrimary, plan: "unknown", error: UsageProbeService.noClaudeData, limitErrorAt: 1_791_801_000_000),
      ] as NSArray)
      #expect(codex.calls.count == 3, "a shadow that cannot be prepared runs no probe")
      let text = await http.postedText()
      for secret in [fakeEmail, fakeKey, fakeToken, fakeMcpValue, "codex_personal", "no login yet"] { #expect(!text.contains(secret)) }
      for message in [UsageProbeService.shadowNotReady, UsageProbeService.noClaudeData] { #expect(message.count <= 200) }
    }
  }

  @Test func theStatusLineWinsWhenItIsNewerThanTheLastSnapshotElseTheNewerSourceThatIsNotOlder() async throws {
    try await withFakeMac { mac in
      let http = UsageHTTPFake(secret: secret, accounts: [claudeShadow])
      let sut = service(mac, http: http, codex: CodexProbeFake([]))
      let status = mac.tapFile(claudeShadow, "statusline.json"), cache = ".claude-work/.claude.json"
      func round() async throws -> NSDictionary? {
        try await sut.refreshOnce()
        return try await posts(http).last?.firstObject as? NSDictionary
      }

      try mac.write(statusLine, at: status, modified: now.addingTimeInterval(-120))
      try mac.write(claudeJSON(fetched: nowMs - 300_000), at: cache)
      #expect(try await round() == snapshot(claudeShadow, at: nowMs - 120_000, windows: statusWindows), "no snapshot yet: the status line")
      #expect(try await round() == snapshot(claudeShadow, at: nowMs - 120_000, windows: statusWindows),
              "unchanged, and the cache is older: the same status line again")
      try mac.write(claudeJSON(fetched: nowMs - 30_000), at: cache)
      #expect(try await round() == snapshot(claudeShadow, at: nowMs - 30_000, windows: cacheWindows), "the cache is newer")
      try mac.write(statusLine, at: status, modified: now.addingTimeInterval(-10))
      #expect(try await round() == snapshot(claudeShadow, at: nowMs - 10_000, windows: statusWindows), "the status line is newer again")
      try mac.write(statusLine, at: status, modified: now.addingTimeInterval(-60))
      #expect(try await round() == snapshot(claudeShadow, plan: "unknown", error: UsageProbeService.noClaudeData),
              "both older than the last snapshot: never back in time")
      try mac.write(statusLine, at: status, modified: now.addingTimeInterval(-5))
      try mac.write(claudeJSON(fetched: nowMs - 2 * 3_600_000), at: cache)
      #expect(try await round() == snapshot(claudeShadow, at: nowMs - 5_000, windows: statusWindows))
    }
  }

  @Test func beforeTheFirstSnapshotTheNewerSourceIsUsed() async throws {
    try await withFakeMac { mac in
      let http = UsageHTTPFake(secret: secret, accounts: [claudeShadow])
      // After a restart: yesterday's status line, and a cache Claude fetched 100 s ago.
      try mac.write(statusLine, at: mac.tapFile(claudeShadow, "statusline.json"), modified: now.addingTimeInterval(-86_400))
      try mac.write(claudeJSON(), at: ".claude-work/.claude.json")
      try await service(mac, http: http, codex: CodexProbeFake([])).refreshOnce()
      #expect(try await posts(http).first == [snapshot(claudeShadow, at: fetchedAtMs, windows: cacheWindows)] as NSArray)
    }
  }

  @Test func aStatusLineWithoutRateLimitsFallsBackToTheCache() async throws {
    try await withFakeMac { mac in
      let http = UsageHTTPFake(secret: secret, accounts: [claudeShadow])
      // Spike 0.2's fixture C: before the first API response, or an API key.
      try mac.write(#"{"session_id":"00000000-0000-4000-8000-000000000002","cwd":"/Users/test/repo"}"#,
                    at: mac.tapFile(claudeShadow, "statusline.json"), modified: now)
      try mac.write(claudeJSON(), at: ".claude-work/.claude.json")
      try await service(mac, http: http, codex: CodexProbeFake([])).refreshOnce()
      #expect(try await posts(http).first == [snapshot(claudeShadow, at: fetchedAtMs, windows: cacheWindows)] as NSArray)
    }
  }

  @Test func anUnverifiedServerIsNotAskedForItsAccountsAndAFailedPostThrows() async throws {
    try await withFakeMac { mac in
      let http = UsageHTTPFake(secret: secret, accounts: [codexPrimary])
      let codex = CodexProbeFake([subscriberLines])
      await http.invalidateProof()
      await #expect(throws: BrokerFiles.Failure.self) { try await service(mac, http: http, codex: codex).refreshOnce() }
      #expect(await http.recorded().map { $0.url!.path } == ["/api/health/instance"])
      #expect(codex.calls.isEmpty)

      let other = UsageHTTPFake(secret: secret, accounts: [codexPrimary])
      await other.setPostStatus(404)
      await #expect(throws: BrokerFiles.Failure.self) { try await service(mac, http: other, codex: codex).refreshOnce() }
    }
  }

  @Test func aSnapshotSendsEveryKeyAndOnlyTheWindowsTheSchemaTakes() throws {
    let windows = (0..<10).map { UsageWindow(key: "w\($0)", label: "W \($0)", usedPercent: 1, resetsAt: nil) }
      + [UsageWindow(key: String(repeating: "k", count: 65), label: "Long", usedPercent: 1, resetsAt: nil)]
    let fitting = UsageSnapshot(accountId: "a1", capturedAt: 1, source: .claude, plan: "subscription",
                                windows: [UsageWindow(key: "w0", label: "Again", usedPercent: 1, resetsAt: 5)]
                                  + [windows[10]] + windows)
    #expect(fitting.windows.map(\.key) == ["w0", "w1", "w2", "w3", "w4", "w5", "w6", "w7"], "a long key and a repeat are left out")
    #expect(fitting.windows.first?.label == "Again")
    let json = try #require(try JSONSerialization.jsonObject(with: JSONEncoder().encode(fitting)) as? NSDictionary)
    #expect(Set(json.allKeys as? [String] ?? []) == ["accountId", "capturedAt", "source", "plan", "windows", "error", "limitErrorAt"])
    #expect(json["error"] is NSNull && json["limitErrorAt"] is NSNull)
    #expect((json["windows"] as? [NSDictionary])?[1] == ["key": "w1", "label": "W 1", "usedPercent": 1, "resetsAt": NSNull()])
  }
}

extension UsageHTTPFake {
  func setPostStatus(_ status: Int) { postStatus = status }
}

// MARK: - The live Codex runner

/// A fake `codex`: its first line names its pid, its argument and the variables a probe controls; it answers
/// `initialize` and `account/read` at once and `account/rateLimits/read` 0.3 s later, unless FAKE_SILENT is set. With
/// FAKE_LATE_ACCOUNT it answers `account/read` 0.6 s later, after reply 3, as spike 0.3's fixture does. Like codex, it
/// drops a pending reply when its stdin closes. With FAKE_SILENT it never answers 3 and outlives its stdin.
private let fakeCodex = #"""
  #!/bin/sh
  printf '{"method":"fake/env","params":{"pid":%s,"argument":"%s","home":"%s","sqlite":"%s","key":"%s","token":"%s"}}\n' \
    "$$" "$1" "${CODEX_HOME-unset}" "${CODEX_SQLITE_HOME-unset}" "${CODEX_API_KEY-unset}" "${CODEX_ACCESS_TOKEN-unset}"
  account='{"id":2,"result":{"account":{"type":"chatgpt","email":"fake.person@example.com"}}}'
  pending=
  while IFS= read -r line; do
    case $line in
      *'"id":1,'*) echo '{"id":1,"result":{}}' ;;
      *'"id":2,'*) if [ -n "$FAKE_LATE_ACCOUNT" ]; then (sleep 0.6; echo "$account") & pending="$pending $!"; else echo "$account"; fi ;;
      *'"id":3,'*) [ -n "$FAKE_SILENT" ] || { (sleep 0.3; echo '{"id":3,"result":{"rateLimits":{"limitId":"codex","primary":{"usedPercent":42,"windowDurationMins":300,"resetsAt":1791820800},"secondary":null}}}') & pending="$pending $!"; } ;;
    esac
  done
  [ -n "$pending" ] && kill $pending 2>/dev/null
  [ -n "$FAKE_SILENT" ] && while :; do sleep 0.1; done
  exit 0

  """#

@Suite("Codex app-server probe")
@MainActor struct CodexAppServerProbeTests {
  /// A fake Mac whose `~/.zshrc` exports the variables the probe controls, and a fake codex at a path with a space.
  private func fakeMac() throws -> (root: URL, home: String, codex: String) {
    let root = try temporaryHome().resolvingSymlinksInPath()
    let home = root.appendingPathComponent("home").path
    try FileManager.default.createDirectory(atPath: home, withIntermediateDirectories: true)
    try Data("export CODEX_HOME=/wrong CODEX_API_KEY=\(fakeKey)\n".utf8).write(to: URL(fileURLWithPath: home + "/.zshrc"))
    let codex = root.appendingPathComponent("fake codex").path
    try Data(fakeCodex.utf8).write(to: URL(fileURLWithPath: codex))
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: codex)
    return (root, home, codex)
  }

  private func environmentLine(_ lines: [String]) throws -> [String: Any] {
    let line = try #require(lines.first { $0.contains("fake/env") })
    let json = try #require(try JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])
    return try #require(json["params"] as? [String: Any])
  }

  @Test func theLoginShellSetsOnlyTheAccountsVariablesAfterItsStartupFilesAndStdinStaysOpenUntilReply3() async throws {
    let (root, home, codex) = try fakeMac()
    defer { try? FileManager.default.removeItem(at: root) }
    let probe = CodexAppServerProbe(codex: codex, environment: ["PATH": "/usr/bin:/bin", "HOME": home, "CODEX_ACCESS_TOKEN": fakeToken],
                                    directory: home)
    let started = Date()
    let lines = await probe.probe(set: [("CODEX_HOME", root.path + "/shadow's"), ("CODEX_SQLITE_HOME", home + "/.codex")],
                                  unset: ["CODEX_API_KEY", "CODEX_ACCESS_TOKEN"])
    #expect(Date().timeIntervalSince(started) < 10)
    let environment = try environmentLine(lines)
    #expect(environment["argument"] as? String == "app-server")
    #expect(environment["home"] as? String == root.path + "/shadow's", "set after ~/.zshrc, quoted")
    #expect(environment["sqlite"] as? String == home + "/.codex")
    #expect(environment["key"] as? String == "unset", "unset after ~/.zshrc exported it")
    #expect(environment["token"] as? String == "unset", "the app's own is removed too")
    #expect(CodexUsage.parseCodexProbe(lines: lines) == .success(CodexUsageProbe(plan: "subscription", windows: [
      UsageWindow(key: "codex.primary", label: "5 h", usedPercent: 42, resetsAt: 1_791_820_800_000),
    ])), "the delayed reply 3 arrived: stdin was still open")
  }

  @Test func anAccountReplyAfterTheRateLimitReplyIsStillRead() async throws {
    let (root, home, codex) = try fakeMac()
    defer { try? FileManager.default.removeItem(at: root) }
    let probe = CodexAppServerProbe(codex: codex, environment: ["PATH": "/usr/bin:/bin", "HOME": home, "FAKE_LATE_ACCOUNT": "1"],
                                    directory: home)
    let lines = await probe.probe(set: [], unset: [])
    #expect(CodexUsage.parseCodexProbe(lines: lines) == .success(CodexUsageProbe(plan: "subscription", windows: [
      UsageWindow(key: "codex.primary", label: "5 h", usedPercent: 42, resetsAt: 1_791_820_800_000),
    ])), "stdin stayed open after reply 3 until reply 2 arrived")
  }

  @Test func withoutReply3TheProbeEndsAtItsTimeoutAndCodexIsEnded() async throws {
    let (root, home, codex) = try fakeMac()
    defer { try? FileManager.default.removeItem(at: root) }
    let probe = CodexAppServerProbe(codex: codex, environment: ["PATH": "/usr/bin:/bin", "HOME": home, "FAKE_SILENT": "1"],
                                    directory: home, timeout: 0.5)
    let started = Date()
    let lines = await probe.probe(set: [], unset: [])
    #expect(Date().timeIntervalSince(started) < 10)
    #expect(CodexUsage.parseCodexProbe(lines: lines) == .failure(.readFailed))
    let pid = try #require(try environmentLine(lines)["pid"] as? Int)
    #expect(kill(Int32(pid), 0) == -1 && errno == ESRCH, "codex outlived its stdin, so it was ended")
  }

  @Test func aCodexThatCannotRunOrExitsAtOnceGivesNoLinesAtOnce() async throws {
    let root = try temporaryHome()
    defer { try? FileManager.default.removeItem(at: root) }
    let missing = CodexAppServerProbe(shell: [root.path + "/no-shell", "-c"], environment: [:], directory: root.path)
    #expect(await missing.probe(set: [], unset: []) == [])
    let started = Date()
    let exits = CodexAppServerProbe(shell: ["/bin/sh", "-c"], codex: "/usr/bin/true", environment: [:], directory: root.path)
    #expect(await exits.probe(set: [], unset: []) == [])
    #expect(Date().timeIntervalSince(started) < 5, "the end of its output ends the probe, not the 20 s timeout")
  }

  @Test func theScriptQuotesEveryValueAndExecsCodexUnaliased() {
    #expect(CodexAppServerProbe.script(codex: "codex", set: [("CODEX_HOME", "/Users/a/it's")], unset: ["CODEX_API_KEY", "CODEX_ACCESS_TOKEN"])
      == "builtin export CODEX_HOME='/Users/a/it'\\''s'\nbuiltin unset -v CODEX_API_KEY CODEX_ACCESS_TOKEN\nexec 'codex' app-server")
    #expect(CodexAppServerProbe.script(codex: "codex", set: [], unset: []) == "exec 'codex' app-server")
  }
}
