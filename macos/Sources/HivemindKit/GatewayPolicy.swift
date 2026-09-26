import Foundation

// Which requests the gateway serves, and how (docs/remote-access.md#protocol).
// Decided from the request head alone, before any body is read or anything
// is sent to the Node server. The session check itself needs the gateway's
// state and happens after routing (GatewayServer).

/// Where a request goes once it passed the head checks.
public enum GatewayRoute: Equatable, Sendable {
  /// POST /_hivemind/pair
  case pair
  /// POST /_hivemind/session
  case session
  /// GET /_hivemind/broker, a WebSocket the gateway ends itself.
  case broker(webSocketKey: String)
  /// Anything else, proxied to the Node server.
  case proxy
  /// GET /ws, proxied as a WebSocket upgrade.
  case proxyWebSocket
}

public enum GatewayPolicy {
  /// The authority in a Host field: an IP literal (IPv6 in brackets) or a
  /// DNS name, and an explicit port. Nil for anything else, including user
  /// info, a path or a missing port.
  public static func authority(_ host: String) -> GatewayEndpoint? {
    let hostPart: Substring, portPart: Substring
    if host.hasPrefix("[") {
      guard let close = host.firstIndex(of: "]"), host[host.index(after: close)...].hasPrefix(":") else { return nil }
      hostPart = host[host.index(after: host.startIndex)..<close]
      guard IPAddress(String(hostPart))?.isIPv6 == true, !hostPart.contains("%") else { return nil }
      portPart = host[host.index(close, offsetBy: 2)...]
    } else {
      guard let colon = host.lastIndex(of: ":"), !host[..<colon].contains(":") else { return nil }
      hostPart = host[..<colon]
      portPart = host[host.index(after: colon)...]
    }
    guard !portPart.isEmpty, portPart.count <= 5, portPart.utf8.allSatisfy({ (UInt8(ascii: "0")...UInt8(ascii: "9")).contains($0) }),
          !portPart.hasPrefix("0"), let port = Int(portPart)
    else { return nil }
    return GatewayEndpoint(host: String(hostPart), port: port)
  }

  /// The names a request may use for this gateway on a connection that
  /// arrived at `local`: that address itself (without a zone: a Host never
  /// carries one) and the Mac's Bonjour names, all on the gateway's port.
  public static func allowedEndpoints(local: IPAddress, port: Int, names: [String]) -> Set<GatewayEndpoint> {
    var bare = local.unmapped
    if case .v6(let bytes, _) = bare { bare = .v6(bytes, zone: nil) }
    var out = Set<GatewayEndpoint>()
    if let endpoint = GatewayEndpoint(host: bare.description, port: port) { out.insert(endpoint) }
    for name in names {
      if let endpoint = GatewayEndpoint(host: name, port: port) { out.insert(endpoint) }
    }
    return out
  }

  /// The route of `head`, and the endpoint it named in Host, or the error to
  /// answer with. The checks, in order:
  ///
  /// - origin-form target only (no absolute form, no `*`), no CONNECT or TRACE;
  /// - exactly one Host, naming this gateway (`allowed`), so a DNS-rebound
  ///   name never reaches the server;
  /// - Origin: the gateway's own endpoints refuse any (only native code calls
  ///   them); everything else accepts only the gateway's own origin, and
  ///   /ws requires it;
  /// - upgrades only where a WebSocket is served.
  public static func route(_ head: HTTPRequestHead, allowed: Set<GatewayEndpoint>) throws(GatewayError) -> (GatewayRoute, GatewayEndpoint) {
    guard head.method != "CONNECT", head.method != "TRACE" else { throw GatewayError(.badRequest, "\(head.method) is not supported") }
    guard head.target.hasPrefix("/") else { throw GatewayError(.badRequest, "the request target must be a path") }
    let hosts = head.headers.values("Host")
    guard hosts.count == 1, let endpoint = authority(hosts[0]), allowed.contains(endpoint) else {
      throw GatewayError(.forbiddenOrigin, "the Host does not name this gateway")
    }
    let origins = head.headers.values("Origin")
    guard origins.count <= 1 else { throw GatewayError(.forbiddenOrigin, "more than one Origin") }
    let origin = origins.first
    let path = head.path
    let upgrade = WebSocketHandshake.isUpgrade(head)

    if GatewayPath.isGatewayOwned(path) {
      guard origin == nil else { throw GatewayError(.forbiddenOrigin, "gateway endpoints take no Origin") }
      switch path {
      case GatewayPath.pair, GatewayPath.session:
        guard head.method == "POST", !upgrade else { throw GatewayError(.badRequest, "\(path) takes POST") }
        return (path == GatewayPath.pair ? .pair : .session, endpoint)
      case GatewayPath.broker:
        return (.broker(webSocketKey: try WebSocketHandshake.key(of: head)), endpoint)
      default:
        throw GatewayError(.notFound, "no such gateway endpoint")
      }
    }

    if let origin, origin != endpoint.origin { throw GatewayError(.forbiddenOrigin, "the Origin is not this gateway") }
    if upgrade {
      guard head.target == GatewayPath.serverWebSocket else { throw GatewayError(.badRequest, "no WebSocket here") }
      guard origin != nil else { throw GatewayError(.forbiddenOrigin, "a WebSocket needs the gateway's Origin") }
      _ = try WebSocketHandshake.key(of: head)
      return (.proxyWebSocket, endpoint)
    }
    return (.proxy, endpoint)
  }

  /// The device session a request carries in its one Cookie field, if any.
  /// More than one Cookie field fails closed, like a repeated cookie name.
  public static func sessionToken(_ head: HTTPRequestHead) -> DeviceSessionToken? {
    let cookies = head.headers.values("Cookie")
    guard cookies.count == 1 else { return nil }
    return DeviceSessionCookie.token(fromCookieHeader: cookies[0])
  }
}
