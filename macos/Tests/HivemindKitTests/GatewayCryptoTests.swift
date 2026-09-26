import Foundation
import Testing
@testable import HivemindKit

// SHA-256, hex, base64url, constant-time comparison and the gateway's
// secrets. Nothing here touches the network or the Keychain.

/// A deterministic generator (SplitMix64) so generated secrets are testable.
struct SeededGenerator: RandomNumberGenerator {
  var state: UInt64
  mutating func next() -> UInt64 {
    state &+= 0x9E37_79B9_7F4A_7C15
    var z = state
    z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
    z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
    return z ^ (z >> 31)
  }
}

struct SHA256Tests {
  // FIPS 180-4 / NIST CAVP vectors.
  static let vectors: [(String, String)] = [
    ("", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
    ("abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"),
    ("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq", "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"),
    ("abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu",
     "cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1"),
  ]

  @Test(arguments: vectors)
  func knownVectors(input: String, expected: String) {
    #expect(SHA256Hash.hex(Array(input.utf8)) == expected)
    #expect(Hex.encode(PortableSHA256.hash(Array(input.utf8))) == expected)
  }

  @Test func millionAs() {
    let input = [UInt8](repeating: UInt8(ascii: "a"), count: 1_000_000)
    #expect(SHA256Hash.hex(input) == "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0")
  }

  /// The portable implementation agrees with the one in use across every
  /// padding boundary (55, 56, 63, 64, 119, 120 bytes…).
  @Test func portableAgreesAcrossPaddingBoundaries() {
    var generator = SeededGenerator(state: 7)
    for length in 0...200 {
      let bytes = (0..<length).map { _ in UInt8.random(in: .min ... .max, using: &generator) }
      #expect(PortableSHA256.hash(bytes) == SHA256Hash.hash(bytes), "length \(length)")
    }
  }
}

struct HexAndBase64URLTests {
  @Test func hexRoundTrips() {
    #expect(Hex.encode([0x00, 0x0f, 0xa0, 0xff]) == "000fa0ff")
    #expect(Hex.decode("000fa0ff") == Data([0x00, 0x0f, 0xa0, 0xff]))
    #expect(Hex.decode("000FA0FF") == Data([0x00, 0x0f, 0xa0, 0xff]))
    #expect(Hex.decode("") == Data())
    for bad in ["0", "0g", "+1", " 01", "0x01"] { #expect(Hex.decode(bad) == nil, "\(bad)") }
  }

  @Test func base64URLIsUnpaddedAndStrict() {
    #expect(Base64URL.encode([0xfb, 0xff]) == "-_8")
    #expect(Base64URL.decode("-_8") == Data([0xfb, 0xff]))
    #expect(Base64URL.encode([]) == "")
    #expect(Base64URL.encodedLength(byteCount: 16) == 22)
    #expect(Base64URL.encodedLength(byteCount: 32) == 43)
    // Padding, the standard alphabet, whitespace, an impossible length and
    // a non-canonical last character are all refused.
    for bad in ["-_8=", "+/8", "-_ 8", "A", "-_9"] { #expect(Base64URL.decode(bad) == nil, "\(bad)") }
  }

  @Test func constantTimeEquals() {
    #expect(ConstantTime.equals("abc", "abc"))
    #expect(!ConstantTime.equals("abc", "abd"))
    #expect(!ConstantTime.equals("abc", "ab"))
    #expect(!ConstantTime.equals("ab", "abc"))
    #expect(ConstantTime.equals("", ""))
    #expect(!ConstantTime.equals([UInt8](), [0]))
  }
}

struct GatewaySecretTests {
  @Test func lengthsAndEntropy() {
    #expect(PairingCode.generate().value.utf8.count == 22)
    #expect(DeviceToken.generate().value.utf8.count == 43)
    #expect(DeviceSessionToken.generate().value.utf8.count == 43)
    let many = Set((0..<200).map { _ in DeviceToken.generate().value })
    #expect(many.count == 200)
  }

  @Test func generationUsesTheGivenGenerator() {
    var a = SeededGenerator(state: 42), b = SeededGenerator(state: 42)
    #expect(DeviceToken.generate(using: &a) == DeviceToken.generate(using: &b))
    let code = PairingCode.generate(using: &a)
    #expect(PairingCode(code.value) == code)
  }

  @Test func parsingIsStrict() {
    let token = DeviceToken.generate()
    #expect(DeviceToken(token.value) == token)
    #expect(DeviceToken(token.value + "A") == nil)
    #expect(DeviceToken(String(token.value.dropLast())) == nil)
    #expect(DeviceToken(" " + token.value) == nil)
    #expect(DeviceToken(String(repeating: "=", count: 43)) == nil)
    // A pairing code is not a device token, nor the other way round.
    #expect(DeviceToken(PairingCode.generate().value) == nil)
    #expect(PairingCode(token.value) == nil)
  }

  @Test func hashIsSHA256OfTheText() {
    let token = DeviceToken("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")!
    #expect(token.hash.hex == SHA256Hash.hex(Array(token.value.utf8)))
    #expect(token.hash.matches(DeviceToken(token.value)!.hash))
    #expect(!token.hash.matches(DeviceToken.generate().hash))
  }

  @Test func matchesInConstantTime() {
    let code = PairingCode.generate()
    #expect(code.matches(code.value))
    #expect(!code.matches(PairingCode.generate().value))
    #expect(!code.matches(""))
  }

  @Test func descriptionsNeverShowTheSecret() {
    let token = DeviceToken.generate()
    #expect(!"\(token)".contains(token.value))
    #expect("\(token)" == "DeviceToken(…)")
    #expect(!"\(token.hash)".contains(token.hash.hex))
  }

  @Test func secretHashCodable() throws {
    let hash = DeviceToken.generate().hash
    let data = try JSONEncoder().encode(hash)
    #expect(try JSONDecoder().decode(SecretHash.self, from: data) == hash)
    #expect(throws: DecodingError.self) { try JSONDecoder().decode(SecretHash.self, from: Data("\"ABC\"".utf8)) }
    #expect(SecretHash(hex: String(repeating: "A", count: 64)) == nil)
  }
}

struct CertificateFingerprintTests {
  let der = Data("not really a certificate, but bytes all the same".utf8)

  @Test func hashesTheDER() {
    let fingerprint = CertificateFingerprint(certificateDER: der)
    #expect(fingerprint.hex == SHA256Hash.hex(der))
    #expect(fingerprint.matches(certificateDER: der))
    #expect(!fingerprint.matches(certificateDER: der + Data([0])))
  }

  @Test func formats() {
    let fingerprint = CertificateFingerprint(hex: "0123456789abcdef" + String(repeating: "00", count: 24))!
    #expect(fingerprint.display.hasPrefix("01:23:45:67:89:AB:CD:EF:00"))
    #expect(fingerprint.display.split(separator: ":").count == 32)
    #expect(fingerprint.short == "01:23:45:67…00:00:00:00")
    #expect(CertificateFingerprint(display: fingerprint.display) == fingerprint)
    #expect(CertificateFingerprint(display: fingerprint.hex.uppercased()) == fingerprint)
    #expect(!"\(fingerprint)".contains(fingerprint.hex))
  }

  @Test func strictHex() {
    let hex = String(repeating: "ab", count: 32)
    #expect(CertificateFingerprint(hex: hex) != nil)
    #expect(CertificateFingerprint(hex: hex.uppercased()) == nil)
    #expect(CertificateFingerprint(hex: String(hex.dropLast())) == nil)
    #expect(CertificateFingerprint(hex: hex + "ab") == nil)
    #expect(CertificateFingerprint(display: "AB:CD") == nil)
  }

  @Test func codableAsHex() throws {
    let fingerprint = CertificateFingerprint(certificateDER: der)
    let data = try JSONEncoder().encode(fingerprint)
    #expect(String(decoding: data, as: UTF8.self) == "\"\(fingerprint.hex)\"")
    #expect(try JSONDecoder().decode(CertificateFingerprint.self, from: data) == fingerprint)
  }
}
