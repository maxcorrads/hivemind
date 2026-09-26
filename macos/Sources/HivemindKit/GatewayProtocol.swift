import Foundation

// The wire contract between the iOS app and Hivemind Server.app's remote
// gateway (docs/remote-access.md#protocol). Both sides build and read every
// message through these types, so the two cannot drift apart.

public enum GatewayProtocol {
  /// Bumped on an incompatible change; in the pairing payload (`v`), the
  /// Bonjour TXT record and every gateway JSON reply.
  public static let version = 1
}

/// The gateway's own endpoints. Everything under `prefix` is answered by the
/// gateway and never proxied to the Node server (which has no such routes),
/// so a device can never reach the server's side of these names.
public enum GatewayPath {
  public static let prefix = "/_hivemind/"
  /// POST {code, deviceName, platform} → PairResponse. No session needed.
  public static let pair = "/_hivemind/pair"
  /// POST with `Authorization: Bearer <device token>` → SessionResponse and
  /// the device-session cookie.
  public static let session = "/_hivemind/session"
  /// WebSocket (wss) upgrade: the terminal broker, device session required.
  public static let broker = "/_hivemind/broker"
  /// The Node server's own WebSocket, proxied.
  public static let serverWebSocket = "/ws"

  /// Whether the gateway answers `path` itself. `path` is the request
  /// target's path, without the query.
  public static func isGatewayOwned(_ path: String) -> Bool {
    path == "/_hivemind" || path.hasPrefix(prefix)
  }
}

/// Header and cookie names the gateway and the app agree on.
public enum GatewayHeader {
  public static let authorization = "Authorization"
  /// "Bearer " + DeviceToken.value, only on POST /_hivemind/session.
  public static let bearerPrefix = "Bearer "

  /// Pulls the device token out of an Authorization value; nil unless it
  /// is exactly "Bearer <token>".
  public static func deviceToken(fromAuthorization value: String) -> DeviceToken? {
    guard value.hasPrefix(bearerPrefix) else { return nil }
    return DeviceToken(String(value.dropFirst(bearerPrefix.count)))
  }
}

/// The device-session cookie. `__Host-` makes the browser insist on Secure,
/// Path=/ and no Domain, so it is bound to the exact gateway origin.
public enum DeviceSessionCookie {
  public static let name = "__Host-hivemind-device"

  /// The Set-Cookie value for a new session. HttpOnly keeps it from the
  /// page's scripts; SameSite=Strict from other sites' requests.
  public static func setCookie(_ token: DeviceSessionToken, maxAge: TimeInterval = GatewayLimits.sessionLifetime) -> String {
    "\(name)=\(token.value); Path=/; Max-Age=\(Int(maxAge)); Secure; HttpOnly; SameSite=Strict"
  }

  /// The session token in a Cookie header, or nil when it is missing,
  /// malformed or present more than once (fails closed, like the Node
  /// server's own cookie parsing).
  public static func token(fromCookieHeader header: String) -> DeviceSessionToken? {
    var found: String?
    for pair in header.split(separator: ";") {
      let trimmed = pair.trimmingCharacters(in: .whitespaces)
      guard let equals = trimmed.firstIndex(of: "="), trimmed[..<equals] == name else { continue }
      guard found == nil else { return nil }
      found = String(trimmed[trimmed.index(after: equals)...])
    }
    return found.flatMap(DeviceSessionToken.init)
  }
}

/// What a device runs, from PairRequest.platform.
public enum DevicePlatform: String, Codable, Sendable, CaseIterable {
  case ios
  case ipados
}

/// Where a device reaches one gateway: a host (an IP address, or a `.local`
/// name Bonjour resolved) and a port. The origin is what the device's web
/// view loads and what every request's Origin must equal.
public struct GatewayEndpoint: Hashable, Sendable, CustomStringConvertible {
  public let host: String
  public let port: Int

  /// `host` is an IP address in any accepted form, or a DNS name; IP
  /// addresses are kept in canonical form so equal endpoints compare equal.
  public init?(host: String, port: Int) {
    guard (1...65535).contains(port), let host = Self.canonicalHost(host) else { return nil }
    self.host = host
    self.port = port
  }

  public var address: IPAddress? { IPAddress(host) }

  /// The host as it goes in a URL and in Host/Origin: IPv6 bracketed.
  public var urlHost: String { address?.urlHost ?? host }

