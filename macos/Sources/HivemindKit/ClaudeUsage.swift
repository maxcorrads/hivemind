import Foundation

// Claude's quota windows from the two quota-free sources (docs/accounts.md, "Usage"): the status-line payload that the
// tap records, and the undocumented `cachedUsageUtilization` in `<configDir>/.claude.json`. Pure parsers over bytes the
// caller has read: no file and no process here, and the clock is passed in. Only `rate_limits`, `cachedUsageUtilization`
// and `oauthAccount.accountUuid` are decoded, so the rest of `.claude.json` (mcpServers, the email) is never stored.

/// One quota window as the snapshot carries it (src/shared/accounts.ts, usageWindowSchema). `key` is stable within a
/// source; `usedPercent` is used, not remaining; `resetsAt` is Unix ms, nil when the provider gives no reset time.
public struct UsageWindow: Equatable, Sendable {
  public let key: String
  public let label: String
  public let usedPercent: Double
  public let resetsAt: Int?

  public init(key: String, label: String, usedPercent: Double, resetsAt: Int?) {
    self.key = key
    self.label = label
    self.usedPercent = usedPercent
    self.resetsAt = resetsAt
  }
}

public enum ClaudeUsage {
  /// The cache is read only while Claude itself trusts it: at most an hour after `fetchedAtMs`.
  static let maxCacheAgeMs = 60.0 * 60 * 1000

  /// The windows of a status-line payload: `rate_limits.five_hour` and `rate_limits.seven_day`, in that order. Nil when
  /// the payload has no `rate_limits`, as for an API-key login or a session before its first API response. A window
  /// without a `used_percentage` number is left out; every other field is ignored.
  public static func parseStatusLine(_ data: Data) -> [UsageWindow]? {
    guard let status = try? JSONDecoder().decode(StatusLine.self, from: data), let limits = status.rateLimits else { return nil }
    return ["five_hour", "seven_day"].compactMap { key in
      guard let window = limits[key]?.value, let used = window.usedPercentage, let label = windowLabel(key) else { return nil }
      return UsageWindow(key: key, label: label, usedPercent: clamped(used), resetsAt: window.resetsAt.flatMap(unixMilliseconds))
    }
  }

  /// The windows of `cachedUsageUtilization` in `<configDir>/.claude.json`, sorted by key, or nil unless its `accountUuid`
  /// equals the `oauthAccount.accountUuid` of the same file and it was fetched at most an hour before `now`. A null entry,
  /// a key that is not a quota window and an entry without a number are left out.
  public static func parseUsageCache(claudeJSON: Data, now: Date) -> [UsageWindow]? {
    readUsageCache(claudeJSON: claudeJSON, now: now)?.windows
  }

  /// parseUsageCache, with the cache's `fetchedAtMs`: the time its windows were true, which the usage probe sends as the
  /// snapshot's capture time so that the stale rule counts from it. Nil also for a `fetchedAtMs` before 1970 or past year
  /// 33658.
  public static func readUsageCache(claudeJSON: Data, now: Date) -> (fetchedAtMs: Int, windows: [UsageWindow])? {
    guard let root = try? JSONDecoder().decode(ClaudeJSON.self, from: claudeJSON), let cache = root.cachedUsageUtilization,
          cache.accountUuid == root.oauthAccount?.accountUuid, (0...1e15).contains(cache.fetchedAtMs),
          now.timeIntervalSince1970 * 1000 - cache.fetchedAtMs <= maxCacheAgeMs else { return nil }
    let windows = cache.utilization.compactMap { key, entry -> UsageWindow? in
      guard let label = windowLabel(key), let window = entry.value, let used = window.utilization else { return nil }
      return UsageWindow(key: key, label: label, usedPercent: clamped(used), resetsAt: window.resetsAt.flatMap(isoMilliseconds))
    }.sorted { $0.key < $1.key }
    return (Int(cache.fetchedAtMs.rounded()), windows)
  }

  /// The label of a quota window key: "Session (5 h)", "Week", or "<Family> (week)" for `seven_day_<family>`. Nil for any
  /// other key.
  private static func windowLabel(_ key: String) -> String? {
    switch key {
    case "five_hour": return "Session (5 h)"
    case "seven_day": return "Week"
    default:
      guard key.hasPrefix("seven_day_") else { return nil }
      let family = key.dropFirst("seven_day_".count)
      guard let first = family.first else { return nil }
      return "\(first.uppercased())\(family.dropFirst()) (week)"
    }
  }

  /// A used percentage kept to 0–100.
  private static func clamped(_ percent: Double) -> Double {
    min(max(percent, 0), 100)
  }

  /// Unix seconds as Unix ms; nil before 1970 or past year 33658.
  private static func unixMilliseconds(_ seconds: Double) -> Int? {
    guard seconds >= 0, seconds <= 1e12 else { return nil }
    return Int((seconds * 1000).rounded())
  }

  /// An ISO-8601 time as Unix ms. The cache writes microseconds with `+00:00` as well as `Z`, so fractions of any length
  /// are read.
  private static func isoMilliseconds(_ text: String) -> Int? {
    guard let date = try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(text) else { return nil }
    return unixMilliseconds(date.timeIntervalSince1970)
  }
}

/// A value of the wrong shape reads as nil, so one odd entry does not hide the windows around it.
private struct Lenient<Value: Decodable>: Decodable {
  let value: Value?

  init(from decoder: Decoder) throws {
    value = try? Value(from: decoder)
  }
}

private struct StatusLine: Decodable {
  let rateLimits: [String: Lenient<StatusWindow>]?

  enum CodingKeys: String, CodingKey {
    case rateLimits = "rate_limits"
  }
}

private struct StatusWindow: Decodable {
  let usedPercentage: Double?
  let resetsAt: Double?

  enum CodingKeys: String, CodingKey {
    case usedPercentage = "used_percentage"
    case resetsAt = "resets_at"
  }
}

/// `.claude.json`, reduced to the two keys the parsers read.
private struct ClaudeJSON: Decodable {
  let cachedUsageUtilization: UsageCache?
  let oauthAccount: OAuthAccount?
}

private struct OAuthAccount: Decodable {
  let accountUuid: String
}

private struct UsageCache: Decodable {
  let fetchedAtMs: Double
  let accountUuid: String
  let utilization: [String: Lenient<CacheWindow>]
}

private struct CacheWindow: Decodable {
  let utilization: Double?
  let resetsAt: String?

  enum CodingKeys: String, CodingKey {
    case utilization
    case resetsAt = "resets_at"
  }
}
