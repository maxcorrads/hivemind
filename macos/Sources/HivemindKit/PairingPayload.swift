import Foundation

/// What the pairing QR code (and the pairing link a person can paste
/// instead) carries (docs/remote-access.md#pairing):
///
///     hivemind-pair://pair?v=1&name=Studio%20Mac&host=192.168.1.20&host=100.101.102.103
///       &port=7443&fp=<64 hex>&code=<22 base64url>
///
/// A query rather than JSON: it needs no escaping for the common case, keeps
/// the QR code small, and every field is still checked strictly. `host`
/// repeats, in the order to try; other keys appear once. Keys this version
/// does not know are ignored, so a later minor addition does not break an
/// older app; a higher `v` is refused.
public struct PairingPayload: Equatable, Sendable {
  public static let scheme = "hivemind-pair"
  /// The URL's host part: "hivemind-pair://pair?…".
  public static let action = "pair"

  public let version: Int
  /// The Mac's name, shown while pairing and kept as the saved Mac's name.
  public let name: String
  /// Private addresses of the Mac, in the order to try (RemoteAddressPolicy.pairingHosts).
  public let hosts: [IPAddress]
  public let port: Int
  /// The gateway certificate the device will pin.
  public let fingerprint: CertificateFingerprint
  public let code: PairingCode

  public init(name: String, hosts: [IPAddress], port: Int, fingerprint: CertificateFingerprint, code: PairingCode) throws(PairingPayloadError) {
    try self.init(version: GatewayProtocol.version, name: name, hosts: hosts, port: port, fingerprint: fingerprint, code: code)
  }

  init(version: Int, name: String, hosts: [IPAddress], port: Int, fingerprint: CertificateFingerprint, code: PairingCode) throws(PairingPayloadError) {
    guard version >= 1 else { throw .invalid("v", "must be a positive integer") }
    guard version <= GatewayProtocol.version else { throw .unsupportedVersion(version) }
    guard let name = DeviceName.validate(name, limit: GatewayLimits.maxMacNameCharacters) else {
      throw .invalid("name", "1–\(GatewayLimits.maxMacNameCharacters) characters, no control characters")
    }
    guard (1...GatewayLimits.maxPairingHosts).contains(hosts.count) else {
      throw .invalid("host", "1–\(GatewayLimits.maxPairingHosts) addresses")
    }
    for host in hosts {
      guard RemoteAddressPolicy.isPrivate(host) else { throw .invalid("host", "\(host) is not a private address") }
      if case .v6(_, let zone) = host, zone != nil { throw .invalid("host", "\(host) has a zone") }
    }
    guard Set(hosts).count == hosts.count else { throw .invalid("host", "repeats an address") }
    guard (1...65535).contains(port) else { throw .invalid("port", "must be 1–65535") }
    self.version = version
    self.name = name
    self.hosts = hosts
    self.port = port
    self.fingerprint = fingerprint
    self.code = code
  }

  /// The endpoints to try, in order.
  public var endpoints: [GatewayEndpoint] {
    hosts.compactMap { GatewayEndpoint(host: $0.description, port: port) }
  }

  /// The pairing link, and the QR code's content.
  public var url: URL {
    var components = URLComponents()
    components.scheme = Self.scheme
    components.host = Self.action
    components.queryItems = [URLQueryItem(name: "v", value: String(version)), URLQueryItem(name: "name", value: name)]
      + hosts.map { URLQueryItem(name: "host", value: $0.description) }
      + [
        URLQueryItem(name: "port", value: String(port)),
        URLQueryItem(name: "fp", value: fingerprint.hex),
        URLQueryItem(name: "code", value: code.value),
      ]
    // URLComponents leaves `+` alone in a query, where some readers take it
    // for a space; a Mac name is the only field that can hold one.
    components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
    return components.url!
  }

  /// Reads a scanned QR code or a pasted link. Surrounding whitespace (a
  /// paste often has a newline) is ignored; nothing else is forgiven.
  public init(link: String) throws(PairingPayloadError) {
    let text = link.trimmingCharacters(in: .whitespacesAndNewlines)
    guard text.utf8.count <= GatewayLimits.maxPairingLinkBytes else { throw .invalid("link", "is too long") }
    guard let components = URLComponents(string: text),
          components.scheme?.lowercased() == Self.scheme,
          components.host?.lowercased() == Self.action,
          components.user == nil, components.password == nil, components.port == nil,
          components.path.isEmpty || components.path == "/",
          components.fragment == nil
    else { throw .notAPairingLink }

    var single: [String: String] = [:]
    var hosts: [IPAddress] = []
    for item in components.queryItems ?? [] {
      guard let value = item.value else { throw .invalid(item.name, "has no value") }
      switch item.name {
      case "host":
        guard let address = IPAddress(value) else { throw .invalid("host", "\(value) is not an IP address") }
        hosts.append(address)
      case "v", "name", "port", "fp", "code":
        guard single.updateValue(value, forKey: item.name) == nil else { throw .invalid(item.name, "appears twice") }
      default:
        continue
      }
    }
    func required(_ key: String) throws(PairingPayloadError) -> String {
      guard let value = single[key] else { throw .invalid(key, "is missing") }
      return value
    }
    let versionText = try required("v")
    guard let version = Self.decimal(versionText) else { throw .invalid("v", "must be a positive integer") }
    // A newer payload may mean other fields entirely: say so before anything else.
    guard version <= GatewayProtocol.version else { throw .unsupportedVersion(version) }
    guard let port = Self.decimal(try required("port")) else { throw .invalid("port", "must be 1–65535") }
    guard let fingerprint = CertificateFingerprint(hex: try required("fp")) else {
      throw .invalid("fp", "must be 64 lowercase hex characters")
    }
    guard let code = PairingCode(try required("code")) else { throw .invalid("code", "is not a pairing code") }
    try self.init(version: version, name: try required("name"), hosts: hosts, port: port, fingerprint: fingerprint, code: code)
  }

  /// Plain decimal only: no sign, no leading zeros, at most 5 digits.
  private static func decimal(_ text: String) -> Int? {
    guard (1...5).contains(text.utf8.count), text.utf8.allSatisfy({ (UInt8(ascii: "0")...UInt8(ascii: "9")).contains($0) }),
          !text.hasPrefix("0")
    else { return nil }
    return Int(text)
  }
}

public enum PairingPayloadError: Error, Equatable, Sendable, LocalizedError {
  /// Not a hivemind-pair:// link at all (another QR code, say).
  case notAPairingLink
  /// Made by a newer Hivemind Server: the app needs an update.
  case unsupportedVersion(Int)
  /// A field is missing or wrong.
  case invalid(String, String)

  public var errorDescription: String? {
    switch self {
    case .notAPairingLink: "This is not a Hivemind pairing code."
    case .unsupportedVersion: "This pairing code comes from a newer Hivemind Server. Update the app to pair."
    case .invalid(let field, let reason): "The pairing code is damaged (\(field) \(reason))."
    }
  }
}
