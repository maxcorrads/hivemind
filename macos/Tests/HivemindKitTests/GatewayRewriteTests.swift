import Foundation
import Testing
@testable import HivemindKit

// What reaches the Node server, and what reaches the device.

let testCapability = HumanCapability(String(repeating: "h", count: 43))!

struct GatewayRewriteTests {
  let origin = "https://192.168.1.20:7443"

  func deviceRequest(_ fields: HTTPHeaders, method: String = "GET", target: String = "/api/ui/snapshot") -> HTTPRequestHead {
    HTTPRequestHead(method: method, target: target, headers: fields)
  }

  @Test func requestToTheServer() {
    let head = deviceRequest([
      "Host": "192.168.1.20:7443",
      "Origin": origin,
      "Cookie": "__Host-hivemind-device=abc; hivemind_human_7420=stolen",
      "X-Hivemind-Human": "forged",
      "Referer": origin + "/",
      "Forwarded": "for=1.2.3.4",
      "X-Forwarded-For": "1.2.3.4",
      "X-Forwarded-Host": "evil",
      "X-Real-IP": "1.2.3.4",
      "Proxy-Authorization": "x",
      "Keep-Alive": "timeout=5",
      "Connection": "keep-alive, X-Secret",
      "X-Secret": "hop",
      "TE": "trailers",
      "Expect": "100-continue",
      "Sec-Fetch-Site": "same-origin",
      "Accept": "application/json",
      "X-Hivemind-UI": "1",
    ])
    let out = GatewayRewrite.upstreamRequest(head, serverPort: 7420, capability: testCapability, framing: .none, webSocket: false)
    #expect(out.fields == [
      HTTPField("Host", "127.0.0.1:7420"),
      HTTPField("Origin", "http://127.0.0.1:7420"),
      HTTPField("Sec-Fetch-Site", "same-origin"),
      HTTPField("Accept", "application/json"),
      HTTPField("X-Hivemind-UI", "1"),
      HTTPField("X-Hivemind-Human", testCapability.value),
      HTTPField("Connection", "close"),
    ])
    #expect(out.target == "/api/ui/snapshot")
  }

  @Test func noOriginStaysWithoutOne() {
    let out = GatewayRewrite.upstreamRequest(deviceRequest(["Host": "x"]), serverPort: 7420, capability: testCapability, framing: .none, webSocket: false)
    #expect(!out.headers.contains("Origin"))
  }

  @Test func bodyFramingIsWrittenAgain() {
    let body = deviceRequest(["Content-Length": "999", "Transfer-Encoding": "chunked"], method: "POST")
    let length = GatewayRewrite.upstreamRequest(body, serverPort: 7420, capability: testCapability, framing: .length(12), webSocket: false)
    #expect(length.headers.values("Content-Length") == ["12"])
    #expect(!length.headers.contains("Transfer-Encoding"))
    let chunked = GatewayRewrite.upstreamRequest(body, serverPort: 7420, capability: testCapability, framing: .chunked, webSocket: false)
    #expect(chunked.headers.values("Transfer-Encoding") == ["chunked"])
    #expect(!chunked.headers.contains("Content-Length"))
    let empty = GatewayRewrite.upstreamRequest(body, serverPort: 7420, capability: testCapability, framing: .none, webSocket: false)
    #expect(empty.headers.values("Content-Length") == ["0"])
  }

  @Test func webSocketUpgradeKeepsItsHeaders() {
    let head = deviceRequest([
      "Host": "192.168.1.20:7443", "Origin": origin, "Connection": "Upgrade", "Upgrade": "websocket",
      "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": "13",
    ], target: "/ws")
    let out = GatewayRewrite.upstreamRequest(head, serverPort: 7420, capability: testCapability, framing: .none, webSocket: true)
    #expect(out.headers.values("Connection") == ["Upgrade"])
    #expect(out.headers.values("Upgrade") == ["websocket"])
    #expect(out.headers["Sec-WebSocket-Key"] == "dGhlIHNhbXBsZSBub25jZQ==")
    #expect(out.headers["Origin"] == "http://127.0.0.1:7420")
  }

  @Test func responseToTheDevice() {
    let head = HTTPResponseHead(status: 302, headers: [
      "Set-Cookie": "hivemind_human_7420=secret; HttpOnly",
      "set-cookie": "other=1",
      "Location": "http://127.0.0.1:7420/#/for-you",
      "Content-Length": "5",
      "Connection": "keep-alive, X-Hop",
      "X-Hop": "1",
      "Keep-Alive": "timeout=5",
      "Content-Security-Policy": "frame-ancestors 'none'",
      "Cache-Control": "no-store",
    ])
    let out = GatewayRewrite.downstreamResponse(head, serverPort: 7420, gatewayOrigin: origin, framing: .length(5), close: false, webSocket: false)
    #expect(out.headers.fields == [
      HTTPField("Location", origin + "/#/for-you"),
      HTTPField("Content-Security-Policy", "frame-ancestors 'none'"),
      HTTPField("Cache-Control", "no-store"),
      HTTPField("Content-Length", "5"),
    ])
  }

  @Test func responseFraming() {
    let chunked = GatewayRewrite.downstreamResponse(
      HTTPResponseHead(status: 200, headers: ["Transfer-Encoding": "chunked"]),
      serverPort: 7420, gatewayOrigin: origin, framing: .chunked, close: true, webSocket: false)
    #expect(chunked.headers.values("Transfer-Encoding") == ["chunked"])
    #expect(chunked.headers.values("Connection") == ["close"])
    // A HEAD answer keeps the length the GET would have had.
    let head = GatewayRewrite.downstreamResponse(
      HTTPResponseHead(status: 200, headers: ["Content-Length": "1234"]),
      serverPort: 7420, gatewayOrigin: origin, framing: .none, close: false, webSocket: false)
    #expect(head.headers.values("Content-Length") == ["1234"])
    let noContent = GatewayRewrite.downstreamResponse(HTTPResponseHead(status: 204), serverPort: 7420, gatewayOrigin: origin, framing: .none, close: false, webSocket: false)
    #expect(!noContent.headers.contains("Content-Length"))
    let empty = GatewayRewrite.downstreamResponse(HTTPResponseHead(status: 200), serverPort: 7420, gatewayOrigin: origin, framing: .none, close: false, webSocket: false)
    #expect(empty.headers.values("Content-Length") == ["0"])
    #expect(GatewayRewrite.downstreamFraming(.untilClose, deviceVersion: .http11) == .chunked)
    #expect(GatewayRewrite.downstreamFraming(.chunked, deviceVersion: .http10) == .untilClose)
    #expect(GatewayRewrite.downstreamFraming(.length(3), deviceVersion: .http10) == .length(3))
  }

  @Test func locations() {
    #expect(GatewayRewrite.rewriteLocation("http://127.0.0.1:7420", serverPort: 7420, gatewayOrigin: origin) == origin)
    #expect(GatewayRewrite.rewriteLocation("http://127.0.0.1:7420?x", serverPort: 7420, gatewayOrigin: origin) == origin + "?x")
    #expect(GatewayRewrite.rewriteLocation("http://127.0.0.1:74200/", serverPort: 7420, gatewayOrigin: origin) == "http://127.0.0.1:74200/")
    #expect(GatewayRewrite.rewriteLocation("/relative", serverPort: 7420, gatewayOrigin: origin) == "/relative")
    #expect(GatewayRewrite.rewriteLocation("https://example.com/", serverPort: 7420, gatewayOrigin: origin) == "https://example.com/")
  }

  @Test func staleCapability() {
    #expect(GatewayRewrite.requiresNewCapability(HTTPResponseHead(status: 401, headers: ["X-Hivemind-Session-Required": "1"])))
    #expect(!GatewayRewrite.requiresNewCapability(HTTPResponseHead(status: 401)))
    #expect(!GatewayRewrite.requiresNewCapability(HTTPResponseHead(status: 403, headers: ["X-Hivemind-Session-Required": "1"])))
  }
}

