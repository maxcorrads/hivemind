import Foundation

// The iOS app's side of the gateway's own endpoints (docs/remote-access.md#protocol):
// POST /_hivemind/pair and POST /_hivemind/session. Requests are built and
// replies read here, over a RemoteHTTPTransport the app implements with an
// ephemeral, certificate-pinning URLSession (Security code stays in the app).
// The tests fake the transport, so nothing here opens a connection.

/// Why a call to a gateway failed, as the app tells the person.
public enum RemoteClientError: Error, Equatable, Sendable, LocalizedError {
  /// Nothing answered on any host: the Mac is asleep, remote access is off,
  /// or this device is on another network. The reason is the last host's.
  case unreachable(String)
  /// A host answered with a certificate other than the pinned one: the Mac
  /// made a new identity (pair again), or something else sits on the address.
  case pinMismatch
  /// The gateway answered and refused.
  case gateway(GatewayError)
  /// The gateway answered something this app cannot read.
  case badResponse(String)
  /// Refused on the device before anything was sent.
  case invalid(String)

  public var errorDescription: String? {
    switch self {
    case .unreachable(let reason): "The Mac did not answer (\(reason))."
    case .pinMismatch: "The Mac presented a different certificate than the one this device paired with."
    case .gateway(let error): error.message
    case .badResponse(let reason): "Hivemind Server sent a reply this app cannot read (\(reason)). Update the app or Hivemind Server."
    case .invalid(let reason): reason
    }
  }

  /// The gateway no longer knows this device: its token was revoked (or the
  /// Mac's identity was reset, which revokes every device).
  /// Only /_hivemind/session says this (device-revoked; a gateway before
  /// that code said unauthorized there). A 401 anywhere else means the
  /// device session is gone, which a new session fixes.
  public var isRevoked: Bool {
    if case .gateway(let error) = self { error.code == .deviceRevoked || error.code == .unauthorized } else { false }
  }

  /// Whether trying the next host of the same Mac could help: only when this
  /// one did not answer as the pinned gateway. A gateway that answered and
  /// refused would refuse again elsewhere, and a second pairing attempt
  /// would only count as another wrong code.
  var triesNextHost: Bool {
    switch self {
    case .unreachable, .pinMismatch: true
    case .gateway, .badResponse, .invalid: false
    }
  }
}

/// One HTTP reply, header names as the server sent them.
public struct RemoteHTTPResponse: Sendable, Equatable {
  public let status: Int
  public let headers: [String: String]
  public let body: Data

  public init(status: Int, headers: [String: String] = [:], body: Data) {
    self.status = status
    self.headers = headers
    self.body = body
  }
}

/// Sends one request to a gateway over TLS pinned to `pin`. Implementations
/// throw RemoteClientError: `.pinMismatch` when the certificate did not
/// hash to the pin, `.unreachable` for every other transport failure. They
/// never store or send cookies of their own and never follow redirects.
public protocol RemoteHTTPTransport: Sendable {
  func send(_ request: URLRequest, pin: CertificateFingerprint) async throws -> RemoteHTTPResponse
}

/// The two requests the app makes to a gateway. Neither carries an Origin
/// (the gateway refuses any that does: only native code calls these) or a
/// cookie.
public enum RemoteClientRequest {
  /// Short: a host that does not answer in this time is not the one to use,
  /// and the next one is tried.
  public static let timeout: TimeInterval = 8

  public static func pair(_ body: PairRequest, endpoint: GatewayEndpoint) -> URLRequest {
    var request = base(endpoint.pairURL)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try? JSONEncoder().encode(body)
    return request
  }

  public static func session(token: DeviceToken, endpoint: GatewayEndpoint) -> URLRequest {
    var request = base(endpoint.sessionURL)
    request.httpMethod = "POST"
    request.setValue(GatewayHeader.bearerPrefix + token.value, forHTTPHeaderField: GatewayHeader.authorization)
    // A body, however small, so URLSession always sends a Content-Length:
    // the gateway answers length-required to a /_hivemind/ POST without one.
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = sessionBody
    return request
  }

  /// What POST /_hivemind/session carries: nothing the gateway reads.
  public static let sessionBody = Data("{}".utf8)

