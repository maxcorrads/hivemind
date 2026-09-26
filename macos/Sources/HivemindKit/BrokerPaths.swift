import Foundation

// Where the terminal broker's local transport lives, and its capability
// token. All under the app-support folder both apps share, which the broker
// keeps at 0700: the socket (0600) and the token (0600) are only reachable
// by the user, and a client must also present the token in `hello`.

extension HivemindPaths {
  /// The Unix socket Hivemind Server.app's broker listens on.
  public var brokerSocket: URL { appSupport.appendingPathComponent("broker.sock") }

  /// The capability token a client reads and sends in `hello`.
  public var brokerToken: URL { appSupport.appendingPathComponent("broker.token") }

  /// The config of Hivemind's own tmux server (TmuxCommand.configText).
  public var tmuxConfig: URL { appSupport.appendingPathComponent("tmux.conf") }
}

public enum BrokerPaths {
  /// sockaddr_un.sun_path is 104 bytes on Darwin, NUL included.
  public static let maxSocketPathBytes = 103

  /// Whether `socket` fits in a sockaddr_un. A home folder long enough to
  /// break this makes the broker report an error instead of truncating.
  public static func fitsSocketAddress(_ socket: URL) -> Bool {
    socket.path.utf8.count <= maxSocketPathBytes
  }
}

/// The broker's capability token: 32 random bytes as 64 lowercase hex
/// characters. The broker writes a new one (0600, replacing the file) each
/// time it starts; a client reads it before every connection.
public struct BrokerToken: Equatable, Sendable, CustomStringConvertible {
  public let value: String

  public static let byteCount = 32

  public init?(_ value: String) {
    let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
    guard trimmed.utf8.count == Self.byteCount * 2,
          trimmed.utf8.allSatisfy({ (UInt8(ascii: "0")...UInt8(ascii: "9")).contains($0) || (UInt8(ascii: "a")...UInt8(ascii: "f")).contains($0) })
    else { return nil }
    self.value = trimmed
  }

  /// SystemRandomNumberGenerator is the OS CSPRNG (arc4random_buf on Apple
  /// platforms), and needs no Security framework.
  public static func generate() -> BrokerToken {
    var generator = SystemRandomNumberGenerator()
    return generate(using: &generator)
  }

  public static func generate(using generator: inout some RandomNumberGenerator) -> BrokerToken {
    let hex = (0..<byteCount).map { _ in
      let byte = UInt8.random(in: .min ... .max, using: &generator)
      return String(byte, radix: 16).leftPadded(to: 2)
    }.joined()
    return BrokerToken(hex)!
  }

  /// Compares in time independent of where the first difference is.
  public func matches(_ presented: String) -> Bool {
    let a = Array(value.utf8)
    let b = Array(presented.utf8)
    var difference = UInt8(a.count == b.count ? 0 : 1)
    for index in 0..<a.count {
      difference |= a[index] ^ (index < b.count ? b[index] : 0)
    }
    return difference == 0
  }

  /// Never the token itself, so it cannot end up in a log by accident.
  public var description: String { "BrokerToken(…)" }
}

private extension String {
  func leftPadded(to length: Int) -> String {
    count >= length ? self : String(repeating: "0", count: length - count) + self
  }
}
