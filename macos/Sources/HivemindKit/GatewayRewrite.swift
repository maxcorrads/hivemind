import Foundation

// What the gateway changes on the way to the Node server and back
// (docs/remote-access.md#proxy). The Node server stays exactly as it is:
// to it the gateway is one more native local Human client on
// http://127.0.0.1:<port>, which sends its own Human capability in
// X-Hivemind-Human (docs/local-human-security.md#server-policy). The device
// never holds that capability: every Cookie it sends is dropped and every
// Set-Cookie the server answers with is removed.

/// The Node server's Human capability as the gateway holds it: the value of
/// the `hivemind_human_<port>` cookie, 32 random bytes in unpadded base64url.
/// Kept in memory only, never logged, never sent to a device.
public struct HumanCapability: Equatable, Sendable, CustomStringConvertible {
  public let value: String

  /// The format the server generates (src/server/local-auth.ts).
  public init?(_ value: String) {
    guard value.utf8.count == 43, value.utf8.allSatisfy(Base64URL.isAlphabet) else { return nil }
    self.value = value
  }

  public static func cookieName(port: Int) -> String { "hivemind_human_\(port)" }

  /// The capability in the Set-Cookie fields of the server's answer to
  /// POST /api/ui/session; nil when there is none, or more than one.
  public init?(setCookie fields: [String], port: Int) {
    let name = Self.cookieName(port: port)
    var found: HumanCapability?
    for field in fields {
      let pair = field.split(separator: ";", maxSplits: 1, omittingEmptySubsequences: false)[0]
      guard let equals = pair.firstIndex(of: "="), pair[..<equals].trimmingCharacters(in: .whitespaces) == name else { continue }
      guard found == nil, let value = HumanCapability(pair[pair.index(after: equals)...].trimmingCharacters(in: .whitespaces)) else {
        return nil
      }
      found = value
    }
    guard let found else { return nil }
    self = found
  }

  /// The bootstrap a native client makes: POST /api/ui/session with the
  /// loopback Origin and a JSON media type, the only form the server takes.
  public static func bootstrapRequest(port: Int) -> Data {
    let origin = GatewayRewrite.loopbackOrigin(port: port)
    let head = HTTPRequestHead(method: "POST", target: "/api/ui/session", headers: [
      "Host": GatewayRewrite.loopbackHost(port: port),
      "Origin": origin,
      "Content-Type": "application/json",
      "Content-Length": "2",
      "Connection": "close",
    ])
    var out = head.serialized
    out.append(Data("{}".utf8))
    return out
  }

  public var description: String { "HumanCapability(…)" }
}

public enum GatewayRewrite {
  public static func loopbackHost(port: Int) -> String { "\(ServerEndpoint.host):\(port)" }
  public static func loopbackOrigin(port: Int) -> String { "http://\(loopbackHost(port: port))" }

  /// Hop-by-hop fields (RFC 9110 §7.6.1), dropped in both directions; the
  /// gateway writes its own framing and connection handling.
  static let hopByHop: Set<String> = [
    "connection", "keep-alive", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade",
  ]

  /// Fields that never reach the Node server from a device.
  static let droppedFromDevice: Set<String> = [
    // The device cookie is the gateway's; a Human cookie must never come from a device.
    "cookie",
    // Set again below, to the gateway's own capability.
    "x-hivemind-human",
    // Would name the gateway's origin; the server does not need it.
    "referer",
    // The server ignores these; no proxy header may manufacture trust.
    "forwarded", "x-real-ip",
    // The gateway answers Expect itself.
    "expect",
    // Framing and authority, written again below.
    "content-length", "host", "origin",
  ]

  static func isDroppedFromDevice(_ name: String) -> Bool {
    let lower = name.lowercased()
    return droppedFromDevice.contains(lower) || hopByHop.contains(lower) || lower.hasPrefix("x-forwarded-") || lower.hasPrefix("proxy-")
  }

