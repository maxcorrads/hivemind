import Foundation
import Testing
@testable import HivemindKit

struct GatewayPathTests {
  @Test func paths() {
    #expect(GatewayPath.pair == "/_hivemind/pair")
    #expect(GatewayPath.session == "/_hivemind/session")
    #expect(GatewayPath.broker == "/_hivemind/broker")
    for owned in ["/_hivemind", "/_hivemind/", "/_hivemind/pair", "/_hivemind/anything"] { #expect(GatewayPath.isGatewayOwned(owned), "\(owned)") }
    for proxied in ["/", "/ws", "/api/ui/session", "/_hivemindx", "/x/_hivemind/pair"] { #expect(!GatewayPath.isGatewayOwned(proxied), "\(proxied)") }
  }
}

struct GatewayEndpointTests {
  @Test func originsAndURLs() {
    let v4 = GatewayEndpoint(host: "192.168.1.20", port: 7443)!
    #expect(v4.origin == "https://192.168.1.20:7443")
    #expect(v4.baseURL.absoluteString == "https://192.168.1.20:7443/")
    #expect(v4.pairURL.absoluteString == "https://192.168.1.20:7443/_hivemind/pair")
    #expect(v4.sessionURL.absoluteString == "https://192.168.1.20:7443/_hivemind/session")
    #expect(v4.brokerURL.absoluteString == "wss://192.168.1.20:7443/_hivemind/broker")

    let v6 = GatewayEndpoint(host: "FD7A:115C:A1E0:0::1", port: 7443)!
    #expect(v6.host == "fd7a:115c:a1e0::1")
    #expect(v6.origin == "https://[fd7a:115c:a1e0::1]:7443")
    #expect(v6 == GatewayEndpoint(host: "[fd7a:115c:a1e0::1]", port: 7443))

    let named = GatewayEndpoint(host: "Studio.local", port: 7443)!
    #expect(named.origin == "https://studio.local:7443")
  }

  @Test func rejectsBadHostsAndPorts() {
    for host in ["", "a b", "user@host", "host/path", "host.", ".host", "a..b", "host:1"] {
      #expect(GatewayEndpoint(host: host, port: 7443) == nil, "\(host)")
    }
    #expect(GatewayEndpoint(host: "10.0.0.1", port: 0) == nil)
    #expect(GatewayEndpoint(host: "10.0.0.1", port: 65536) == nil)
  }

  @Test func sameOriginIsExact() {
    let endpoint = GatewayEndpoint(host: "192.168.1.20", port: 7443)!
    #expect(endpoint.isSameOrigin(URL(string: "https://192.168.1.20:7443/#/c/general")!))
    #expect(endpoint.isSameOrigin(URL(string: "wss://192.168.1.20:7443/ws")!))
    #expect(!endpoint.isSameOrigin(URL(string: "http://192.168.1.20:7443/")!))
    #expect(!endpoint.isSameOrigin(URL(string: "https://192.168.1.21:7443/")!))
    #expect(!endpoint.isSameOrigin(URL(string: "https://192.168.1.20:7444/")!))
    #expect(!endpoint.isSameOrigin(URL(string: "https://192.168.1.20/")!))
    #expect(!endpoint.isSameOrigin(URL(string: "https://u@192.168.1.20:7443/")!))
    #expect(!endpoint.isSameOrigin(URL(string: "https://192.168.1.20.evil.test:7443/")!))
    let v6 = GatewayEndpoint(host: "fd00::1", port: 7443)!
    #expect(v6.isSameOrigin(URL(string: "https://[fd00::1]:7443/")!))
    #expect(v6.isSameOrigin(URL(string: "https://[fd00:0::1]:7443/")!))
  }
}

struct GatewayHeaderAndCookieTests {
  @Test func bearer() {
    let token = DeviceToken.generate()
    #expect(GatewayHeader.deviceToken(fromAuthorization: "Bearer \(token.value)") == token)
    #expect(GatewayHeader.deviceToken(fromAuthorization: "bearer \(token.value)") == nil)
    #expect(GatewayHeader.deviceToken(fromAuthorization: "Bearer  \(token.value)") == nil)
    #expect(GatewayHeader.deviceToken(fromAuthorization: "Basic \(token.value)") == nil)
    #expect(GatewayHeader.deviceToken(fromAuthorization: "Bearer ") == nil)
  }

  @Test func setCookieIsHostOnlySecureHttpOnlyStrict() {
    let token = DeviceSessionToken.generate()
    #expect(DeviceSessionCookie.setCookie(token) == "__Host-hivemind-device=\(token.value); Path=/; Max-Age=3600; Secure; HttpOnly; SameSite=Strict")
    #expect(!DeviceSessionCookie.setCookie(token).contains("Domain"))
  }

  @Test func readsTheCookieAndFailsClosed() {
    let token = DeviceSessionToken.generate()
    let other = DeviceSessionToken.generate()
    let name = DeviceSessionCookie.name
    #expect(DeviceSessionCookie.token(fromCookieHeader: "\(name)=\(token.value)") == token)
    #expect(DeviceSessionCookie.token(fromCookieHeader: "a=b; \(name)=\(token.value); hivemind_human_7420=x") == token)
    #expect(DeviceSessionCookie.token(fromCookieHeader: "\(name)=\(token.value); \(name)=\(other.value)") == nil)
    #expect(DeviceSessionCookie.token(fromCookieHeader: "\(name)=nope") == nil)
    #expect(DeviceSessionCookie.token(fromCookieHeader: "x\(name)=\(token.value)") == nil)
    #expect(DeviceSessionCookie.token(fromCookieHeader: "") == nil)
  }
}

struct GatewayMessageTests {
  @Test func pairRequestRoundTripAndValidation() throws {
    let code = PairingCode.generate()
    let request = PairRequest(code: code, deviceName: "  Anna's iPhone ", platform: .ios)
    let data = try JSONEncoder().encode(request)
    let decoded = try JSONDecoder().decode(PairRequest.self, from: data)
    let valid = try decoded.validated()
    #expect(valid.code == code)
    #expect(valid.deviceName == "Anna's iPhone")

    #expect(throws: GatewayError.self) { try PairRequest(code: code, deviceName: " ", platform: .ios).validated() }
    #expect(throws: GatewayError.self) { try PairRequest(code: code, deviceName: String(repeating: "x", count: 65), platform: .ios).validated() }
    #expect(throws: GatewayError.self) { try PairRequest(code: code, deviceName: "a\u{202E}b", platform: .ios).validated() }
    let badCode = try JSONDecoder().decode(PairRequest.self, from: Data(#"{"code":"x","deviceName":"a","platform":"ipados"}"#.utf8))
    #expect(throws: GatewayError(.badRequest, "code: not a pairing code")) { try badCode.validated() }
    // An unknown platform fails decoding outright.
    #expect(throws: DecodingError.self) {
      try JSONDecoder().decode(PairRequest.self, from: Data(#"{"code":"x","deviceName":"a","platform":"android"}"#.utf8))
    }
  }

  @Test func deviceNamesKeepEmojiButNotBidiTricks() {
    #expect(DeviceName.validate("👩‍💻 iPad") == "👩‍💻 iPad")
    #expect(DeviceName.validate("a\nb") == nil)
    #expect(DeviceName.validate("a\u{200B}b") == nil)
    #expect(DeviceName.validate(String(repeating: "é", count: 64)) != nil)
  }

  @Test func pairAndSessionResponses() throws {
    let id = UUID()
    let token = DeviceToken.generate()
    let pair = PairResponse(deviceId: id, token: token, name: "Studio")
    #expect(pair.v == 1)
    #expect(pair.deviceId == id.uuidString.lowercased())
    #expect(try JSONDecoder().decode(PairResponse.self, from: JSONEncoder().encode(pair)) == pair)

    let session = SessionResponse(token: DeviceSessionToken.generate(), expiresAt: Date(timeIntervalSince1970: 1_800_000_000.5))
    #expect(session.cookieName == "__Host-hivemind-device")
    #expect(session.expiresAt == 1_800_000_000_500)
    #expect(session.expiry == Date(timeIntervalSince1970: 1_800_000_000.5))
  }

  @Test func errorsDecodeUnknownCodesAsInternal() throws {
    let error = try JSONDecoder().decode(GatewayError.self, from: Data(#"{"v":1,"error":"from-the-future","message":"x"}"#.utf8))
    #expect(error.code == .internal)
    let known = GatewayError(.rateLimited, "slow down")
    #expect(try JSONDecoder().decode(GatewayError.self, from: JSONEncoder().encode(known)) == known)
    #expect(GatewayErrorCode.rateLimited.httpStatus == 429)
    #expect(GatewayErrorCode.unauthorized.httpStatus == 401)
    #expect(Set(GatewayErrorCode.allCases.map(\.httpStatus)).isSubset(of: [400, 401, 403, 404, 409, 413, 423, 429, 500, 502]))
  }
}

struct GatewayAdvertisementTests {
  @Test func txtRoundTrip() {
    let fingerprint = CertificateFingerprint(certificateDER: Data("cert".utf8))
    let ad = GatewayAdvertisement(fingerprint: fingerprint, name: "Studio")
    #expect(ad.txtRecord == ["v": "1", "fp": fingerprint.hex, "name": "Studio"])
    #expect(GatewayAdvertisement(txtRecord: ad.txtRecord) == ad)
    #expect(ad.txtRecord.allSatisfy { $0.key.utf8.count + 1 + $0.value.utf8.count <= 255 })
  }

  @Test func rejectsBadTXT() {
    let fp = CertificateFingerprint(certificateDER: Data("cert".utf8)).hex
    #expect(GatewayAdvertisement(txtRecord: ["fp": fp, "name": "x"]) == nil)
    #expect(GatewayAdvertisement(txtRecord: ["v": "0", "fp": fp, "name": "x"]) == nil)
    #expect(GatewayAdvertisement(txtRecord: ["v": "1", "fp": "abc", "name": "x"]) == nil)
    #expect(GatewayAdvertisement(txtRecord: ["v": "1", "fp": fp, "name": ""]) == nil)
  }
}
