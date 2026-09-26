import Foundation
import Testing
@testable import HivemindKit

// The iOS app's gateway calls over a fake transport: nothing here connects.

/// Answers by host, in the order scripted; records every request.
final class RCFakeTransport: RemoteHTTPTransport, @unchecked Sendable {
  enum Answer {
    case reply(RemoteHTTPResponse)
    case fail(RemoteClientError)
  }

  private let lock = NSLock()
  private var answers: [String: Answer]
  private var fallback: Answer
  private(set) var requests: [URLRequest] = []
  private(set) var pins: [CertificateFingerprint] = []

  init(_ answers: [String: Answer] = [:], otherwise fallback: Answer = .fail(.unreachable("timed out"))) {
    self.answers = answers
    self.fallback = fallback
  }

  var hosts: [String] { lock.withLock { requests.compactMap { $0.url?.host(percentEncoded: false) } } }

  func send(_ request: URLRequest, pin: CertificateFingerprint) async throws -> RemoteHTTPResponse {
    let answer: Answer = lock.withLock {
      requests.append(request)
      pins.append(pin)
      let host = request.url?.host(percentEncoded: false) ?? ""
      return answers[host] ?? fallback
    }
    switch answer {
    case .reply(let response): return response
    case .fail(let error): throw error
    }
  }
}

func rcJSON(_ object: [String: Any], status: Int = 200) -> RCFakeTransport.Answer {
  .reply(RemoteHTTPResponse(status: status, body: try! JSONSerialization.data(withJSONObject: object)))
}

enum RCFixture {
  static let fingerprint = CertificateFingerprint(certificateDER: Data("gateway certificate".utf8))
  static let code = PairingCode("AAECAwQFBgcICQoLDA0ODw")!
  static let token = DeviceToken.generate()
  static let deviceID = UUID(uuidString: "6F9619FF-8B86-D011-B42D-00C04FC964FF")!
  static let now = Date(timeIntervalSince1970: 1_800_000_000)

  static func payload(hosts: [String] = ["192.168.1.20", "100.101.102.103", "fd7a:115c:a1e0::5"], fingerprint: CertificateFingerprint = fingerprint) -> PairingPayload {
    try! PairingPayload(name: "Studio Mac", hosts: hosts.map { IPAddress($0)! }, port: 7443, fingerprint: fingerprint, code: code)
  }

  static func pairReply(token: String = token.value, deviceId: String = deviceID.uuidString.lowercased(), name: String = "Studio") -> RCFakeTransport.Answer {
    rcJSON(["v": 1, "deviceId": deviceId, "token": token, "name": name])
  }

  static func mac(id: UUID = deviceID, hosts: [String] = ["192.168.1.20", "100.101.102.103"], fingerprint: CertificateFingerprint = fingerprint) -> PairedMac {
    PairedMac(payload: payload(hosts: hosts, fingerprint: fingerprint), response: PairResponse(deviceId: id, token: token, name: "Studio Mac"), at: now)!
  }

  static func sessionReply(_ session: DeviceSessionToken = DeviceSessionToken.generate(), expiresIn: TimeInterval = 3600, extra: [String: Any] = [:]) -> RCFakeTransport.Answer {
    var body: [String: Any] = ["v": 1, "cookieName": DeviceSessionCookie.name, "cookieValue": session.value,
                               "expiresAt": Int64((now.timeIntervalSince1970 + expiresIn) * 1000)]
    body.merge(extra) { $1 }
    return rcJSON(body)
  }
}

struct RemoteClientRequestTests {
  let endpoint = GatewayEndpoint(host: "192.168.1.20", port: 7443)!

