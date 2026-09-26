import Darwin
import Foundation

/// One GET, abstracted so tests never open a socket.
public protocol HTTPGetting: Sendable {
  func get(_ url: URL, timeout: TimeInterval) async throws -> (status: Int, body: Data)
}

/// URLSession without cookies or caches: the health check must not pick up
/// or disturb the WKWebView's Human session.
public struct URLSessionGetter: HTTPGetting {
  private let session: URLSession

  public init() {
    let config = URLSessionConfiguration.ephemeral
    config.httpCookieStorage = nil
    config.httpShouldSetCookies = false
    config.urlCache = nil
    config.requestCachePolicy = .reloadIgnoringLocalCacheData
    session = URLSession(configuration: config)
  }

  public func get(_ url: URL, timeout: TimeInterval) async throws -> (status: Int, body: Data) {
    var request = URLRequest(url: url, timeoutInterval: timeout)
    request.httpMethod = "GET"
    let (data, response) = try await session.data(for: request)
    return ((response as? HTTPURLResponse)?.statusCode ?? 0, data)
  }
}

public enum HealthStatus: Equatable, Sendable {
  case healthy
  /// Something answered but it is not a Hivemind server (another app owns the port).
  case foreign
  case unreachable(String)
}

public struct HealthChecker: Sendable {
  private let http: any HTTPGetting
  public let timeout: TimeInterval

  public init(http: any HTTPGetting = URLSessionGetter(), timeout: TimeInterval = 2) {
    self.http = http
    self.timeout = timeout
  }

  public func check(_ endpoint: ServerEndpoint) async -> HealthStatus {
    do {
      let (status, body) = try await http.get(endpoint.healthURL, timeout: timeout)
      return Self.interpret(status: status, body: body)
    } catch {
      return .unreachable(error.localizedDescription)
    }
  }

  /// /api/health answers {"ok":true,"name":"hivemind"} (src/server/app.ts).
  static func interpret(status: Int, body: Data) -> HealthStatus {
    struct Health: Decodable { let ok: Bool?; let name: String? }
    guard status == 200, let health = try? JSONDecoder().decode(Health.self, from: body),
          health.ok == true, health.name == "hivemind" else { return .foreign }
    return .healthy
  }
}

/// Whether something already listens on a loopback port, answered by
/// connecting rather than binding: a bind probe can race the real server and
/// misreads TIME_WAIT. Only the server app calls this; tests inject a fake.
public protocol PortProbing: Sendable {
  func isListening(_ port: ServerPort) -> Bool
}

public struct LoopbackPortProbe: PortProbing {
  public init() {}

  public func isListening(_ port: ServerPort) -> Bool {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    guard fd >= 0 else { return false }
    defer { close(fd) }
    var address = sockaddr_in()
    address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    address.sin_family = sa_family_t(AF_INET)
    address.sin_port = in_port_t(UInt16(port.value).bigEndian)
    address.sin_addr.s_addr = inet_addr(ServerEndpoint.host)
    let result = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
    }
    return result == 0
  }
}
