import Darwin
import Foundation

public enum ProcessLiveness {
  /// kill(pid, 0) like the server's own check: EPERM means the process exists
  /// but belongs to another user, which still owns the data folder.
  public static func isAlive(_ pid: Int32) -> Bool {
    guard pid > 0 else { return false }
    if kill(pid, 0) == 0 { return true }
    return errno == EPERM
  }
}

/// The owner recorded in <data home>/server.lock by `hivemind serve`
/// (src/server/instance-lock.ts). It has no port, so a live owner only tells
/// us the folder is taken, not where that server listens.
public struct InstanceLockOwner: Decodable, Equatable, Sendable {
  public let pid: Int32
  public let token: String
  /// Milliseconds since the epoch, as the server writes it.
  public let startedAt: Double?

  /// The owner of the lock in `dataHome`, or nil when the lock is missing,
  /// corrupt or stale (its process is gone; the server reclaims those itself).
  public static func live(dataHome: URL, isAlive: (Int32) -> Bool = ProcessLiveness.isAlive) -> InstanceLockOwner? {
    let file = HivemindPaths.lockFile(dataHome: dataHome)
    guard let data = try? Data(contentsOf: file),
          let owner = try? JSONDecoder().decode(InstanceLockOwner.self, from: data),
          isAlive(owner.pid) else { return nil }
    return owner
  }
}