  /// The request as the Node server gets it. `framing` is the body's framing
  /// (the gateway forwards the same one it read, framed again). A WebSocket
  /// upgrade keeps `Connection: Upgrade` and `Upgrade: websocket`; anything
  /// else asks the server to close after its answer, since the gateway uses
  /// a fresh loopback connection per request.
  public static func upstreamRequest(
    _ head: HTTPRequestHead, serverPort: Int, capability: HumanCapability, framing: HTTPBodyFraming, webSocket: Bool
  ) -> HTTPRequestHead {
    let hadOrigin = head.headers.contains("Origin")
    // Fields the device named in Connection are hop-by-hop too.
    let named = Set(head.headers.tokens("Connection"))
    var headers = head.headers
    headers.removeAll { isDroppedFromDevice($0.name) || named.contains($0.name.lowercased()) }
    var out = HTTPHeaders([HTTPField("Host", loopbackHost(port: serverPort))])
    if hadOrigin { out.add("Origin", loopbackOrigin(port: serverPort)) }
    for field in headers.fields { out.add(field.name, field.value) }
    out.add("X-Hivemind-Human", capability.value)
    switch framing {
    case .length(let length): out.add("Content-Length", String(length))
    case .chunked: out.add("Transfer-Encoding", "chunked")
    case .none, .untilClose:
      // A POST without a body still says so, as clients do.
      if ["POST", "PUT", "PATCH"].contains(head.method) { out.add("Content-Length", "0") }
    }
    if webSocket {
      out.add("Connection", "Upgrade")
      out.add("Upgrade", "websocket")
    } else {
      out.add("Connection", "close")
    }
    return HTTPRequestHead(method: head.method, target: head.target, version: .http11, headers: out)
  }

  /// How the device gets a body the server framed as `upstream`: a length
  /// stays a length; chunked and close-delimited bodies go out chunked to an
  /// HTTP/1.1 device (so its connection can be kept), and close-delimited to
  /// an HTTP/1.0 one.
  public static func downstreamFraming(_ upstream: HTTPBodyFraming, deviceVersion: HTTPVersion) -> HTTPBodyFraming {
    switch upstream {
    case .none, .length: upstream
    case .chunked, .untilClose: deviceVersion == .http11 ? .chunked : .untilClose
    }
  }

  /// The response as the device gets it: no Set-Cookie at all (the Human
  /// capability stays in the gateway), no hop-by-hop fields, the framing the
  /// gateway writes, and a Location that points at the loopback server
  /// pointing at the gateway instead.
  public static func downstreamResponse(
    _ head: HTTPResponseHead, serverPort: Int, gatewayOrigin: String, framing: HTTPBodyFraming, close: Bool, webSocket: Bool
  ) -> HTTPResponseHead {
    let named = Set(head.headers.tokens("Connection"))
    // A HEAD, 204 or 304 answer keeps the server's Content-Length: it
    // describes the body a GET would have had.
    let keepsLength = framing == .none && head.headers.contains("Content-Length")
    var out = HTTPHeaders()
    for field in head.headers.fields {
      let lower = field.name.lowercased()
      if lower == "set-cookie" || hopByHop.contains(lower) || named.contains(lower) { continue }
      if lower == "content-length" && !keepsLength { continue }
      if lower == "location" {
        out.add(field.name, rewriteLocation(field.value, serverPort: serverPort, gatewayOrigin: gatewayOrigin))
        continue
      }
      out.add(field.name, field.value)
    }
    if webSocket {
      out.add("Connection", "Upgrade")
      out.add("Upgrade", "websocket")
    } else {
      switch framing {
      case .length(let length): out.add("Content-Length", String(length))
      case .chunked: out.add("Transfer-Encoding", "chunked")
      case .none:
        if !keepsLength && !(head.status == 204 || head.status == 304 || head.isInformational) {
          out.add("Content-Length", "0")
        }
      case .untilClose: break
      }
      if close || framing == .untilClose { out.add("Connection", "close") }
    }
    return HTTPResponseHead(status: head.status, reason: head.reason, version: .http11, headers: out)
  }

  /// `http://127.0.0.1:<port>` followed by nothing, `/`, `?` or `#` becomes
  /// the gateway origin; anything else is left alone.
  public static func rewriteLocation(_ location: String, serverPort: Int, gatewayOrigin: String) -> String {
    let loopback = loopbackOrigin(port: serverPort)
    guard location.hasPrefix(loopback) else { return location }
    let rest = location.dropFirst(loopback.count)
    guard rest.isEmpty || ["/", "?", "#"].contains(rest.first!) else { return location }
    return gatewayOrigin + rest
  }

  /// Whether a response tells the gateway its capability went stale (the
  /// server restarted): the ingress gate's pre-handler 401.
  public static func requiresNewCapability(_ head: HTTPResponseHead) -> Bool {
    head.status == 401 && head.headers["X-Hivemind-Session-Required"] == "1"
  }
}