  /// `https://host:port`, always with the port: the gateway never runs on 443.
  public var origin: String { "https://\(urlHost):\(port)" }

  public var baseURL: URL { URL(string: origin + "/")! }
  public var pairURL: URL { URL(string: origin + GatewayPath.pair)! }
  public var sessionURL: URL { URL(string: origin + GatewayPath.session)! }
  public var brokerURL: URL { URL(string: "wss://\(urlHost):\(port)\(GatewayPath.broker)")! }

  /// Whether `url` is on this exact origin (scheme, host, port; no user info).
  public func isSameOrigin(_ url: URL) -> Bool {
    guard url.user == nil, url.password == nil, let port = url.port, port == self.port,
          let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "wss",
          let host = url.host(percentEncoded: false)
    else { return false }
    return Self.canonicalHost(host) == self.host
  }

  public var description: String { "\(urlHost):\(port)" }

  /// Canonical IP text, or a lowercase DNS name of letters, digits, `-` and
  /// dots; nil for anything else (user info, paths, spaces, a trailing dot).
  static func canonicalHost(_ host: String) -> String? {
    if let address = IPAddress(host) { return address.description }
    let lower = host.lowercased()
    guard (1...253).contains(lower.utf8.count), !lower.hasSuffix("."), !lower.hasPrefix("."),
          lower.utf8.allSatisfy({ (UInt8(ascii: "a")...UInt8(ascii: "z")).contains($0) || (UInt8(ascii: "0")...UInt8(ascii: "9")).contains($0) || $0 == UInt8(ascii: "-") || $0 == UInt8(ascii: ".") }),
          !lower.contains("..")
    else { return nil }
    return lower
  }
}

// MARK: - Messages

/// POST /_hivemind/pair body.
public struct PairRequest: Codable, Equatable, Sendable {
  public let code: String
  public let deviceName: String
  public let platform: DevicePlatform

  public init(code: PairingCode, deviceName: String, platform: DevicePlatform) {
    self.code = code.value
    self.deviceName = deviceName
    self.platform = platform
  }

  /// The checks the gateway runs before looking at the code: every failure
  /// is `bad-request`, never a code attempt.
  public func validated() throws(GatewayError) -> (code: PairingCode, deviceName: String) {
    guard let code = PairingCode(code) else { throw GatewayError(.badRequest, "code: not a pairing code") }
    guard let name = DeviceName.validate(deviceName) else {
      throw GatewayError(.badRequest, "deviceName: 1–\(GatewayLimits.maxDeviceNameCharacters) characters, no control characters")
    }
    return (code, name)
  }
}

/// A successful pairing. The token is shown to the device exactly once; the
/// gateway keeps only its hash.
public struct PairResponse: Codable, Equatable, Sendable {
  public let v: Int
  public let deviceId: String
  public let token: String
  /// The Mac's name, for the device's list of saved Macs.
  public let name: String

  public init(deviceId: UUID, token: DeviceToken, name: String) {
    v = GatewayProtocol.version
    self.deviceId = deviceId.uuidString.lowercased()
    self.token = token.value
    self.name = name
  }
}

/// A new device session. The app puts the cookie into the web view's cookie
/// store itself (URLSession's Set-Cookie never reaches WKWebView), so the
/// reply carries it in the body as well as in Set-Cookie.
public struct SessionResponse: Codable, Equatable, Sendable {
  public let v: Int
  public let cookieName: String
  public let cookieValue: String
  /// Unix milliseconds.
  public let expiresAt: Int64
  /// The Mac user's home folder (absolute), so the device can resolve "~"
  /// and a launch without a folder the way the Mac app does. Not new to a
  /// paired device, which can run commands on the Mac anyway; optional so
  /// either side reads the other's older replies.
  public let home: String?

  public init(token: DeviceSessionToken, expiresAt: Date, home: String? = nil) {
    v = GatewayProtocol.version
    cookieName = DeviceSessionCookie.name
    cookieValue = token.value
    self.expiresAt = Int64((expiresAt.timeIntervalSince1970 * 1000).rounded(.down))
    self.home = home
  }

  public var expiry: Date { Date(timeIntervalSince1970: TimeInterval(expiresAt) / 1000) }
}

