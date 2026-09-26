import Foundation
#if canImport(CryptoKit)
import CryptoKit
#endif

// SHA-256 for the remote gateway (docs/remote-access.md): certificate
// fingerprints and the hashes of device tokens and session tokens.
//
// HivemindKit is otherwise Foundation only. CryptoKit is an Apple system
// framework on every platform HivemindKit builds for (macOS 13, iOS 26), with
// no UI and no third-party code, so it is used when present. The portable
// implementation below is always compiled and always tested against the same
// vectors, so the kit keeps building (and hashing identically) where CryptoKit
// is missing, and the two cannot silently disagree.

public enum SHA256Hash {
  public static let byteCount = 32

  public static func hash(_ data: some DataProtocol) -> Data {
    #if canImport(CryptoKit)
    Data(CryptoKit.SHA256.hash(data: Data(data)))
    #else
    PortableSHA256.hash(Array(data))
    #endif
  }

  /// Lowercase hex of `hash(data)`: 64 characters.
  public static func hex(_ data: some DataProtocol) -> String {
    Hex.encode(hash(data))
  }
}

/// FIPS 180-4 SHA-256 in plain Swift. Slow next to CryptoKit and only ever
/// run on small inputs (tokens, certificates).
enum PortableSHA256 {
  private static let k: [UInt32] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]

  static func hash(_ message: [UInt8]) -> Data {
    var h: [UInt32] = [
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]
    var padded = message
    padded.append(0x80)
    while padded.count % 64 != 56 { padded.append(0) }
    let bitLength = UInt64(message.count) &* 8
    for shift in stride(from: 56, through: 0, by: -8) { padded.append(UInt8(truncatingIfNeeded: bitLength >> UInt64(shift))) }

    var w = [UInt32](repeating: 0, count: 64)
    for chunk in stride(from: 0, to: padded.count, by: 64) {
      for i in 0..<16 {
        let j = chunk + i * 4
        w[i] = UInt32(padded[j]) << 24 | UInt32(padded[j + 1]) << 16 | UInt32(padded[j + 2]) << 8 | UInt32(padded[j + 3])
      }
      for i in 16..<64 {
        let s0 = w[i - 15].rotatedRight(7) ^ w[i - 15].rotatedRight(18) ^ (w[i - 15] >> 3)
        let s1 = w[i - 2].rotatedRight(17) ^ w[i - 2].rotatedRight(19) ^ (w[i - 2] >> 10)
        w[i] = w[i - 16] &+ s0 &+ w[i - 7] &+ s1
      }
      var (a, b, c, d, e, f, g, hh) = (h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7])
      for i in 0..<64 {
        let s1 = e.rotatedRight(6) ^ e.rotatedRight(11) ^ e.rotatedRight(25)
        let choice = (e & f) ^ (~e & g)
        let t1 = hh &+ s1 &+ choice &+ k[i] &+ w[i]
        let s0 = a.rotatedRight(2) ^ a.rotatedRight(13) ^ a.rotatedRight(22)
        let majority = (a & b) ^ (a & c) ^ (b & c)
        let t2 = s0 &+ majority
        (hh, g, f, e, d, c, b, a) = (g, f, e, d &+ t1, c, b, a, t1 &+ t2)
      }
      h[0] &+= a; h[1] &+= b; h[2] &+= c; h[3] &+= d
      h[4] &+= e; h[5] &+= f; h[6] &+= g; h[7] &+= hh
    }
    var digest = Data(capacity: 32)
    for word in h {
      digest.append(contentsOf: [UInt8(word >> 24), UInt8(truncatingIfNeeded: word >> 16), UInt8(truncatingIfNeeded: word >> 8), UInt8(truncatingIfNeeded: word)])
    }
    return digest
  }
}

private extension UInt32 {
  func rotatedRight(_ count: UInt32) -> UInt32 { (self >> count) | (self << (32 - count)) }
}

/// Lowercase hex, the form every hash and fingerprint takes on the wire.
public enum Hex {
  public static func encode(_ bytes: some Sequence<UInt8>) -> String {
    let digits = Array("0123456789abcdef".utf8)
    var out = [UInt8]()
    for byte in bytes {
      out.append(digits[Int(byte >> 4)])
      out.append(digits[Int(byte & 0x0f)])
    }
    return String(decoding: out, as: UTF8.self)
  }

  /// Nil unless `text` is an even number of hex digits (either case).
  public static func decode(_ text: String) -> Data? {
    let bytes = Array(text.utf8)
    guard bytes.count % 2 == 0 else { return nil }
    var out = Data(capacity: bytes.count / 2)
    var index = 0
    while index < bytes.count {
      guard let high = nibble(bytes[index]), let low = nibble(bytes[index + 1]) else { return nil }
      out.append(high << 4 | low)
      index += 2
    }
    return out
  }

  public static func isDigit(_ byte: UInt8) -> Bool { nibble(byte) != nil }

  private static func nibble(_ byte: UInt8) -> UInt8? {
    switch byte {
    case UInt8(ascii: "0")...UInt8(ascii: "9"): byte - UInt8(ascii: "0")
    case UInt8(ascii: "a")...UInt8(ascii: "f"): byte - UInt8(ascii: "a") + 10
    case UInt8(ascii: "A")...UInt8(ascii: "F"): byte - UInt8(ascii: "A") + 10
    default: nil
    }
  }
}

/// Comparison whose time does not depend on where the inputs first differ,
/// for every secret and every hash of one. Length is not secret here: every
/// value compared has a fixed, public length.
public enum ConstantTime {
  public static func equals(_ a: some Collection<UInt8>, _ b: some Collection<UInt8>) -> Bool {
    let a = Array(a), b = Array(b)
    var difference = UInt8(a.count == b.count ? 0 : 1)
    for index in 0..<a.count {
      difference |= a[index] ^ (index < b.count ? b[index] : 0)
    }
    return difference == 0
  }

  public static func equals(_ a: String, _ b: String) -> Bool {
    equals(Array(a.utf8), Array(b.utf8))
  }
}