  private static func base(_ url: URL) -> URLRequest {
    var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: timeout)
    request.httpShouldHandleCookies = false
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    return request
  }
}

/// Reading a gateway reply: a 2xx body as `T`, anything else as the
/// gateway's error (or one made from the status when the body is not one).
public enum RemoteClientResponse {
  /// Gateway replies are tiny; a bigger one is not from a gateway.
  static let maxBodyBytes = 64 * 1024

  public static func decode<T: Decodable>(_ type: T.Type, from response: RemoteHTTPResponse) throws(RemoteClientError) -> T {
    guard response.body.count <= maxBodyBytes else { throw .badResponse("the reply is too large") }
    guard (200..<300).contains(response.status) else { throw .gateway(error(from: response)) }
    do {
      return try JSONDecoder().decode(T.self, from: response.body)
    } catch {
      throw .badResponse("an unexpected body")
    }
  }

  /// The gateway's {v, error, message}, or a stand-in from the status (a
  /// proxy or a reset connection in between may send a bare status).
  static func error(from response: RemoteHTTPResponse) -> GatewayError {
    if let error = try? JSONDecoder().decode(GatewayError.self, from: response.body) { return error }
    let code = GatewayErrorCode.allCases.first { $0.httpStatus == response.status } ?? .internal
    return GatewayError(code, "Hivemind Server answered \(response.status).")
  }
}

/// A live device session, as the app keeps it: where it was issued, the
/// cookie value, and when it runs out.
public struct RemoteDeviceSession: Equatable, Sendable {
  /// The host that issued it. The cookie is bound to this exact origin, so
  /// the web view and the broker connection use this endpoint.
  public let endpoint: GatewayEndpoint
  public let token: DeviceSessionToken
  public let expiresAt: Date
  /// The Mac user's home folder, when the gateway sends it: what "~" and a
  /// launch without a folder mean (TerminalSessionLaunch.brokerLaunch(home:)).
  /// Nil with a gateway that does not; those launches are then refused.
  public let home: String?

  public init(endpoint: GatewayEndpoint, token: DeviceSessionToken, expiresAt: Date, home: String? = nil) {
    self.endpoint = endpoint
    self.token = token
    self.expiresAt = expiresAt
    self.home = home
  }

  public func isExpired(at now: Date) -> Bool { now >= expiresAt }

  /// Renewed once less than GatewayLimits.sessionRenewBefore is left.
  public func needsRenewal(at now: Date) -> Bool {
    expiresAt.timeIntervalSince(now) < GatewayLimits.sessionRenewBefore
  }

  /// How long until it needs renewing (zero when it already does).
  public func renewalDelay(at now: Date) -> TimeInterval {
    max(0, expiresAt.timeIntervalSince(now) - GatewayLimits.sessionRenewBefore)
  }

  /// `Cookie` header value for native requests (the broker WebSocket).
  public var cookieHeader: String { "\(DeviceSessionCookie.name)=\(token.value)" }

  /// The cookie for WKHTTPCookieStore. Made by Foundation's own Set-Cookie
  /// parser from exactly what the gateway sends, so the web view stores it
  /// as the gateway meant it: host-only, Secure, HttpOnly, SameSite=Strict.
  /// Nil once expired.
  public func cookie(at now: Date) -> HTTPCookie? {
    let remaining = expiresAt.timeIntervalSince(now).rounded(.down)
    guard remaining >= 1 else { return nil }
    let header = DeviceSessionCookie.setCookie(token, maxAge: remaining)
    return HTTPCookie.cookies(withResponseHeaderFields: ["Set-Cookie": header], for: endpoint.baseURL)
      .first { $0.name == DeviceSessionCookie.name }
  }
}

/// A pairing that went through: what to save, and the token for the Keychain.
public struct RemotePairing: Sendable {
  public let mac: PairedMac
  public let token: DeviceToken
}

/// The gateway calls, trying a Mac's hosts in order.
public struct RemoteGatewayClient: Sendable {
  public let transport: any RemoteHTTPTransport

  public init(transport: any RemoteHTTPTransport) {
    self.transport = transport
  }

