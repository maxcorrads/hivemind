import Foundation

// Builds an account's own directory before a session runs under it (a Codex
// shadow, docs/accounts.md). Shadow directories come in phases 3 and 4; until
// then the broker runs with NoShadowHomes, which refuses every shadow and
// leaves a primary account alone.

/// What the broker asks before it starts a session under an account.
public protocol ShadowHomePreparing {
  /// Makes the account's directory ready. `home` is the Mac's home, which
  /// expands a leading `~/`. Throws when it cannot: the launch fails and runs nothing.
  func prepare(_ account: LaunchAccount, home: String) throws
}

/// Refuses a shadow account and does nothing for a primary one.
public struct NoShadowHomes: ShadowHomePreparing {
  public init() {}

  public func prepare(_ account: LaunchAccount, home: String) throws {
    guard account.shadowPath.isEmpty else {
      throw BrokerProtocolError(.internal, "Shadow accounts are not supported yet")
    }
  }
}