/// Every gateway error body is `{"v":1,"error":<code>,"message":<text>}`.
public enum GatewayErrorCode: String, Codable, Sendable, CaseIterable {
  /// Malformed JSON, wrong media type, a field out of range. 400.
  case badRequest = "bad-request"
  /// The pairing code is wrong, used or expired. The same code for all
  /// three, so a guess learns nothing. 403.
  case invalidCode = "invalid-code"
  /// Too many wrong codes: pairing is locked until the Mac shows a new
  /// code. 423.
  case pairingLocked = "pairing-locked"
  /// No pairing window is open on the Mac. 403.
  case pairingClosed = "pairing-closed"
  /// maxDevices reached. 409.
  case tooManyDevices = "too-many-devices"
  /// Too many attempts from this address. 429.
  case rateLimited = "rate-limited"
  /// No, or an unknown or revoked, device token or device session. The app
  /// asks for a new session once, then offers to pair again. 401.
  case unauthorized
  /// A request whose Origin is not the gateway's origin. 403.
  case forbiddenOrigin = "forbidden-origin"
  /// A request head or body over its limit. 413 / 431.
  case tooLarge = "too-large"
  /// An unknown /_hivemind/ path. 404.
  case notFound = "not-found"
  /// The Node server (or the broker) is not running or did not answer. 502.
  case serverUnavailable = "server-unavailable"
  /// Anything else. A client reads an unknown code as this too. 500.
  case `internal`

  public init(from decoder: any Decoder) throws {
    self = GatewayErrorCode(rawValue: try decoder.singleValueContainer().decode(String.self)) ?? .internal
  }

  public var httpStatus: Int {
    switch self {
    case .badRequest: 400
    case .unauthorized: 401
    case .invalidCode, .pairingClosed, .forbiddenOrigin: 403
    case .notFound: 404
    case .tooManyDevices: 409
    case .tooLarge: 413
    case .pairingLocked: 423
    case .rateLimited: 429
    case .internal: 500
    case .serverUnavailable: 502
    }
  }
}

public struct GatewayError: Error, Equatable, Sendable, Codable, LocalizedError {
  public let v: Int
  public let error: GatewayErrorCode
  public let message: String

  public init(_ code: GatewayErrorCode, _ message: String) {
    v = GatewayProtocol.version
    error = code
    self.message = message
  }

  public var code: GatewayErrorCode { error }
  public var errorDescription: String? { message }
}

/// Names a person gives a device ("Anna's iPhone"): trimmed, 1–64
/// characters, no control characters and no invisible format characters
/// (bidi overrides could make a name in the Devices list read as another),
/// except the zero-width joiner emoji need.
public enum DeviceName {
  public static func validate(_ name: String, limit: Int = GatewayLimits.maxDeviceNameCharacters) -> String? {
    let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
    guard (1...limit).contains(trimmed.count),
          !trimmed.unicodeScalars.contains(where: { $0.properties.generalCategory == .control || ($0.properties.generalCategory == .format && $0.value != 0x200D) })
    else { return nil }
    return trimmed
  }
}

// MARK: - Bonjour

/// The gateway's Bonjour advertisement. The TXT record helps a device find
/// a Mac it has already paired with when that Mac's address changed; the
/// device still pins the fingerprint it got from the QR code. A TXT record
/// is never trusted for pairing: anyone on the network can advertise one.
public struct GatewayAdvertisement: Equatable, Sendable {
  public static let serviceType = "_hivemind._tcp"

  public let version: Int
  public let fingerprint: CertificateFingerprint
  public let name: String

  public init(fingerprint: CertificateFingerprint, name: String, version: Int = GatewayProtocol.version) {
    self.version = version
    self.fingerprint = fingerprint
    self.name = String(name.prefix(GatewayLimits.maxMacNameCharacters))
  }

  /// Keys stay short: every TXT entry is at most 255 bytes.
  public var txtRecord: [String: String] {
    ["v": String(version), "fp": fingerprint.hex, "name": name]
  }

  public init?(txtRecord: [String: String]) {
    guard let v = txtRecord["v"].flatMap(Int.init), v >= 1,
          let fp = txtRecord["fp"].flatMap(CertificateFingerprint.init(hex:)),
          let name = txtRecord["name"].flatMap({ DeviceName.validate($0, limit: GatewayLimits.maxMacNameCharacters) })
    else { return nil }
    version = v
    fingerprint = fp
    self.name = name
  }
}
