import Foundation

// Names of the tmux sessions Hivemind launches agents in, on its own tmux
// server (`tmux -L hivemind`). A name is a label only: it grants nothing, and
// it reaches tmux as one argv element (always as an exact `=name` target), so
// the pattern keeps it plain rather than safe to splice anywhere.
// docs/terminal-broker.md#session-names has the scheme.

/// A validated session name: `^hm-[a-z0-9][a-z0-9-]{0,78}$`.
public struct SessionName: Hashable, Sendable, Comparable, CustomStringConvertible {
  public let rawValue: String

  public static let prefix = "hm-"
  public static let maxLength = 82
  /// The same pattern src/shared/terminal-session.ts checks HIVEMIND_TMUX_SESSION with.
  public static let pattern = "^hm-[a-z0-9][a-z0-9-]{0,78}$"
  /// The environment variable a launched session's shell (and so the agent's
  /// `hivemind mcp`) sees its own session name in.
  public static let environmentVariable = "HIVEMIND_TMUX_SESSION"

  /// A project component longer than this is cut: project slugs are at most 32.
  static let maxProjectComponent = 32
  /// The longest agent component that still fits after the longest project.
  static let maxAgentComponent = maxLength - prefix.count - maxProjectComponent - 1

  /// Nil unless `rawValue` matches the pattern exactly.
  public init?(_ rawValue: String) {
    guard Self.isValid(rawValue) else { return nil }
    self.rawValue = rawValue
  }

  /// hm-<project>-<agent>: the session an agent always gets back, so
  /// relaunching ("Resume same employees") reuses it.
  public init(project: String, agent: String) {
    let project = Self.component(project, fallback: "project", limit: Self.maxProjectComponent)
    var agent = Self.component(agent, fallback: "agent", limit: Self.maxAgentComponent)
    // Keep "new-<n>" for agents not named yet.
    if Self.isNewCounter(agent) { agent = String(("a-" + agent).prefix(Self.maxAgentComponent)) }
    self.rawValue = Self.prefix + project + "-" + agent
  }

  /// hm-<project>-new-<n>, n ≥ 1: an agent whose name is not known yet.
  public init(project: String, newAgent n: Int) {
    let project = Self.component(project, fallback: "project", limit: Self.maxProjectComponent)
    self.rawValue = Self.prefix + project + "-new-" + String(max(1, n))
  }

  /// The first hm-<project>-new-<n> not in `existing`.
  public static func newAgent(project: String, existing: some Sequence<SessionName>) -> SessionName {
    let taken = Set(existing)
    var n = 1
    while taken.contains(SessionName(project: project, newAgent: n)) { n += 1 }
    return SessionName(project: project, newAgent: n)
  }

  public static func isValid(_ value: String) -> Bool {
    let bytes = Array(value.utf8)
    guard bytes.count > prefix.count, bytes.count <= maxLength, value.hasPrefix(prefix) else { return false }
    let rest = bytes.dropFirst(prefix.count)
    guard let first = rest.first, isLowerAlnum(first) else { return false }
    return rest.allSatisfy { isLowerAlnum($0) || $0 == UInt8(ascii: "-") }
  }

  /// Lowercase ASCII letters and digits, anything else folded or turned into
  /// single dashes, no dash at either end, at most `limit` characters.
  /// "Anne Marie", "anne-marie" and "Änne_Marie" all give "anne-marie".
  public static func component(_ text: String, fallback: String, limit: Int) -> String {
    let folded = text.folding(options: [.diacriticInsensitive, .caseInsensitive, .widthInsensitive], locale: Locale(identifier: "en_US_POSIX"))
    var out = ""
    var pendingDash = false
    for byte in folded.lowercased().utf8 {
      if isLowerAlnum(byte) {
        if pendingDash, !out.isEmpty { out.append("-") }
        pendingDash = false
        out.append(Character(Unicode.Scalar(byte)))
      } else {
        pendingDash = true
      }
    }
    if out.count > limit { out = String(out.prefix(limit)) }
    while out.hasSuffix("-") { out.removeLast() }
    return out.isEmpty ? fallback : out
  }

  private static func isNewCounter(_ component: String) -> Bool {
    guard component.hasPrefix("new-") else { return false }
    let digits = component.dropFirst(4)
    return !digits.isEmpty && digits.allSatisfy(\.isASCII) && digits.allSatisfy(\.isNumber)
  }

  private static func isLowerAlnum(_ byte: UInt8) -> Bool {
    (UInt8(ascii: "a")...UInt8(ascii: "z")).contains(byte) || (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(byte)
  }

  /// The exact-match tmux target for this session (`-t =name`), so
  /// `hm-acme` can never select `hm-acme-atlas` by prefix.
  public var target: String { "=" + rawValue }

  public var description: String { rawValue }

  public static func < (lhs: SessionName, rhs: SessionName) -> Bool { lhs.rawValue < rhs.rawValue }
}

extension SessionName: Codable {
  public init(from decoder: any Decoder) throws {
    let value = try decoder.singleValueContainer().decode(String.self)
    guard let name = SessionName(value) else {
      throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "not a Hivemind session name"))
    }
    self = name
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(rawValue)
  }
}
