import Foundation
import Testing
@testable import HivemindKit

// Which requests the gateway serves, from the head alone.

struct GatewayPolicyTests {
  let allowed = GatewayPolicy.allowedEndpoints(local: IPAddress("192.168.1.20")!, port: 7443, names: ["Studio.local"])

  func head(_ target: String, method: String = "GET", _ fields: HTTPHeaders) -> HTTPRequestHead {
    HTTPRequestHead(method: method, target: target, headers: fields)
  }

  static let upgrade: HTTPHeaders = [
    "Connection": "Upgrade", "Upgrade": "websocket",
    "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
  ]

  func with(_ base: HTTPHeaders, _ extra: HTTPHeaders) -> HTTPHeaders {
    var out = base
    for field in extra.fields { out.add(field.name, field.value) }
    return out
  }

  @Test func authorities() {
    #expect(GatewayPolicy.authority("192.168.1.20:7443") == GatewayEndpoint(host: "192.168.1.20", port: 7443))
    #expect(GatewayPolicy.authority("[fd7a::1]:7443") == GatewayEndpoint(host: "fd7a::1", port: 7443))
    #expect(GatewayPolicy.authority("Studio.local:7443") == GatewayEndpoint(host: "studio.local", port: 7443))
    for bad in ["192.168.1.20", "192.168.1.20:", "192.168.1.20:07443", "192.168.1.20:99999", "[fd7a::1]", "fd7a::1:7443",
                "[fe80::1%en0]:7443", "user@192.168.1.20:7443", "a/b:7443", "[192.168.1.20]:7443", "x.local.:7443"] {
      #expect(GatewayPolicy.authority(bad) == nil, "\(bad)")
    }
  }

  @Test func allowedEndpointsDropTheZone() {
    let linkLocal = GatewayPolicy.allowedEndpoints(local: IPAddress("fe80::1%en0")!, port: 7443, names: [])
    #expect(linkLocal == [GatewayEndpoint(host: "fe80::1", port: 7443)!])
    let mapped = GatewayPolicy.allowedEndpoints(local: IPAddress("::ffff:10.0.0.2")!, port: 7443, names: [])
    #expect(mapped == [GatewayEndpoint(host: "10.0.0.2", port: 7443)!])
  }

  @Test func routes() throws {
    let host: HTTPHeaders = ["Host": "192.168.1.20:7443"]
    #expect(try GatewayPolicy.route(head("/_hivemind/pair", method: "POST", host), allowed: allowed).0 == .pair)
    #expect(try GatewayPolicy.route(head("/_hivemind/session", method: "POST", host), allowed: allowed).0 == .session)
    #expect(try GatewayPolicy.route(head("/_hivemind/broker", with(host, Self.upgrade)), allowed: allowed).0
      == .broker(webSocketKey: "dGhlIHNhbXBsZSBub25jZQ=="))
    #expect(try GatewayPolicy.route(head("/", host), allowed: allowed).0 == .proxy)
    #expect(try GatewayPolicy.route(head("/api/ui/files", method: "POST", ["Host": "studio.local:7443"]), allowed: allowed).0 == .proxy)
    let ws = with(with(host, Self.upgrade), ["Origin": "https://192.168.1.20:7443"])
    let (route, endpoint) = try GatewayPolicy.route(head("/ws", ws), allowed: allowed)
    #expect(route == .proxyWebSocket)
    #expect(endpoint.origin == "https://192.168.1.20:7443")
  }

  func refusal(_ head: HTTPRequestHead) -> GatewayErrorCode? {
    do {
      _ = try GatewayPolicy.route(head, allowed: allowed)
      return nil
    } catch {
      return error.code
    }
  }

  @Test func refusals() {
    let host: HTTPHeaders = ["Host": "192.168.1.20:7443"]
    // Host: missing, twice, another name (DNS rebinding), another port.
    #expect(refusal(head("/", [:])) == .forbiddenOrigin)
    #expect(refusal(head("/", with(host, host))) == .forbiddenOrigin)
    #expect(refusal(head("/", ["Host": "evil.example:7443"])) == .forbiddenOrigin)
    #expect(refusal(head("/", ["Host": "192.168.1.20:7420"])) == .forbiddenOrigin)
    #expect(refusal(head("/", ["Host": "192.168.1.21:7443"])) == .forbiddenOrigin)
    // Origin: only the gateway's own, exactly.
    #expect(refusal(head("/api/ui/x", method: "POST", with(host, ["Origin": "https://evil.example"]))) == .forbiddenOrigin)
    #expect(refusal(head("/api/ui/x", method: "POST", with(host, ["Origin": "http://192.168.1.20:7443"]))) == .forbiddenOrigin)
    #expect(refusal(head("/api/ui/x", method: "POST", with(host, ["Origin": "null"]))) == .forbiddenOrigin)
    #expect(refusal(head("/", with(host, ["Origin": "https://192.168.1.20:7443", "origin": "https://192.168.1.20:7443"]))) == .forbiddenOrigin)
    #expect(refusal(head("/", with(host, ["Origin": "https://192.168.1.20:7443"]))) == nil)
    // The gateway's endpoints take no Origin at all, even their own.
    #expect(refusal(head("/_hivemind/pair", method: "POST", with(host, ["Origin": "https://192.168.1.20:7443"]))) == .forbiddenOrigin)
    #expect(refusal(head("/_hivemind/broker", with(with(host, Self.upgrade), ["Origin": "https://192.168.1.20:7443"]))) == .forbiddenOrigin)
    // Methods, targets and paths.
    #expect(refusal(head("/_hivemind/pair", host)) == .badRequest)
    #expect(refusal(head("/_hivemind/nope", method: "POST", host)) == .notFound)
    #expect(refusal(head("/_hivemind", host)) == .notFound)
    #expect(refusal(head("http://127.0.0.1:7420/", host)) == .badRequest)
    #expect(refusal(head("*", method: "OPTIONS", host)) == .badRequest)
    #expect(refusal(head("/", method: "CONNECT", host)) == .badRequest)
    #expect(refusal(head("/", method: "TRACE", host)) == .badRequest)
    // Upgrades only on /ws (with Origin) and the broker.
    #expect(refusal(head("/ws", with(host, Self.upgrade))) == .forbiddenOrigin)
    #expect(refusal(head("/api/ui", with(with(host, Self.upgrade), ["Origin": "https://192.168.1.20:7443"]))) == .badRequest)
    #expect(refusal(head("/ws?token=x", with(with(host, Self.upgrade), ["Origin": "https://192.168.1.20:7443"]))) == .badRequest)
    #expect(refusal(head("/_hivemind/broker", host)) == .badRequest)
  }

  @Test func sessionCookie() {
    let token = DeviceSessionToken.generate()
    let one = head("/", ["Cookie": "a=1; __Host-hivemind-device=\(token.value)"])
    #expect(GatewayPolicy.sessionToken(one) == token)
    let two = head("/", ["Cookie": "__Host-hivemind-device=\(token.value)", "cookie": "b=2"])
    #expect(GatewayPolicy.sessionToken(two) == nil)
    #expect(GatewayPolicy.sessionToken(head("/", [:])) == nil)
  }
}