  @Test func pairIsAPlainJSONPostWithoutOriginOrCookies() throws {
    let request = RemoteClientRequest.pair(PairRequest(code: RCFixture.code, deviceName: "Anna's iPhone", platform: .ios), endpoint: endpoint)
    #expect(request.url?.absoluteString == "https://192.168.1.20:7443/_hivemind/pair")
    #expect(request.httpMethod == "POST")
    #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
    #expect(request.value(forHTTPHeaderField: "Origin") == nil)
    #expect(request.value(forHTTPHeaderField: "Cookie") == nil)
    #expect(request.value(forHTTPHeaderField: "Authorization") == nil)
    #expect(!request.httpShouldHandleCookies)
    let body = try JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: String]
    #expect(body == ["code": RCFixture.code.value, "deviceName": "Anna's iPhone", "platform": "ios"])
  }

  @Test func sessionCarriesOnlyTheBearerToken() {
    let request = RemoteClientRequest.session(token: RCFixture.token, endpoint: endpoint)
    #expect(request.url?.absoluteString == "https://192.168.1.20:7443/_hivemind/session")
    #expect(request.httpMethod == "POST")
    #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer \(RCFixture.token.value)")
    #expect(GatewayHeader.deviceToken(fromAuthorization: request.value(forHTTPHeaderField: "Authorization")!) == RCFixture.token)
    #expect(request.httpBody == nil)
    #expect(request.value(forHTTPHeaderField: "Origin") == nil)
    #expect(!request.httpShouldHandleCookies)
  }

  @Test func errorsAreTheGatewaysOrMadeFromTheStatus() {
    let body = try! JSONEncoder().encode(GatewayError(.pairingLocked, "Locked."))
    #expect(throws: RemoteClientError.gateway(GatewayError(.pairingLocked, "Locked."))) {
      try RemoteClientResponse.decode(PairResponse.self, from: RemoteHTTPResponse(status: 423, body: body))
    }
    // A code this app does not know reads as internal, with its message.
    let unknown = Data(#"{"v":1,"error":"brand-new","message":"New."}"#.utf8)
    #expect(throws: RemoteClientError.gateway(GatewayError(.internal, "New."))) {
      try RemoteClientResponse.decode(PairResponse.self, from: RemoteHTTPResponse(status: 418, body: unknown))
    }
    #expect(RemoteClientResponse.error(from: RemoteHTTPResponse(status: 502, body: Data("Bad Gateway".utf8))).code == .serverUnavailable)
    #expect(RemoteClientResponse.error(from: RemoteHTTPResponse(status: 599, body: Data())).code == .internal)
    #expect(throws: RemoteClientError.badResponse("an unexpected body")) {
      try RemoteClientResponse.decode(PairResponse.self, from: RemoteHTTPResponse(status: 200, body: Data("<html>".utf8)))
    }
    #expect(throws: RemoteClientError.badResponse("the reply is too large")) {
      try RemoteClientResponse.decode(PairResponse.self, from: RemoteHTTPResponse(status: 200, body: Data(count: 65 * 1024)))
    }
  }
}

struct RemoteGatewayClientPairTests {
  @Test func pairsWithTheFirstHostThatAnswers() async throws {
    let transport = RCFakeTransport(["100.101.102.103": RCFixture.pairReply()])
    let pairing = try await RemoteGatewayClient(transport: transport).pair(RCFixture.payload(), deviceName: "  Anna's iPad ", platform: .ipados, now: RCFixture.now)
    #expect(transport.hosts == ["192.168.1.20", "100.101.102.103"])
    #expect(transport.pins == [RCFixture.fingerprint, RCFixture.fingerprint])
    #expect(pairing.token == RCFixture.token)
    #expect(pairing.mac.id == RCFixture.deviceID)
    #expect(pairing.mac.name == "Studio")
    #expect(pairing.mac.fingerprint == RCFixture.fingerprint)
    #expect(pairing.mac.pairedAt == RCFixture.now)
    // The host that worked is tried first next time.
    #expect(pairing.mac.hosts == ["100.101.102.103", "192.168.1.20", "fd7a:115c:a1e0::5"])
    let body = try JSONSerialization.jsonObject(with: transport.requests[1].httpBody!) as? [String: String]
    #expect(body?["deviceName"] == "Anna's iPad")
    #expect(body?["platform"] == "ipados")
  }

