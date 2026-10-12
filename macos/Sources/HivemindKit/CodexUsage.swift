import Foundation

// Codex's quota windows from `codex app-server` (docs/accounts.md, "Usage"; spike 0.3 of #320). A pure parser over the
// lines of one probe: no process and no file here. Only the reply ids, the account type and the rate-limit buckets are
// decoded, so the email that `account/read` returns is never stored.

/// One probe's answer: the plan (`subscription`, `api-key` or `unknown`, as usageSnapshotSchema names it) and the windows.
public struct CodexUsageProbe: Equatable, Sendable {
  public let plan: String
  public let windows: [UsageWindow]

  public init(plan: String, windows: [UsageWindow]) {
    self.plan = plan
    self.windows = windows
  }
}

/// A probe that gave no quota. `message` is the fixed text a snapshot's `error` carries, never command output.
public enum CodexUsageError: Error, Equatable, Sendable {
  case notLoggedIn
  case readFailed

  public var message: String {
    switch self {
    case .notLoggedIn: return "Not logged in"
    case .readFailed: return "Usage read failed"
    }
  }
}

public enum CodexUsage {
  /// The reply ids the probe waits for: 2 `account/read`, 3 `account/rateLimits/read`. Reply 1 is `initialize` and is not read.
  static let accountReplyId = 2
  static let rateLimitsReplyId = 3

  /// Most windows one snapshot carries, and the longest key and label (src/shared/accounts.ts, usageSnapshotSchema).
  static let maxWindows = 8
  static let maxKeyLength = 64
  static let maxLabelLength = 80

  /// The limitId Codex itself files a bucket under when the bucket has none.
  static let defaultLimitId = "codex"

  /// The plan and windows of one probe, from its lines in any order; notifications and lines that are not JSON are ignored.
  /// The windows are the main bucket's primary and secondary, then each other bucket's in limitId order, at most 8 in all.
  /// `usedPercent` is used, not remaining, clamped to 0–100.
  ///
  /// A `-32600` error on the rate-limit reply names its cause. "codex account authentication required" is `notLoggedIn`.
  /// "chatgpt authentication required" is an API key, which has no plan window, so it succeeds with plan `api-key` and no
  /// windows. Any other error is `readFailed`, as is a probe with no rate-limit reply.
  public static func parseCodexProbe(lines: [String]) -> Result<CodexUsageProbe, CodexUsageError> {
    let replies = repliesById(lines)
    guard let data = replies[rateLimitsReplyId], let reply = try? JSONDecoder().decode(RPCReply<RateLimitsResult>.self, from: data) else {
      return .failure(.readFailed)
    }
    if let error = reply.error { return probeError(error) }
    guard let result = reply.result else { return .failure(.readFailed) }
    return .success(CodexUsageProbe(plan: plan(replies[accountReplyId]), windows: usageWindows(result)))
  }

  /// The first line for each reply id the probe waits for. Other lines, and any line with a `method` (a notification or a
  /// request from the server), are skipped, so replies may come in any order.
  private static func repliesById(_ lines: [String]) -> [Int: Data] {
    var replies: [Int: Data] = [:]
    for line in lines {
      let data = Data(line.utf8)
      guard let header = try? JSONDecoder().decode(ReplyId.self, from: data), header.method == nil, let id = header.id,
            id == accountReplyId || id == rateLimitsReplyId, replies[id] == nil else { continue }
      replies[id] = data
    }
    return replies
  }

  /// The plan from `account/read`: `chatgpt` is a subscription, `apiKey` an API key. The email is not decoded.
  private static func plan(_ data: Data?) -> String {
    guard let data, let reply = try? JSONDecoder().decode(RPCReply<AccountResult>.self, from: data),
          let type = reply.result?.account?.type else { return "unknown" }
    switch type {
    case "chatgpt": return "subscription"
    case "apiKey": return "api-key"
    default: return "unknown"
    }
  }

  private static func probeError(_ error: RPCError) -> Result<CodexUsageProbe, CodexUsageError> {
    guard error.code == -32600 else { return .failure(.readFailed) }
    if error.message.hasPrefix("codex account authentication required") { return .failure(.notLoggedIn) }
    if error.message.hasPrefix("chatgpt authentication required") { return .success(CodexUsageProbe(plan: "api-key", windows: [])) }
    return .failure(.readFailed)
  }

