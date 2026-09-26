import Foundation

/// Restart delays after a crash: initial, initial*multiplier, … capped at
/// `maximum`. A run that stayed up for `stableAfter` counts as healthy and
/// resets the count, so one crash a day never waits the maximum. After
/// `maxAttempts` consecutive quick crashes the supervisor gives up and shows
/// the error instead of looping forever on, say, a corrupt database.
public struct BackoffPolicy: Equatable, Sendable {
  public var initial: TimeInterval
  public var multiplier: Double
  public var maximum: TimeInterval
  public var stableAfter: TimeInterval
  public var maxAttempts: Int

  public init(initial: TimeInterval = 1, multiplier: Double = 2, maximum: TimeInterval = 60,
              stableAfter: TimeInterval = 30, maxAttempts: Int = 8) {
    self.initial = initial
    self.multiplier = multiplier
    self.maximum = maximum
    self.stableAfter = stableAfter
    self.maxAttempts = maxAttempts
  }

  public static let `default` = BackoffPolicy()

  /// Delay before restart number `attempt` (1-based), or nil to give up.
  public func delay(forAttempt attempt: Int) -> TimeInterval? {
    guard attempt >= 1, attempt <= maxAttempts else { return nil }
    let raw = initial * pow(multiplier, Double(attempt - 1))
    return min(maximum, raw)
  }

  /// Whether a run of `uptime` seconds resets the attempt count.
  public func isStable(uptime: TimeInterval) -> Bool { uptime >= stableAfter }
}
