import Foundation
import Testing
@testable import HivemindKit

struct PairingPayloadTests {
  let fingerprint = CertificateFingerprint(certificateDER: Data("gateway certificate".utf8))
  let code = PairingCode("AAECAwQFBgcICQoLDA0ODw")!

  func payload(name: String = "Studio Mac", hosts: [String] = ["192.168.1.20", "100.101.102.103", "fd7a:115c:a1e0::5"]) throws -> PairingPayload {
    try PairingPayload(name: name, hosts: hosts.map { IPAddress($0)! }, port: 7443, fingerprint: fingerprint, code: code)
  }

  @Test func encodesAQueryLink() throws {
    let url = try payload().url.absoluteString
    #expect(url == "hivemind-pair://pair?v=1&name=Studio%20Mac&host=192.168.1.20&host=100.101.102.103&host=fd7a:115c:a1e0::5&port=7443&fp=\(fingerprint.hex)&code=AAECAwQFBgcICQoLDA0ODw")
    #expect(url.utf8.count <= GatewayLimits.maxPairingLinkBytes)
  }

  @Test func roundTrips() throws {
    for name in ["Studio Mac", "Anna's MacBook Pro", "Mac+Mini & Co = 1?", "Café #2", "👩‍💻"] {
      let original = try payload(name: name)
      #expect(try PairingPayload(link: original.url.absoluteString) == original, "\(name)")
    }
    let original = try payload()
    #expect(try PairingPayload(link: "  \(original.url.absoluteString)\n") == original)
    #expect(original.endpoints.map(\.origin) == ["https://192.168.1.20:7443", "https://100.101.102.103:7443", "https://[fd7a:115c:a1e0::5]:7443"])
  }

  @Test func refusesWhatItCannotUse() {
    #expect(throws: PairingPayloadError.self) { try payload(hosts: []) }
    #expect(throws: PairingPayloadError.self) { try payload(hosts: ["8.8.8.8"]) }
    #expect(throws: PairingPayloadError.self) { try payload(hosts: ["127.0.0.1"]) }
    #expect(throws: PairingPayloadError.self) { try payload(hosts: ["fe80::1%en0"]) }
    #expect(throws: PairingPayloadError.self) { try payload(hosts: ["10.0.0.1", "10.0.0.1"]) }
    #expect(throws: PairingPayloadError.self) { try payload(hosts: (1...9).map { "10.0.0.\($0)" }) }
    #expect(throws: PairingPayloadError.self) { try payload(name: "") }
    #expect(throws: PairingPayloadError.self) { try payload(name: String(repeating: "m", count: 65)) }
  }

  func link(_ query: String) -> String { "hivemind-pair://pair?\(query)" }
  var good: String { "v=1&name=Mac&host=10.0.0.1&port=7443&fp=\(fingerprint.hex)&code=\(code.value)" }