struct HumanCapabilityTests {
  let value = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO-_"

  @Test func readsTheServersCookie() {
    #expect(HumanCapability(setCookie: ["hivemind_human_7420=\(value); HttpOnly; SameSite=Strict; Path=/"], port: 7420)?.value == value)
    #expect(HumanCapability(setCookie: ["other=1", "hivemind_human_7420=\(value)"], port: 7420)?.value == value)
    #expect(HumanCapability(setCookie: ["hivemind_human_7421=\(value)"], port: 7420) == nil)
    #expect(HumanCapability(setCookie: ["hivemind_human_7420=short"], port: 7420) == nil)
    #expect(HumanCapability(setCookie: ["hivemind_human_7420=\(value)", "hivemind_human_7420=\(value)"], port: 7420) == nil)
    #expect(HumanCapability(setCookie: [], port: 7420) == nil)
    #expect("\(HumanCapability(value)!)" == "HumanCapability(…)")
  }

  @Test func bootstrapIsWhatTheServerTakes() throws {
    let wire = HumanCapability.bootstrapRequest(port: 7420)
    let (head, length) = try #require(try HTTPHeadParser.request(in: wire))
    #expect(head.method == "POST")
    #expect(head.target == "/api/ui/session")
    #expect(head.headers["Host"] == "127.0.0.1:7420")
    #expect(head.headers["Origin"] == "http://127.0.0.1:7420")
    #expect(head.headers["Content-Type"] == "application/json")
    #expect(wire.dropFirst(length) == Data("{}".utf8))
    #expect(try head.bodyFraming() == .length(2))
  }
}

extension HTTPRequestHead {
  var fields: [HTTPField] { headers.fields }
}
