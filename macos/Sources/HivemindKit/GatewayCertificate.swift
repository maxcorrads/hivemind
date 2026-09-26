import Foundation

// The gateway's self-signed certificate (docs/remote-access.md#tls-and-pinning).
// Devices pin its SHA-256 and skip every other check, so it only has to be a
// well-formed X.509 v3 certificate for an ECDSA P-256 key; its name and
// validity carry no trust. Building it is plain DER, here; signing needs the
// private key, which stays in the Keychain, so the caller signs.

/// The DER (X.690) the certificate needs, and nothing more.
public enum DER {
  public static func tlv(_ tag: UInt8, _ content: Data) -> Data {
    var out = Data([tag])
    let length = content.count
    if length < 0x80 {
      out.append(UInt8(length))
    } else {
      var bytes: [UInt8] = []
      var rest = length
      while rest > 0 {
        bytes.insert(UInt8(truncatingIfNeeded: rest), at: 0)
        rest >>= 8
      }
      out.append(0x80 | UInt8(bytes.count))
      out.append(contentsOf: bytes)
    }
    out.append(content)
    return out
  }

  public static func sequence(_ items: [Data]) -> Data { tlv(0x30, items.reduce(Data(), +)) }
  public static func set(_ items: [Data]) -> Data { tlv(0x31, items.reduce(Data(), +)) }

  /// A non-negative INTEGER from big-endian bytes: leading zeros dropped, one
  /// added when the high bit is set.
  public static func unsignedInteger(_ bytes: Data) -> Data {
    var trimmed = Data(bytes.drop { $0 == 0 })
    if trimmed.isEmpty { trimmed = Data([0]) }
    if trimmed.first! & 0x80 != 0 { trimmed.insert(0, at: 0) }
    return tlv(0x02, trimmed)
  }

  public static func integer(_ value: Int) -> Data {
    var bytes = Data()
    var rest = value
    repeat {
      bytes.insert(UInt8(truncatingIfNeeded: rest), at: 0)
      rest >>= 8
    } while rest > 0
    return unsignedInteger(bytes)
  }

  public static func objectIdentifier(_ dotted: String) -> Data {
    let arcs = dotted.split(separator: ".").map { UInt64($0)! }
    var content = Data([UInt8(arcs[0] * 40 + arcs[1])])
    for arc in arcs.dropFirst(2) {
      var chunk: [UInt8] = [UInt8(arc & 0x7F)]
      var rest = arc >> 7
      while rest > 0 {
        chunk.insert(UInt8(rest & 0x7F) | 0x80, at: 0)
        rest >>= 7
      }
      content.append(contentsOf: chunk)
    }
    return tlv(0x06, content)
  }

  public static func utf8String(_ text: String) -> Data { tlv(0x0C, Data(text.utf8)) }
  public static func bitString(_ bytes: Data) -> Data { tlv(0x03, Data([0]) + bytes) }
  public static func octetString(_ bytes: Data) -> Data { tlv(0x04, bytes) }
  public static func boolean(_ value: Bool) -> Data { tlv(0x01, Data([value ? 0xFF : 0x00])) }
  public static func explicit(_ number: UInt8, _ content: Data) -> Data { tlv(0xA0 | number, content) }

  /// UTCTime through 2049, GeneralizedTime after (RFC 5280 §4.1.2.5).
  public static func time(_ date: Date) -> Data {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = TimeZone(identifier: "UTC")!
    let c = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
    let year = c.year!
    func two(_ value: Int) -> String { value < 10 ? "0\(value)" : "\(value)" }
    let rest = two(c.month!) + two(c.day!) + two(c.hour!) + two(c.minute!) + two(c.second!) + "Z"
    if year < 2050 { return tlv(0x17, Data((two(year % 100) + rest).utf8)) }
    return tlv(0x18, Data((String(year) + rest).utf8))
  }
}

public enum GatewayCertificate {
  static let ecPublicKey = "1.2.840.10045.2.1"
  static let prime256v1 = "1.2.840.10045.3.1.7"
  static let ecdsaWithSHA256 = "1.2.840.10045.4.3.2"
  static let commonNameOID = "2.5.4.3"
  static let organizationOID = "2.5.4.10"
  static let basicConstraintsOID = "2.5.29.19"
  static let keyUsageOID = "2.5.29.15"
  static let extendedKeyUsageOID = "2.5.29.37"
  static let serverAuthOID = "1.3.6.1.5.5.7.3.1"

  /// How long the certificate says it is valid. Nothing checks it (devices
  /// pin it), so it is long enough never to matter.
  public static let validity: TimeInterval = 20 * 365 * 24 * 3600

  /// The to-be-signed part of the certificate for a P-256 key given in X9.63
  /// form (0x04 || X || Y, 65 bytes).
  public static func tbsCertificate(publicKeyX963: Data, commonName: String, serial: Data, notBefore: Date, notAfter: Date) -> Data {
    let algorithm = DER.sequence([DER.objectIdentifier(ecdsaWithSHA256)])
    let name = DER.sequence([
      DER.set([DER.sequence([DER.objectIdentifier(organizationOID), DER.utf8String("Hivemind")])]),
      DER.set([DER.sequence([DER.objectIdentifier(commonNameOID), DER.utf8String(commonName)])]),
    ])
    let publicKeyInfo = DER.sequence([
      DER.sequence([DER.objectIdentifier(ecPublicKey), DER.objectIdentifier(prime256v1)]),
      DER.bitString(publicKeyX963),
    ])
    let extensions = DER.sequence([
      // Not a CA: it signs nothing but itself.
      DER.sequence([DER.objectIdentifier(basicConstraintsOID), DER.boolean(true), DER.octetString(DER.sequence([]))]),
      // digitalSignature only (bit 0): the TLS 1.3 handshake signature.
      DER.sequence([DER.objectIdentifier(keyUsageOID), DER.boolean(true), DER.octetString(DER.tlv(0x03, Data([0x07, 0x80])))]),
      DER.sequence([DER.objectIdentifier(extendedKeyUsageOID), DER.octetString(DER.sequence([DER.objectIdentifier(serverAuthOID)]))]),
    ])
    return DER.sequence([
      DER.explicit(0, DER.integer(2)),
      DER.unsignedInteger(serial),
      algorithm,
      name,
      DER.sequence([DER.time(notBefore), DER.time(notAfter)]),
      name,
      publicKeyInfo,
      DER.explicit(3, extensions),
    ])
  }

  /// The whole certificate: `sign` gets the TBS bytes and returns an ECDSA
  /// signature over their SHA-256 in DER (what SecKeyCreateSignature makes
  /// with .ecdsaSignatureMessageX962SHA256).
  public static func make(
    publicKeyX963: Data, commonName: String, now: Date, serial: Data = randomSerial(),
    sign: (Data) throws -> Data
  ) rethrows -> Data {
    let tbs = tbsCertificate(publicKeyX963: publicKeyX963, commonName: commonName, serial: serial,
                             notBefore: now.addingTimeInterval(-24 * 3600), notAfter: now.addingTimeInterval(validity))
    let signature = try sign(tbs)
    return DER.sequence([tbs, DER.sequence([DER.objectIdentifier(ecdsaWithSHA256)]), DER.bitString(signature)])
  }

  /// 16 random bytes, positive (RFC 5280 wants at most 20 octets).
  public static func randomSerial() -> Data {
    var generator = SystemRandomNumberGenerator()
    var bytes = (0..<16).map { _ in UInt8.random(in: .min ... .max, using: &generator) }
    bytes[0] &= 0x7F
    bytes[0] |= 0x01
    return Data(bytes)
  }
}
