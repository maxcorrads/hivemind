import Foundation

// The gateway's in-memory state (docs/remote-access.md#pairing,
// #device-sessions): the pairing window, the device sessions and the rate
// limits. Plain values driven by a clock the caller passes in, so the tests
// step through time without waiting.

/// Attempts per key (a remote address) in a sliding window. The number of
/// keys is bounded too: past `maxKeys` the key seen least recently is
/// forgotten, so a device cycling through addresses costs memory only up to
/// that bound.
public struct GatewayRateLimiter: Sendable {
  public let limit: Int
  public let window: TimeInterval
  public let maxKeys: Int
  private var attempts: [String: [Date]] = [:]

  public init(limit: Int, window: TimeInterval = 60, maxKeys: Int = 1024) {
    self.limit = limit
    self.window = window
    self.maxKeys = maxKeys
  }

  /// Counts an attempt and says whether it is within the limit. A refused
  /// attempt is not counted, so waiting out the window always helps.
  public mutating func allow(_ key: String, now: Date) -> Bool {
    var recent = (attempts[key] ?? []).filter { now.timeIntervalSince($0) < window }
    guard recent.count < limit else {
      attempts[key] = recent
      return false
    }
    recent.append(now)
    attempts[key] = recent
    if attempts.count > maxKeys { prune(now: now) }
    return true
  }

  private mutating func prune(now: Date) {
    attempts = attempts.filter { !$0.value.isEmpty && now.timeIntervalSince($0.value.last!) < window }
    while attempts.count > maxKeys, let oldest = attempts.min(by: { $0.value.last! < $1.value.last! })?.key {
      attempts[oldest] = nil
    }
  }

  public var trackedKeys: Int { attempts.count }
}

/// The one pairing code the Mac shows, while "Pair a device…" is open.
public struct GatewayPairingWindow: Equatable, Sendable {
  public enum State: Equatable, Sendable {
    /// The code is shown and can be used.
    case open
    /// Too many wrong codes: this code is dead.
    case locked
    /// Used: a device paired with it.
    case paired(deviceName: String)
  }

  public let code: PairingCode
  public let openedAt: Date
  public let expiresAt: Date
  public fileprivate(set) var failures = 0
  public fileprivate(set) var state = State.open

  public func isExpired(at now: Date) -> Bool { now >= expiresAt }

  public func remaining(at now: Date) -> TimeInterval { max(0, expiresAt.timeIntervalSince(now)) }
}

public struct GatewayPairing: Sendable {
  public enum Outcome: Equatable, Sendable {
    /// The code is right: the caller adds the device, then calls `completed`.
    case accepted
    case refused(GatewayErrorCode)
  }

  public private(set) var window: GatewayPairingWindow?

  public init() {}

  /// Shows a new code, replacing any other: only one can be valid at once.
  @discardableResult
  public mutating func open(now: Date, code: PairingCode = .generate()) -> GatewayPairingWindow {
    let window = GatewayPairingWindow(code: code, openedAt: now, expiresAt: now.addingTimeInterval(GatewayLimits.pairingCodeLifetime))
    self.window = window
    return window
  }

  /// The window closed: its code is gone.
  public mutating func close() { window = nil }

  /// Checks a presented code (docs/remote-access.md#pairing, step 4). Wrong,
  /// used and expired codes all get `invalid-code`, so a guess learns
  /// nothing; the wrong ones count towards the lock.
  public mutating func attempt(_ code: PairingCode, now: Date) -> Outcome {
    guard var window else { return .refused(.pairingClosed) }
    switch window.state {
    case .locked: return .refused(.pairingLocked)
    case .paired: return .refused(.invalidCode)
    case .open: break
    }
    // Checked even when expired, so both take the same time.
    let matches = window.code.matches(code.value)
    guard !window.isExpired(at: now) else { return .refused(.invalidCode) }
    guard matches else {
      window.failures += 1
      if window.failures >= GatewayLimits.maxPairingFailures { window.state = .locked }
      self.window = window
      return .refused(window.state == .locked ? .pairingLocked : .invalidCode)
    }
    return .accepted
  }

  /// The device was saved: the code is used up at once.
  public mutating func completed(deviceName: String) {
    window?.state = .paired(deviceName: deviceName)
  }
}

/// The live device sessions: the SHA-256 of each session token (never the
/// token), the device it belongs to and when it ends.
public struct GatewaySessionStore: Sendable {
  public struct Session: Equatable, Sendable {
    public let tokenHash: SecretHash
    public let deviceId: UUID
    public let createdAt: Date
    public let expiresAt: Date
  }

  public private(set) var sessions: [Session] = []

  public init() {}

  /// A new session for `deviceId`. Expired sessions go first; past
  /// `maxSessionsPerDevice` the device's oldest ones do.
  public mutating func create(for deviceId: UUID, now: Date, token: DeviceSessionToken = .generate()) -> (token: DeviceSessionToken, expiresAt: Date) {
    prune(now: now)
    let expiresAt = now.addingTimeInterval(GatewayLimits.sessionLifetime)
    sessions.append(Session(tokenHash: token.hash, deviceId: deviceId, createdAt: now, expiresAt: expiresAt))
    let mine = sessions.filter { $0.deviceId == deviceId }
    if mine.count > GatewayLimits.maxSessionsPerDevice {
      let dropped = Set(mine.sorted { $0.createdAt < $1.createdAt }.prefix(mine.count - GatewayLimits.maxSessionsPerDevice).map(\.tokenHash))
      sessions.removeAll { dropped.contains($0.tokenHash) }
    }
    return (token, expiresAt)
  }

  /// The device of a live session. Every session is compared, each in
  /// constant time, so timing tells nothing about which one matched.
  public func device(for token: DeviceSessionToken, now: Date) -> UUID? {
    let hash = token.hash
    var found: UUID?
    for session in sessions where session.tokenHash.matches(hash) && now < session.expiresAt {
      if found == nil { found = session.deviceId }
    }
    return found
  }

  /// Revocation: every session of the device ends.
  public mutating func revoke(deviceId: UUID) { sessions.removeAll { $0.deviceId == deviceId } }

  public mutating func removeAll() { sessions.removeAll() }

  public mutating func prune(now: Date) { sessions.removeAll { now >= $0.expiresAt } }
}