  /// The main bucket's windows, then each other bucket's in limitId order, at most `maxWindows` in all. A main bucket
  /// without a limitId is `codex`, as Codex keys it in `rateLimitsByLimitId`. An extra bucket is labelled with its
  /// `limitName`, or its limitId when the name is null.
  private static func usageWindows(_ result: RateLimitsResult) -> [UsageWindow] {
    let main = result.rateLimits
    let mainId = main.limitId ?? defaultLimitId
    var windows = bucketWindows(main, limitId: mainId, prefix: nil)
    for (limitId, bucket) in (result.rateLimitsByLimitId ?? [:]).sorted(by: { $0.key < $1.key }) where limitId != mainId {
      guard let snapshot = bucket.value else { continue }
      windows += bucketWindows(snapshot, limitId: limitId, prefix: snapshot.limitName ?? limitId)
    }
    return Array(windows.prefix(maxWindows))
  }

  /// The primary and secondary windows of one bucket, keyed `<limitId>.<primary|secondary>`. A window without a
  /// `usedPercent` number is left out, as is one whose key or label is longer than the schema allows (counted in UTF-16
  /// units, as the server counts), so one odd bucket cannot make the server refuse the snapshot.
  private static func bucketWindows(_ bucket: RateLimitSnapshot, limitId: String, prefix: String?) -> [UsageWindow] {
    let slots = [("primary", bucket.primary), ("secondary", bucket.secondary)]
    return slots.compactMap { slot, lenient in
      guard let window = lenient?.value, let used = window.usedPercent else { return nil }
      let key = "\(limitId).\(slot)"
      let label = windowLabel(minutes: window.windowDurationMins, slot: slot, prefix: prefix)
      guard key.utf16.count <= maxKeyLength, label.utf16.count <= maxLabelLength else { return nil }
      return UsageWindow(key: key, label: label, usedPercent: clamped(used), resetsAt: window.resetsAt.flatMap(unixMilliseconds))
    }
  }

  /// The span of a window: "5 h", "Day", "Week", "Month", else "<n> min". Without a length it is named by its slot. An
  /// extra bucket's label has its name in front.
  private static func windowLabel(minutes: Int?, slot: String, prefix: String?) -> String {
    let span: String
    switch minutes {
    case 300?: span = "5 h"
    case 1440?: span = "Day"
    case 10080?: span = "Week"
    case 43200?: span = "Month"
    case let minutes?: span = "\(minutes) min"
    case nil: span = slot.capitalized
    }
    return prefix.map { "\($0) \(span)" } ?? span
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
}

/// A value of the wrong shape reads as nil, so one odd entry does not hide the windows around it.
private struct Lenient<Value: Decodable>: Decodable {
  let value: Value?

  init(from decoder: Decoder) throws {
    value = try? Value(from: decoder)
  }
}

/// One line of the probe's output, reduced to its reply id and method. A reply has an id and no method; a notification
/// has no id.
private struct ReplyId: Decodable {
  let id: Int?
  let method: String?
}

/// A JSON-RPC reply: the `result` the request asked for, or an `error`.
private struct RPCReply<Payload: Decodable>: Decodable {
  let result: Payload?
  let error: RPCError?
}

private struct RPCError: Decodable {
  let code: Int
  let message: String
}

private struct AccountResult: Decodable {
  let account: Account?
}

/// `account/read`'s account, reduced to its type. The email and the plan type are not decoded.
private struct Account: Decodable {
  let type: String
}

/// `account/rateLimits/read`: the main bucket, and every bucket by its limitId.
private struct RateLimitsResult: Decodable {
  let rateLimits: RateLimitSnapshot
  let rateLimitsByLimitId: [String: Lenient<RateLimitSnapshot>]?
}

/// Codex declares every field of a bucket optional, the limitId included.
private struct RateLimitSnapshot: Decodable {
  let limitId: String?
  let limitName: String?
  let primary: Lenient<RateLimitWindow>?
  let secondary: Lenient<RateLimitWindow>?
}

/// `usedPercent` is used, not remaining; `resetsAt` is Unix seconds, null when the provider gives no reset time.
private struct RateLimitWindow: Decodable {
  let usedPercent: Double?
  let windowDurationMins: Int?
  let resetsAt: Double?
}