  @Test func aGatewayThatRefusesEndsTheAttempt() async {
    // A second host would only count as a second wrong code.
    let transport = RCFakeTransport(["192.168.1.20": rcJSON(["v": 1, "error": "invalid-code", "message": "Wrong code."], status: 403)])
    await #expect(throws: RemoteClientError.gateway(GatewayError(.invalidCode, "Wrong code."))) {
      try await RemoteGatewayClient(transport: transport).pair(RCFixture.payload(), deviceName: "iPhone", platform: .ios)
    }
    #expect(transport.hosts == ["192.168.1.20"])
  }

  @Test func aPinMismatchOutranksSilence() async {
    let transport = RCFakeTransport(["100.101.102.103": .fail(.pinMismatch)])
    await #expect(throws: RemoteClientError.pinMismatch) {
      try await RemoteGatewayClient(transport: transport).pair(RCFixture.payload(), deviceName: "iPhone", platform: .ios)
    }
    #expect(transport.hosts.count == 3)
    let silent = RCFakeTransport()
    await #expect(throws: RemoteClientError.unreachable("timed out")) {
      try await RemoteGatewayClient(transport: silent).pair(RCFixture.payload(), deviceName: "iPhone", platform: .ios)
    }
  }

  @Test func refusesABadNameBeforeSendingAnything() async {
    let transport = RCFakeTransport()
    for name in ["", "   ", String(repeating: "x", count: 65), "evil\u{202E}name"] {
      await #expect(throws: RemoteClientError.self) {
        try await RemoteGatewayClient(transport: transport).pair(RCFixture.payload(), deviceName: name, platform: .ios)
      }
    }
    #expect(transport.requests.isEmpty)
  }

  @Test func refusesAReplyItCannotUse() async {
    for reply in [RCFixture.pairReply(token: "short"), RCFixture.pairReply(deviceId: "not-a-uuid"), rcJSON(["v": 1])] {
      let transport = RCFakeTransport(otherwise: reply)
      await #expect(throws: RemoteClientError.self) {
        try await RemoteGatewayClient(transport: transport).pair(RCFixture.payload(), deviceName: "iPhone", platform: .ios)
      }
    }
  }
}

struct RemoteGatewayClientSessionTests {
  @Test func opensASessionOnTheFirstHostThatAnswers() async throws {
    let token = DeviceSessionToken.generate()
    let transport = RCFakeTransport(["100.101.102.103": RCFixture.sessionReply(token, extra: ["home": "/Users/anna"])])
    let session = try await RemoteGatewayClient(transport: transport).session(RCFixture.mac(), token: RCFixture.token, now: RCFixture.now)
    #expect(transport.hosts == ["192.168.1.20", "100.101.102.103"])
    #expect(session.endpoint == GatewayEndpoint(host: "100.101.102.103", port: 7443))
    #expect(session.token == token)
    #expect(session.expiresAt == RCFixture.now.addingTimeInterval(3600))
    #expect(session.home == "/Users/anna")
    #expect(transport.requests.allSatisfy { $0.value(forHTTPHeaderField: "Authorization") == "Bearer \(RCFixture.token.value)" })
  }

  @Test func triesNearbyHostsFirstWithoutRepeats() async throws {
    let transport = RCFakeTransport()
    let nearby = [GatewayEndpoint(host: "192.168.7.7", port: 7443)!, GatewayEndpoint(host: "192.168.1.20", port: 7443)!]
    _ = try? await RemoteGatewayClient(transport: transport).session(RCFixture.mac(), token: RCFixture.token, nearby: nearby)
    #expect(transport.hosts == ["192.168.7.7", "192.168.1.20", "100.101.102.103"])
  }

  @Test func aGatewayWithoutHomeStillWorks() async throws {
    let transport = RCFakeTransport(otherwise: RCFixture.sessionReply())
    let session = try await RemoteGatewayClient(transport: transport).session(RCFixture.mac(), token: RCFixture.token, now: RCFixture.now)
    #expect(session.home == nil)
    for home in ["relative", "/nul\0l", "/" + String(repeating: "a", count: 1024)] {
      let odd = RCFakeTransport(otherwise: RCFixture.sessionReply(extra: ["home": home]))
      #expect(try await RemoteGatewayClient(transport: odd).session(RCFixture.mac(), token: RCFixture.token, now: RCFixture.now).home == nil)
    }
  }

