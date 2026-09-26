import Foundation

/// The SHA-256 of the gateway's certificate (its DER bytes): what a device
/// pins. It comes from the QR code, never from the network, and a device
/// accepts a TLS connection only when the certificate the server presents
/// hashes to it. The hash covers the whole certificate, so a new identity
/// (Hivemind Server regenerated it) means pairing again.
public struct CertificateFingerprint: Hashable, Sendable, Codable, CustomStringConvertible {
  public let bytes: Data

  public init(certificateDER: Data) {
    bytes = SHA256Hash.hash(certificateDER)
  }

  /// Strict: 64 lowercase hex characters, the form in the QR code and the
  /// TXT record.
  public init?(hex: String) {
    guard hex.utf8.count == 64, hex.utf8.allSatisfy({ !(UInt8(ascii: "A")...UInt8(ascii: "F")).contains($0) }),
          let bytes = Hex.decode(hex)
    else { return nil }
    self.bytes = bytes
  }

  /// Lenient, for a fingerprint a person copies from the Mac: any case,
  /// with or without `:`, spaces or dashes between the digits.
  public init?(display text: String) {
    let digits = text.filter { !":- ".contains($0) }
    guard digits.utf8.count == 64, let bytes = Hex.decode(digits) else { return nil }
    self.bytes = bytes
  }

  /// 64 lowercase hex characters.
  public var hex: String { Hex.encode(bytes) }

  /// "AB:CD:…" in 32 uppercase pairs, as Keychain Access and Safari show a
  /// certificate's SHA-256, so a person can compare them.
  public var display: String {
    Hex.encode(bytes).uppercased().chunked(2).joined(separator: ":")
  }

  /// The first and last 4 bytes ("AB:CD:EF:01…23:45:67:89"), short enough
  /// to read aloud and compare on both screens when pairing.
  public var short: String {
    let pairs = Hex.encode(bytes).uppercased().chunked(2)
    return pairs.prefix(4).joined(separator: ":") + "…" + pairs.suffix(4).joined(separator: ":")
  }

  /// Whether `certificateDER` is the pinned certificate, in constant time.
  public func matches(certificateDER: Data) -> Bool {
    ConstantTime.equals(bytes, SHA256Hash.hash(certificateDER))
  }

  public init(from decoder: any Decoder) throws {
    let text = try decoder.singleValueContainer().decode(String.self)
    guard let fingerprint = CertificateFingerprint(hex: text) else {
      throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "not a SHA-256 fingerprint"))
    }
    self = fingerprint
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(hex)
  }

  public var description: String { "CertificateFingerprint(\(short))" }
}

private extension String {
  func chunked(_ size: Int) -> [String] {
    var out: [String] = []
    var index = startIndex
    while index < endIndex {
      let end = self.index(index, offsetBy: size, limitedBy: endIndex) ?? endIndex
      out.append(String(self[index..<end]))
      index = end
    }
    return out
  }
}