  /// Pairs with the Mac in `payload`: tries each host until one answers as
  /// the pinned gateway, then stops there, whatever it says.
  public func pair(_ payload: PairingPayload, deviceName: String, platform: DevicePlatform, now: Date = Date()) async throws(RemoteClientError) -> RemotePairing {
    guard let name = DeviceName.validate(deviceName) else {
      throw .invalid("Give this device a name of 1–\(GatewayLimits.maxDeviceNameCharacters) characters.")
    }
    let body = PairRequest(code: payload.code, deviceName: name, platform: platform)
    let (endpoint, response) = try await firstAnswer(payload.endpoints, pin: payload.fingerprint) { endpoint in
      RemoteClientRequest.pair(body, endpoint: endpoint)
    }
    let reply = try RemoteClientResponse.decode(PairResponse.self, from: response)
    guard reply.v >= 1 else { throw .badResponse("no protocol version") }
    guard let token = DeviceToken(reply.token) else { throw .badResponse("not a device token") }
    guard var mac = PairedMac(payload: payload, response: reply, at: now) else { throw .badResponse("not a device id") }
    mac.remember(endpoint)
    return RemotePairing(mac: mac, token: token)
  }

  /// A new device session with `mac`. `nearby` (hosts Bonjour found for the
  /// Mac's fingerprint) is tried before the saved hosts.
  public func session(_ mac: PairedMac, token: DeviceToken, nearby: [GatewayEndpoint] = [], now: Date = Date()) async throws(RemoteClientError) -> RemoteDeviceSession {
    var endpoints: [GatewayEndpoint] = []
    for endpoint in nearby + mac.endpoints where !endpoints.contains(endpoint) { endpoints.append(endpoint) }
    let (endpoint, response) = try await firstAnswer(endpoints, pin: mac.fingerprint) { endpoint in
      RemoteClientRequest.session(token: token, endpoint: endpoint)
    }
    let reply = try RemoteClientResponse.decode(SessionResponse.self, from: response)
    guard reply.v >= 1, reply.cookieName == DeviceSessionCookie.name else { throw .badResponse("not a device session") }
    guard let session = DeviceSessionToken(reply.cookieValue) else { throw .badResponse("not a session token") }
    let expiry = Self.localExpiry(serverExpiry: reply.expiry, askedAt: now)
    return RemoteDeviceSession(endpoint: endpoint, token: session, expiresAt: expiry, home: reply.home.flatMap(Self.validHome))
  }

  /// When the session runs out by this device's clock. `expiresAt` is by
  /// the Mac's, which may be off by minutes or hours; the session was made
  /// just now with the gateway's fixed lifetime, so it ends at most that
  /// long after the request. An earlier server expiry (a gateway with a
  /// shorter lifetime) is kept; one already past by this clock only means
  /// the Mac's clock is behind.
  static func localExpiry(serverExpiry: Date, askedAt now: Date) -> Date {
    let latest = now.addingTimeInterval(GatewayLimits.sessionLifetime)
    return serverExpiry > now && serverExpiry < latest ? serverExpiry : latest
  }

  /// A home folder as the broker takes a folder: absolute, no NUL, in its limit.
  static func validHome(_ path: String) -> String? {
    guard path.hasPrefix("/"), !path.contains("\0"), path.utf8.count <= BrokerLimits.maxCwdBytes else { return nil }
    return path
  }

  /// The first host that answers as the pinned gateway, and its reply. A
  /// pin mismatch outranks "did not answer" in the error, since it is the
  /// one the person must act on.
  private func firstAnswer(
    _ endpoints: [GatewayEndpoint], pin: CertificateFingerprint, request: (GatewayEndpoint) -> URLRequest
  ) async throws(RemoteClientError) -> (GatewayEndpoint, RemoteHTTPResponse) {
    guard !endpoints.isEmpty else { throw .unreachable("no address to try") }
    var failure = RemoteClientError.unreachable("no address to try")
    for endpoint in endpoints {
      do {
        return (endpoint, try await transport.send(request(endpoint), pin: pin))
      } catch let error as RemoteClientError {
        guard error.triesNextHost else { throw error }
        if failure != .pinMismatch { failure = error }
      } catch {
        if failure != .pinMismatch { failure = .unreachable(error.localizedDescription) }
      }
    }
    throw failure
  }
}
