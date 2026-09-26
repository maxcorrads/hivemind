import Foundation

/// A TCP port the server can listen on. 0 ("any free port") is refused: both
/// apps need a port they can name before the server has started.
public struct ServerPort: Hashable, Sendable, Codable, CustomStringConvertible {
  /// Mirrors DEFAULT_PORT in src/shared/types.ts.
  public static let `default` = ServerPort(unchecked: 7420)

  public let value: Int

  public init?(_ value: Int) {
    guard (1...65535).contains(value) else { return nil }
    self.value = value
  }

  /// Parses user input strictly, like integerArgument on the server: digits
  /// only, no sign, no whitespace inside, no leading zeros.
  public init?(_ text: String) {
    let trimmed = text.trimmingCharacters(in: .whitespaces)
    guard !trimmed.isEmpty, trimmed.count <= 5, trimmed.allSatisfy({ $0.isASCII && $0.isNumber }),
          trimmed == "0" || !trimmed.hasPrefix("0"), let number = Int(trimmed) else { return nil }
    self.init(number)
  }

  private init(unchecked value: Int) { self.value = value }

  public init(from decoder: Decoder) throws {
    let number = try decoder.singleValueContainer().decode(Int.self)
    guard let port = ServerPort(number) else {
      throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Port \(number) out of range"))
    }
    self = port
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(value)
  }

  public var description: String { String(value) }
}

/// The local server as the web UI must see it. The Human session only accepts
/// an Origin equal to the canonical http origin of a loopback Host
/// (docs/local-human-security.md), so everything is pinned to
/// http://127.0.0.1:<port> — never localhost, file:// or a custom scheme.
public struct ServerEndpoint: Hashable, Sendable {
  public static let host = "127.0.0.1"

  public let port: ServerPort

  public init(port: ServerPort) { self.port = port }

  /// http://127.0.0.1:<port>/ — what a WKWebView loads.
  public var baseURL: URL { URL(string: "http://\(Self.host):\(port.value)/")! }

  /// GET here answers {"ok":true,"name":"hivemind"} without a session.
  public var healthURL: URL { URL(string: "api/health", relativeTo: baseURL)!.absoluteURL }

  /// The UI at a given hash route, e.g. "#/for-you".
  public func url(hash: String) -> URL {
    let fragment = hash.hasPrefix("#") ? String(hash.dropFirst()) : hash
    var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)!
    components.fragment = fragment.isEmpty ? nil : fragment
    return components.url!
  }

  /// True for exactly this origin: http, 127.0.0.1 and this port. URLs with
  /// credentials are refused like the server refuses them in a Host.
  public func isSameOrigin(_ url: URL) -> Bool {
    url.scheme?.lowercased() == "http" && url.host == Self.host && (url.port ?? 80) == port.value
      && url.user == nil && url.password == nil
  }
}