  @Test func decodesStrictly() throws {
    #expect(try PairingPayload(link: link(good)).hosts == [IPAddress("10.0.0.1")!])
    // Unknown keys are ignored; the scheme and host are case-insensitive.
    #expect(try PairingPayload(link: link(good + "&later=1")).port == 7443)
    #expect(try PairingPayload(link: "HIVEMIND-PAIR://PAIR?" + good).name == "Mac")

    let cases: [(String, PairingPayloadError)] = [
      ("https://pair?" + good, .notAPairingLink),
      ("hivemind-pair://other?" + good, .notAPairingLink),
      ("hivemind-pair://pair/extra?" + good, .notAPairingLink),
      ("hivemind-pair://u@pair?" + good, .notAPairingLink),
      ("hivemind-pair://pair:1?" + good, .notAPairingLink),
      ("hivemind-pair://pair?" + good + "#frag", .notAPairingLink),
      ("not a url at all", .notAPairingLink),
      (link(good.replacingOccurrences(of: "v=1", with: "v=2")), .unsupportedVersion(2)),
      (link(good.replacingOccurrences(of: "v=1", with: "v=0")), .invalid("v", "must be a positive integer")),
      (link(good.replacingOccurrences(of: "v=1", with: "v=01")), .invalid("v", "must be a positive integer")),
      (link(good.replacingOccurrences(of: "&port=7443", with: "")), .invalid("port", "is missing")),
      (link(good.replacingOccurrences(of: "port=7443", with: "port=70000")), .invalid("port", "must be 1–65535")),
      (link(good.replacingOccurrences(of: "port=7443", with: "port=+7443")), .invalid("port", "must be 1–65535")),
      (link(good + "&port=7444"), .invalid("port", "appears twice")),
      (link(good + "&name"), .invalid("name", "has no value")),
      (link(good.replacingOccurrences(of: fingerprint.hex, with: fingerprint.hex.uppercased())), .invalid("fp", "must be 64 lowercase hex characters")),
      (link(good.replacingOccurrences(of: code.value, with: "short")), .invalid("code", "is not a pairing code")),
      (link(good.replacingOccurrences(of: "host=10.0.0.1", with: "host=mac.local")), .invalid("host", "mac.local is not an IP address")),
      (link(good.replacingOccurrences(of: "host=10.0.0.1", with: "host=1.1.1.1")), .invalid("host", "1.1.1.1 is not a private address")),
      (link(good.replacingOccurrences(of: "host=10.0.0.1&", with: "")), .invalid("host", "1–8 addresses")),
      (link(good + "&x=" + String(repeating: "a", count: 1024)), .invalid("link", "is too long")),
    ]
    for (text, expected) in cases {
      #expect(throws: expected, "\(text.prefix(80))") { try PairingPayload(link: text) }
    }
  }

  @Test func errorsReadWell() {
    #expect(PairingPayloadError.notAPairingLink.errorDescription == "This is not a Hivemind pairing code.")
    #expect(PairingPayloadError.unsupportedVersion(2).errorDescription?.contains("newer") == true)
  }
}

struct PairedMacTests {
  let fingerprint = CertificateFingerprint(certificateDER: Data("gateway certificate".utf8))

  func paired() throws -> PairedMac {
    let payload = try PairingPayload(name: "Studio", hosts: [IPAddress("192.168.1.20")!, IPAddress("100.101.102.103")!],
                                     port: 7443, fingerprint: fingerprint, code: .generate())
    let response = PairResponse(deviceId: UUID(), token: .generate(), name: "Studio Mac")
    return try #require(PairedMac(payload: payload, response: response, at: Date(timeIntervalSince1970: 1_800_000_000)))
  }

  @Test func fromAPairing() throws {
    let mac = try paired()
    #expect(mac.name == "Studio Mac")
    #expect(mac.hosts == ["192.168.1.20", "100.101.102.103"])
    #expect(mac.endpoints.map(\.origin) == ["https://192.168.1.20:7443", "https://100.101.102.103:7443"])
    let data = try JSONEncoder().encode(mac)
    #expect(try JSONDecoder().decode(PairedMac.self, from: data) == mac)
  }

  @Test func remembersTheHostThatWorked() throws {
    var mac = try paired()
    mac.remember(GatewayEndpoint(host: "100.101.102.103", port: 7443)!)
    #expect(mac.hosts == ["100.101.102.103", "192.168.1.20"])
    mac.remember(GatewayEndpoint(host: "studio.local", port: 7443)!)
    #expect(mac.hosts.first == "studio.local")
    mac.remember(GatewayEndpoint(host: "10.0.0.9", port: 9999)!)
    #expect(!mac.hosts.contains("10.0.0.9"))
  }

  @Test func bonjourMatchesByFingerprintOnly() throws {
    let mac = try paired()
    #expect(mac.isAdvertised(by: GatewayAdvertisement(fingerprint: fingerprint, name: "Someone else")))
    #expect(!mac.isAdvertised(by: GatewayAdvertisement(fingerprint: CertificateFingerprint(certificateDER: Data("other".utf8)), name: "Studio Mac")))
  }
}
