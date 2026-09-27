import Foundation

// Secret values of worker templates (docs/worker-templates.md#secrets). The
// Node server keeps a template's secret names only; Human types the values
// in the template editor, and they reach Hivemind Server.app over the broker
// (secrets.set), which keeps them in the macOS Keychain. Nothing reads a
// value back over the broker: secrets.list answers names, and a value leaves
// the app only in a launch's private file (LaunchSecretStore).

/// A worker template's id as the Hivemind server issues it (crypto.randomUUID): a lowercase UUID.
public struct TemplateID: Hashable, Sendable, CustomStringConvertible {
  public let rawValue: String

  public init?(_ raw: String) {
    guard raw.utf8.count == 36, raw == raw.lowercased(), UUID(uuidString: raw) != nil else { return nil }
    rawValue = raw
  }

  public var description: String { rawValue }
}

/// One secret value on its way to the vault. Its description, debug
/// description and mirror never show it, so a request that reaches a log
/// shows `<redacted>`.
public struct TemplateSecretValue: Equatable, Sendable, CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
  public let value: String

  /// Nil unless 1–512 printable ASCII characters without spaces (LaunchSecrets' rule).
  public init?(_ value: String) {
    guard TemplateSecrets.isValidValue(value) else { return nil }
    self.value = value
  }

  public var description: String { "<redacted>" }
  public var debugDescription: String { description }
  public var customMirror: Mirror { Mirror(self, children: [], displayStyle: .struct) }
}

public enum TemplateSecrets {
  /// A template holds at most this many secrets (src/shared/worker-templates.ts).
  public static let maxNames = 8

  /// An environment variable name a launch may set (LaunchEnvironment's rules), or OPENCODE_API_KEY.
  public static func isValidName(_ name: String) -> Bool {
    name == "OPENCODE_API_KEY" || (LaunchEnvironment.isValidName(name) && !LaunchEnvironment.isDenied(name))
  }

  public static func isValidValue(_ value: String) -> Bool { LaunchSecrets.isValidValue(value) }

  static let nameRule = "must be an environment variable name a launch may set, or OPENCODE_API_KEY"
  static let valueRule = "must be 1–\(LaunchSecrets.maxValueBytes) printable ASCII characters without spaces"
}

/// Where Hivemind Server.app keeps template secrets: the macOS Keychain in
/// the app, a dictionary in tests. Errors name a template or a secret, never
/// a value.
@MainActor
public protocol TemplateSecretVault: AnyObject {
  /// The template's secret names, sorted.
  func names(for template: TemplateID) throws(BrokerFiles.Failure) -> [String]
  /// Adds or replaces one secret.
  func set(_ value: TemplateSecretValue, name: String, for template: TemplateID) throws(BrokerFiles.Failure)
  /// Deletes one secret, or every secret of the template when `name` is nil. Deleting what is not there is not an error.
  func delete(name: String?, for template: TemplateID) throws(BrokerFiles.Failure)
  /// Every secret of the template, for a launch's private file only: never answered over the broker.
  func values(for template: TemplateID) throws(BrokerFiles.Failure) -> [String: String]
}
