import Foundation
import Testing
@testable import HivemindKit

// The Claude usage parsers (docs/accounts.md, "Usage") over the fixtures of spike 0.2 (#320): status-line payloads A–C
// and the cache D, plus a `.claude.json` with fake mcpServers values and a fake oauthAccount email. Fake values only;
// pure data, no file.

/// Fixture A: a subscription's status line, with both windows and an extra field.
private let statusA = #"""
{"session_id":"00000000-0000-4000-8000-000000000001","transcript_path":"/Users/test/shadows/claude-work/projects/-Users-test-repo/00000000-0000-4000-8000-000000000001.jsonl","cwd":"/Users/test/repo","model":{"id":"claude-opus-5-5","display_name":"Opus 5.5"},"workspace":{"current_dir":"/Users/test/repo","project_dir":"/Users/test/repo","added_dirs":[]},"version":"2.1.296","output_style":{"name":"default"},"cost":{"total_cost_usd":1.25,"total_duration_ms":120000,"total_api_duration_ms":30000,"total_lines_added":10,"total_lines_removed":2},"context_window":{"total_input_tokens":15500,"total_output_tokens":1200,"context_window_size":1000000,"current_usage":{"input_tokens":8500,"output_tokens":1200,"cache_creation_input_tokens":5000,"cache_read_input_tokens":2000},"used_percentage":2,"remaining_percentage":98},"exceeds_200k_tokens":false,"fast_mode":false,"effort":{"level":"medium"},"thinking":{"enabled":true},"rate_limits":{"five_hour":{"used_percentage":23.5,"resets_at":1791820800},"seven_day":{"used_percentage":41.2,"resets_at":1792252800}},"future_field":{"x":1}}
"""#

/// Fixture B: fixture A with only `seven_day`, at 100 %.
private let statusB = statusA.replacingOccurrences(
  of: #""rate_limits":{"five_hour":{"used_percentage":23.5,"resets_at":1791820800},"seven_day":{"used_percentage":41.2,"resets_at":1792252800}}"#,
  with: #""rate_limits":{"seven_day":{"used_percentage":100.0,"resets_at":1792252800}}"#)

/// Fixture C: a session before its first API response, which has no `rate_limits` (the 2.1.296 shape).
private let statusC = #"""
{"session_id":"00000000-0000-4000-8000-000000000002","transcript_path":"/Users/test/shadows/claude-key/projects/-Users-test-repo/00000000-0000-4000-8000-000000000002.jsonl","cwd":"/Users/test/repo","effort":{"level":"medium"},"model":{"id":"claude-opus-5-5","display_name":"Opus 5.5"},"workspace":{"current_dir":"/Users/test/repo","project_dir":"/Users/test/repo","added_dirs":[]},"version":"2.1.296","output_style":{"name":"default"},"cost":{"total_cost_usd":0,"total_duration_ms":395,"total_api_duration_ms":0,"total_lines_added":0,"total_lines_removed":0},"context_window":{"total_input_tokens":0,"total_output_tokens":0,"context_window_size":1000000,"current_usage":null,"used_percentage":null,"remaining_percentage":null},"exceeds_200k_tokens":false,"fast_mode":false,"thinking":{"enabled":true}}
"""#

/// Fixture D: `cachedUsageUtilization` in `.claude.json`, with model windows, a null entry, a codename, `extra_usage` and
/// `limits` (none of which is a window the parser reads).
private let cacheD = #"""
{"fetchedAtMs":1791802000000,"accountUuid":"00000000-0000-4000-8000-0000000000aa","utilization":{"five_hour":{"utilization":23.0,"resets_at":"2026-10-12T16:00:00.000000+00:00"},"seven_day":{"utilization":41.0,"resets_at":"2026-10-16T08:00:00.000000+00:00"},"seven_day_opus":{"utilization":12.0,"resets_at":"2026-10-16T08:00:00.000000+00:00"},"seven_day_sonnet":null,"some_codename":{"utilization":5.0,"resets_at":null},"extra_usage":{"is_enabled":false,"monthly_limit":null,"used_credits":null,"utilization":null,"currency":"USD"}},"limits":[{"kind":"session","group":"plan","percent":23,"severity":"normal","resets_at":"2026-10-12T16:00:00Z","is_active":true},{"kind":"weekly","group":"model","percent":12,"severity":"normal","resets_at":"2026-10-16T08:00:00Z","scope":{"model":{"display_name":"Opus"}}}]}
"""#

private let fakeUUID = "00000000-0000-4000-8000-0000000000aa"
private let fakeEmail = "fake.person@example.com"
private let fakeMcpValue = "FAKE-MCP-SECRET-VALUE"
private let fetchedAtMs = 1_791_802_000_000

/// A `.claude.json` with a fake mcpServers value and a fake oauthAccount email around `cache`.
private func claudeJSON(uuid: String = fakeUUID, cache: String = cacheD) -> String {
  #"{"numStartups":3,"oauthAccount":{"accountUuid":"\#(uuid)","emailAddress":"\#(fakeEmail)"},"mcpServers":{"fake":{"command":"fake-mcp","env":{"API_TOKEN":"\#(fakeMcpValue)"}}},"cachedUsageUtilization":\#(cache)}"#
}

/// `ms` after the Unix epoch.
private func date(ms: Int) -> Date {
  Date(timeIntervalSince1970: Double(ms) / 1000)
}

struct ClaudeUsageTests {
  @Test func statusLineKeepsBothWindowsAndIgnoresOtherFields() {
    #expect(ClaudeUsage.parseStatusLine(Data(statusA.utf8)) == [
      UsageWindow(key: "five_hour", label: "Session (5 h)", usedPercent: 23.5, resetsAt: 1_791_820_800_000),
      UsageWindow(key: "seven_day", label: "Week", usedPercent: 41.2, resetsAt: 1_792_252_800_000),
    ])
  }

  @Test func statusLineWithOnlySevenDayKeepsThatWindow() {
    #expect(statusB != statusA, "fixture B is derived from A")
    #expect(ClaudeUsage.parseStatusLine(Data(statusB.utf8)) == [
      UsageWindow(key: "seven_day", label: "Week", usedPercent: 100, resetsAt: 1_792_252_800_000),
    ])
  }

  @Test func statusLineWithoutRateLimitsIsNil() {
    #expect(ClaudeUsage.parseStatusLine(Data(statusC.utf8)) == nil)
  }

  @Test func statusLineClampsPercentAndKeepsAMissingResetAsNil() {
    let json = #"{"rate_limits":{"five_hour":{"used_percentage":140,"resets_at":null},"seven_day":{"used_percentage":-3,"resets_at":1792252800},"seven_day_opus":{"used_percentage":9,"resets_at":1792252800}}}"#
    #expect(ClaudeUsage.parseStatusLine(Data(json.utf8)) == [
      UsageWindow(key: "five_hour", label: "Session (5 h)", usedPercent: 100, resetsAt: nil),
      UsageWindow(key: "seven_day", label: "Week", usedPercent: 0, resetsAt: 1_792_252_800_000),
    ])
  }

  @Test func statusLineLeavesOutAWindowWithoutAPercentage() {
    let json = #"{"rate_limits":{"five_hour":{"resets_at":1791820800},"seven_day":{"used_percentage":41.2,"resets_at":1792252800}}}"#
    #expect(ClaudeUsage.parseStatusLine(Data(json.utf8)) == [
      UsageWindow(key: "seven_day", label: "Week", usedPercent: 41.2, resetsAt: 1_792_252_800_000),
    ])
  }

  @Test func cacheOfTheSameAccountGivesItsWindowsSortedByKey() {
    let windows = ClaudeUsage.parseUsageCache(claudeJSON: Data(claudeJSON().utf8), now: date(ms: fetchedAtMs + 1_800_000))
    #expect(windows == [
      UsageWindow(key: "five_hour", label: "Session (5 h)", usedPercent: 23, resetsAt: 1_791_820_800_000),
      UsageWindow(key: "seven_day", label: "Week", usedPercent: 41, resetsAt: 1_792_137_600_000),
      UsageWindow(key: "seven_day_opus", label: "Opus (week)", usedPercent: 12, resetsAt: 1_792_137_600_000),
    ])
  }

  @Test func cacheAsTheSpikeQuotedItWithLimitsInsideUtilizationGivesTheSameWindows() {
    let verbatim = cacheD.replacingOccurrences(of: #""currency":"USD"}},"limits""#, with: #""currency":"USD"},"limits""#) + "}"
    #expect(verbatim != cacheD + "}", "the spike's text nests limits in utilization")
    let now = date(ms: fetchedAtMs)
    let windows = ClaudeUsage.parseUsageCache(claudeJSON: Data(claudeJSON(cache: verbatim).utf8), now: now)
    #expect(windows != nil)
    #expect(windows == ClaudeUsage.parseUsageCache(claudeJSON: Data(claudeJSON().utf8), now: now))
  }

  @Test func cacheOfAnotherAccountOrWithoutAnAccountIsNil() {
    let now = date(ms: fetchedAtMs + 1_800_000)
    #expect(ClaudeUsage.parseUsageCache(claudeJSON: Data(claudeJSON(uuid: "00000000-0000-4000-8000-0000000000bb").utf8), now: now) == nil)
    let noAccount = #"{"cachedUsageUtilization":\#(cacheD)}"#
    #expect(ClaudeUsage.parseUsageCache(claudeJSON: Data(noAccount.utf8), now: now) == nil)
  }

  @Test func cacheOlderThanAnHourIsNil() {
    let data = Data(claudeJSON().utf8)
    #expect(ClaudeUsage.parseUsageCache(claudeJSON: data, now: date(ms: fetchedAtMs + 3_600_000)) != nil, "an hour old still counts")
    #expect(ClaudeUsage.parseUsageCache(claudeJSON: data, now: date(ms: fetchedAtMs + 3_600_001)) == nil)
  }

  @Test func cacheClampsPercentAndReadsZuluTimes() {
    let cache = #"{"fetchedAtMs":\#(fetchedAtMs),"accountUuid":"\#(fakeUUID)","utilization":{"five_hour":{"utilization":120,"resets_at":"2026-10-16T08:00:00Z"},"seven_day_sonnet":{"utilization":-1,"resets_at":null}}}"#
    #expect(ClaudeUsage.parseUsageCache(claudeJSON: Data(claudeJSON(cache: cache).utf8), now: date(ms: fetchedAtMs)) == [
      UsageWindow(key: "five_hour", label: "Session (5 h)", usedPercent: 100, resetsAt: 1_792_137_600_000),
      UsageWindow(key: "seven_day_sonnet", label: "Sonnet (week)", usedPercent: 0, resetsAt: nil),
    ])
  }

  @Test func parsedWindowsHoldNoEmailMcpValueOrUuid() throws {
    let windows = try #require(ClaudeUsage.parseUsageCache(claudeJSON: Data(claudeJSON().utf8), now: date(ms: fetchedAtMs)))
    let output = String(describing: windows)
    #expect(!windows.isEmpty)
    for secret in [fakeEmail, fakeMcpValue, fakeUUID, "mcpServers", "oauthAccount"] {
      #expect(!output.contains(secret), "\(secret) reached the parsed windows")
    }
  }
}