  @Test func expiryFollowsThisDevicesClock() {
    let now = RCFixture.now
    // The Mac's clock two hours ahead or behind: an hour from now either way.
    #expect(RemoteGatewayClient.localExpiry(serverExpiry: now.addingTimeInterval(3 * 3600), askedAt: now) == now.addingTimeInterval(3600))
    #expect(RemoteGatewayClient.localExpiry(serverExpiry: now.addingTimeInterval(-3600), askedAt: now) == now.addingTimeInterval(3600))
    // A shorter session than the usual lifetime is kept short.
    #expect(RemoteGatewayClient.localExpiry(serverExpiry: now.addingTimeInterval(600), askedAt: now) == now.addingTimeInterval(600))
  }

  @Test func revokedIsUnauthorized() async {
    let transport = RCFakeTransport(otherwise: rcJSON(["v": 1, "error": "unauthorized", "message": "Unknown device."], status: 401))
    do {
      _ = try await RemoteGatewayClient(transport: transport).session(RCFixture.mac(), token: RCFixture.token)
      Issue.record("expected an error")
    } catch {
      #expect(error.isRevoked)
      #expect(transport.hosts.count == 1)
    }
  }

  @Test func refusesASessionItCannotUse() async {
    let replies = [
      RCFixture.sessionReply(extra: ["cookieName": "other"]),
      RCFixture.sessionReply(extra: ["cookieValue": "short"]),
      rcJSON(["v": 1, "cookieName": DeviceSessionCookie.name]),
    ]
    for reply in replies {
      let transport = RCFakeTransport(otherwise: reply)
      await #expect(throws: RemoteClientError.self) {
        try await RemoteGatewayClient(transport: transport).session(RCFixture.mac(), token: RCFixture.token, now: RCFixture.now)
      }
    }
  }
}

struct RemoteDeviceSessionTests {
  let now = RCFixture.now

  func session(host: String = "192.168.1.20", expiresIn: TimeInterval = 3600) -> RemoteDeviceSession {
    RemoteDeviceSession(endpoint: GatewayEndpoint(host: host, port: 7443)!, token: DeviceSessionToken.generate(), expiresAt: now.addingTimeInterval(expiresIn))
  }

  @Test func renewsWithHalfAnHourLeft() {
    let fresh = session()
    #expect(!fresh.needsRenewal(at: now))
    #expect(fresh.renewalDelay(at: now) == 1800)
    #expect(!fresh.needsRenewal(at: now.addingTimeInterval(1799)))
    #expect(fresh.needsRenewal(at: now.addingTimeInterval(1801)))
    #expect(fresh.renewalDelay(at: now.addingTimeInterval(2000)) == 0)
    #expect(!fresh.isExpired(at: now.addingTimeInterval(3599)))
    #expect(fresh.isExpired(at: now.addingTimeInterval(3600)))
  }

  @Test func theCookieIsWhatTheGatewaySets() throws {
    // Max-Age counts from the real clock, as it does in the app.
    let now = Date()
    let session = RemoteDeviceSession(endpoint: GatewayEndpoint(host: "192.168.1.20", port: 7443)!, token: DeviceSessionToken.generate(), expiresAt: now.addingTimeInterval(3600))
    let cookie = try #require(session.cookie(at: now))
    #expect(cookie.name == "__Host-hivemind-device")
    #expect(cookie.value == session.token.value)
    #expect(cookie.isSecure)
    #expect(cookie.isHTTPOnly)
    #expect(cookie.sameSitePolicy == .sameSiteStrict)
    #expect(cookie.path == "/")
    // Host-only: no leading dot, so it goes to this exact host.
    #expect(cookie.domain == "192.168.1.20")
    let expiry = try #require(cookie.expiresDate)
    #expect(abs(expiry.timeIntervalSince(session.expiresAt)) < 2)
    #expect(session.cookieHeader == "__Host-hivemind-device=\(session.token.value)")
  }

  @Test func anIPv6CookieIsForThatHost() throws {
    let session = session(host: "fd7a:115c:a1e0::5")
    let cookie = try #require(session.cookie(at: now))
    #expect(cookie.value == session.token.value)
    #expect(!cookie.domain.hasPrefix("."))
    #expect(cookie.domain.contains("fd7a:115c:a1e0::5"))
  }

  @Test func noCookieOnceExpired() {
    #expect(session(expiresIn: 0.5).cookie(at: now) == nil)
    #expect(session().cookie(at: now.addingTimeInterval(3600)) == nil)
  }
}
