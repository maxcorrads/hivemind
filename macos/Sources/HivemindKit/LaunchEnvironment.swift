import Foundation

// The Launch agent sheet's "Environment variables" (web: src/shared/
// launch-environment.ts, which checks the same rules first; keep the two in
// step). docs/terminal-broker.md#launch-environment has the design. They
// travel like launch secrets: never argv, never tmux's environment, never a
// log. The broker writes them with any secret into the launch's private file
// (LaunchSecretStore), which the session's script loads before the cd.

/// A launch's environment variables: 1–32 names the shell, the terminal and
/// Hivemind do not own, each with a value of at most 8 KiB without control
/// characters (so no NUL, CR or LF), 32 KiB in all. Its description, debug
/// description and mirror show names only, never a value.
public struct LaunchEnvironment: Equatable, Sendable {
  public static let maxVariables = 32
  public static let maxNameCharacters = 64
  /// UTF-8 bytes of one value, at most.
  public static let maxValueBytes = 8 * 1024
  /// UTF-8 bytes of every `NAME=value` together, at most.
  public static let maxTotalBytes = 32 * 1024
  /// Names refused, compared without case (zsh ties lowercase `path`,
  /// `cdpath` and `fpath` to the uppercase ones).
  public static let deniedNames: Set<String> = [
    "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "PWD", "OLDPWD", "IFS", "ENV", "BASH_ENV", "ZDOTDIR",
    "CDPATH", "FPATH", "PS1", "PS2", "PS3", "PS4", "PROMPT_COMMAND", "TERM", "TMUX", "TMUX_PANE", "OPENCODE_API_KEY",
  ]
  /// Prefixes refused the same way. HIVEMIND_* are Hivemind's own
  /// (HIVEMIND_TMUX_SESSION among them); OPENCODE_API_KEY is a secret.
  public static let deniedPrefixes = ["LD_", "DYLD_", "HIVEMIND_"]

  private let values: [String: String]

  /// Throws bad-message for no variable, too many, a name that is not a
  /// shell name or is denied, a value that breaks the rules, or too many
  /// bytes in all. The message names the field (and a variable), never a value.
  public init(_ values: [String: String]) throws(BrokerProtocolError) {
    try self.init(values, field: "environment")
  }

  init(_ values: [String: String], field: String) throws(BrokerProtocolError) {
    guard !values.isEmpty else { throw .invalid(field, "must name at least one variable") }
    guard values.count <= Self.maxVariables else { throw .invalid(field, "must hold at most \(Self.maxVariables) variables") }
    var total = 0
    for name in values.keys.sorted() {
      guard Self.isValidName(name) else {
        throw .invalid(field, "a name is letters, digits and _, starts with a letter or _, and has at most \(Self.maxNameCharacters) characters")
      }
      guard !Self.isDenied(name) else { throw .invalid("\(field).\(name)", "cannot be set by a launch") }
      let value = values[name]!
      guard Self.isValidValue(value) else {
        throw .invalid("\(field).\(name)", "must be at most \(Self.maxValueBytes) bytes without control characters")
      }
      total += name.utf8.count + 1 + value.utf8.count
    }
    guard total <= Self.maxTotalBytes else { throw .invalid(field, "must come to at most \(Self.maxTotalBytes) bytes") }
    self.values = values
  }

  /// ^[A-Za-z_][A-Za-z0-9_]{0,63}$
  public static func isValidName(_ name: String) -> Bool {
    let bytes = Array(name.utf8)
    guard (1...maxNameCharacters).contains(bytes.count), let first = bytes.first, !isDigit(first) else { return false }
    return bytes.allSatisfy { isDigit($0) || isLetter($0) || $0 == UInt8(ascii: "_") }
  }

  /// Owned by the shell, the terminal, the dynamic loader or Hivemind, or a
  /// secret with a field of its own; without case.
  public static func isDenied(_ name: String) -> Bool {
    let upper = name.uppercased()
    return deniedNames.contains(upper) || deniedPrefixes.contains { upper.hasPrefix($0) }
  }

  /// At most 8 KiB, and no control character but tab: no NUL, CR, LF, other
  /// C0 characters, DEL or C1. Empty is allowed.
  public static func isValidValue(_ value: String) -> Bool {
    value.utf8.count <= maxValueBytes && !value.unicodeScalars.contains { scalar in
      let v = scalar.value
      return (v < 0x20 && v != 0x09) || (0x7F...0x9F).contains(v)
    }
  }

  private static func isDigit(_ byte: UInt8) -> Bool { (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(byte) }
  private static func isLetter(_ byte: UInt8) -> Bool {
    (UInt8(ascii: "a")...UInt8(ascii: "z")).contains(byte) || (UInt8(ascii: "A")...UInt8(ascii: "Z")).contains(byte)
  }

  /// The names, sorted.
  public var names: [String] { values.keys.sorted() }

  public func value(_ name: String) -> String? { values[name] }

  /// For the wire only (BrokerRequestFrame's encoder).
  var dictionary: [String: String] { values }
}

extension LaunchEnvironment: CustomStringConvertible, CustomDebugStringConvertible, CustomReflectable {
  public var description: String { "LaunchEnvironment(" + names.map { "\($0): <redacted>" }.joined(separator: ", ") + ")" }
  public var debugDescription: String { description }
  /// What dump(_:) and a struct holding this print: the names, never the values.
  public var customMirror: Mirror {
    Mirror(self, children: names.map { (label: $0 as String?, value: "<redacted>" as Any) }, displayStyle: .struct)
  }
}
