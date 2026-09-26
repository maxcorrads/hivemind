import Foundation

// Keeps one Mac's device session alive for the iOS app (docs/remote-access.md#device-sessions):
// every scene showing that Mac, and each of its broker connections, asks
// here for the current session. A new one is fetched when less than
// GatewayLimits.sessionRenewBefore is left, when a scene becomes active,
// and ahead of time on a timer; concurrent askers share one request.
// Every new session is handed to `onChange`, where the app puts its cookie
// into that Mac's web view data store.

@MainActor
public final class RemoteSessionKeeper {
  public typealias Fetch = @MainActor () async throws(RemoteClientError) -> RemoteDeviceSession

  /// A renewal that failed for a reason other than revocation (the Mac
  /// asleep, say) is tried again after this, while the old session lasts.
  public nonisolated static let retryAfterFailure: TimeInterval = 60
  /// A scene becoming active renews a session older than this. Several
  /// scenes of one app become active together; they share one renewal.
  public nonisolated static let activationRenewAfter: TimeInterval = 60

  public private(set) var session: RemoteDeviceSession?
  /// A new session (fetched on demand or renewed on the timer).
  public var onChange: (@MainActor (RemoteDeviceSession) -> Void)?
  /// The gateway refused this device: it was revoked. Nothing is retried
  /// until someone asks for a session again.
  public var onRevoked: (@MainActor () -> Void)?

  private let fetch: Fetch
  private let scheduler: any Scheduling
  private var inFlight: Task<Result<RemoteDeviceSession, RemoteClientError>, Never>?
  private var issuedAt: Date?
  private var renewJob: (any Cancellable)?
  private var stopped = false

  public init(scheduler: any Scheduling, fetch: @escaping Fetch) {
    self.scheduler = scheduler
    self.fetch = fetch
  }

  /// The session to use now: the current one while it has time left, else a
  /// new one. When renewing fails but the current one has not expired yet,
  /// that one is still returned; a revoked device always throws.
  public func current() async throws(RemoteClientError) -> RemoteDeviceSession {
    stopped = false
    let now = scheduler.now()
    if let session, !session.needsRenewal(at: now) { return session }
    return try await renew()
  }

  /// A scene became active: renew unless the session is brand new. This also
  /// finds out soon after that the device was revoked.
  public func sceneDidBecomeActive() async throws(RemoteClientError) -> RemoteDeviceSession {
    stopped = false
    let now = scheduler.now()
    if let session, let issuedAt, now.timeIntervalSince(issuedAt) < Self.activationRenewAfter, !session.needsRenewal(at: now) {
      return session
    }
    return try await renew()
  }

  /// The gateway refused the current session (Hivemind Server restarted and
  /// forgot its sessions, say): the next asker gets a new one.
  public func invalidate() {
    session = nil
    issuedAt = nil
  }

  /// Reports of a forgotten session closer together than this after the
  /// last one share its renewal: every scene and page of the Mac may report
  /// the same loss at once.
  public nonisolated static let expiryReportInterval: TimeInterval = 5
  private var lastExpiryReport: Date?

  /// A page said the gateway forgot its device session (401 with
  /// X-Hivemind-Device-Session: required): get a new one now, so the page's
  /// own retries (its /ws reconnect) find a live cookie. Throttled; a
  /// revoked device ends up in onRevoked as with any renewal.
  public func pageReportedExpiry() async {
    let now = scheduler.now()
    if let lastExpiryReport, now.timeIntervalSince(lastExpiryReport) < Self.expiryReportInterval { return }
    lastExpiryReport = now
    invalidate()
    _ = try? await current()
  }

  /// Whether a scene coming forward must get a new session before its page
  /// may load anything: the app was away longer than the session lasts (or
  /// it has none). Then the scene renews first and loads the page again.
  public func isExpired(at now: Date) -> Bool {
    session.map { $0.isExpired(at: now) } ?? true
  }

  /// Forgets the session and stops the timer (the Mac was removed, or the
  /// last scene showing it went away).
  public func stop() {
    stopped = true
    renewJob?.cancel()
    renewJob = nil
    session = nil
    issuedAt = nil
  }

  /// One fetch at a time; everyone asking meanwhile gets its result.
  private func renew() async throws(RemoteClientError) -> RemoteDeviceSession {
    if let inFlight { return try await settle(inFlight.value) }
    let fetch = fetch
    let task = Task { @MainActor () -> Result<RemoteDeviceSession, RemoteClientError> in
      do throws(RemoteClientError) { return .success(try await fetch()) } catch { return .failure(error) }
    }
    inFlight = task
    let result = await task.value
    inFlight = nil
    return try await settle(result, fresh: true)
  }

  private func settle(_ result: Result<RemoteDeviceSession, RemoteClientError>, fresh: Bool = false) async throws(RemoteClientError) -> RemoteDeviceSession {
    let now = scheduler.now()
    switch result {
    case .success(let new):
      if fresh, !stopped {
        session = new
        issuedAt = now
        schedule(after: new.renewalDelay(at: now))
        onChange?(new)
      }
      return new
    case .failure(let error):
      if error.isRevoked {
        if fresh {
          stop()
          onRevoked?()
        }
        throw error
      }
      if let session, !session.isExpired(at: now) {
        if fresh { schedule(after: Self.retryAfterFailure) }
        return session
      }
      throw error
    }
  }

  private func schedule(after delay: TimeInterval) {
    renewJob?.cancel()
    guard !stopped else { return }
    // Never sooner than a second: a session that already needs renewal and
    // a gateway that keeps failing must not spin.
    renewJob = scheduler.schedule(after: max(1, delay)) { [weak self] in
      guard let self, !self.stopped else { return }
      self.renewJob = nil
      Task { @MainActor in _ = try? await self.renew() }
    }
  }
}
