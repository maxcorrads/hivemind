import Foundation

// The random secrets of the remote gateway (docs/remote-access.md#secrets):
//
// - PairingCode: single use, 5 minutes, only ever in the QR code / pairing
//   link and in one POST /_hivemind/pair.
// - DeviceToken: what a paired device keeps (in its Keychain) and presents
//   only to POST /_hivemind/session. The gateway stores only its hash.
// - DeviceSessionToken: the short-lived cookie the device's web view and its
//   broker connection carry. The gateway keeps only its hash, in memory.
//
// All come from SystemRandomNumberGenerator, the OS CSPRNG (arc4random_buf
// on Apple platforms, like BrokerToken), and are written as unpadded
// base64url so they fit a URL, a header and a cookie without escaping.
// Because every one is at least 128 random bits, a plain SHA-256 is the right
// way to store it: there is nothing to brute-force, so no salt or slow KDF.

/// Unpadded base64url (RFC 4648 §5), strict on decode.
public enum Base64URL {
  public static func encode(_ bytes: some Sequence<UInt8>) -> String {
    Data(bytes).base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  /// Nil for anything but the canonical unpadded encoding: no padding, no
  /// whitespace, no `+`/`/`, and no stray bits in the last character, so
  /// one secret has exactly one spelling.
  public static func decode(_ text: String) -> Data? {
    guard text.utf8.allSatisfy(isAlphabet), text.utf8.count % 4 != 1 else { return nil }
    var standard = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    standard += String(repeating: "=", count: (4 - standard.utf8.count % 4) % 4)
    guard let data = Data(base64Encoded: standard), encode(data) == text else { return nil }
    return data
  }

  static func isAlphabet(_ byte: UInt8) -> Bool {
    switch byte {
    case UInt8(ascii: "A")...UInt8(ascii: "Z"), UInt8(ascii: "a")...UInt8(ascii: "z"),
         UInt8(ascii: "0")...UInt8(ascii: "9"), UInt8(ascii: "-"), UInt8(ascii: "_"): true
    default: false
    }
  }

  /// Length of the unpadded encoding of `byteCount` bytes.
  public static func encodedLength(byteCount: Int) -> Int { (byteCount * 4 + 2) / 3 }
}

/// The SHA-256 of a secret, as 64 lowercase hex characters: what is stored
/// and compared instead of the secret.
public struct SecretHash: Hashable, Sendable, Codable, CustomStringConvertible {
  public let hex: String

  public init?(hex: String) {
    guard hex.utf8.count == SHA256Hash.byteCount * 2,
          hex.utf8.allSatisfy({ (UInt8(ascii: "0")...UInt8(ascii: "9")).contains($0) || (UInt8(ascii: "a")...UInt8(ascii: "f")).contains($0) })
    else { return nil }
    self.hex = hex
  }

  init(of secret: String) {
    hex = SHA256Hash.hex(Array(secret.utf8))
  }

  /// Constant time, so a lookup does not leak how much of a hash matched.
  public func matches(_ other: SecretHash) -> Bool { ConstantTime.equals(hex, other.hex) }

  public init(from decoder: any Decoder) throws {
    let text = try decoder.singleValueContainer().decode(String.self)
    guard let hash = SecretHash(hex: text) else {
      throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "not a SHA-256 hex hash"))
    }
    self = hash
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(hex)
  }

  /// A prefix only: enough to tell two apart in a log, useless to an attacker.
  public var description: String { "SecretHash(\(hex.prefix(8))…)" }
}

/// What the three secrets share. `value` is the base64url text on the wire.
public protocol GatewaySecret: Sendable, Equatable, CustomStringConvertible {
  static var byteCount: Int { get }
  var value: String { get }
  /// Only for values already checked by init?(_:) or made by generate().
  init(uncheckedValue value: String)
}

extension GatewaySecret {
  /// Nil unless `value` is the canonical base64url of exactly `byteCount`
  /// bytes. Surrounding whitespace is not trimmed: a secret is never typed.
  public init?(_ value: String) {
    guard value.utf8.count == Base64URL.encodedLength(byteCount: Self.byteCount),
          let bytes = Base64URL.decode(value), bytes.count == Self.byteCount
    else { return nil }
    self.init(uncheckedValue: value)
  }

  public static func generate() -> Self {
    var generator = SystemRandomNumberGenerator()
    return generate(using: &generator)
  }

  /// Tests pass a seeded generator; the apps always use generate().
  public static func generate(using generator: inout some RandomNumberGenerator) -> Self {
    let bytes = (0..<byteCount).map { _ in UInt8.random(in: .min ... .max, using: &generator) }
    return Self(uncheckedValue: Base64URL.encode(bytes))
  }

  public var hash: SecretHash { SecretHash(of: value) }

  /// Whether `presented` is this secret, in constant time.
  public func matches(_ presented: String) -> Bool { ConstantTime.equals(value, presented) }

  /// Never the secret itself, so it cannot end up in a log by accident.
  public var description: String { "\(Self.self)(…)" }
}

/// 128 random bits, single use, valid GatewayLimits.pairingCodeLifetime.
public struct PairingCode: GatewaySecret {
  public static let byteCount = 16
  public let value: String
  public init(uncheckedValue value: String) { self.value = value }
}

/// 256 random bits: a paired device's long-lived credential.
public struct DeviceToken: GatewaySecret {
  public static let byteCount = 32
  public let value: String
  public init(uncheckedValue value: String) { self.value = value }
}

/// 256 random bits: the value of the device-session cookie.
public struct DeviceSessionToken: GatewaySecret {
  public static let byteCount = 32
  public let value: String
  public init(uncheckedValue value: String) { self.value = value }
}
