import Foundation

// The gateway forwards only to a Node server that proved it is the one
// Hivemind Server.app started (docs/remote-access.md#verified-server), with
// the same challenge Hivemind.app uses before it gives a page terminals
// (InstanceProof, docs/macos.md#verifying-the-server). Anything could listen
// on the server's loopback port while Hivemind is not bound there; without
// this check the gateway would hand that process the devices' requests and
// the pages it served would reach the Mac's terminals.

/// The Node server the gateway forwards to: the port Hivemind Server.app
/// runs it on and the per-start secret it launched it with. A restart makes
/// a new secret, so it is a new server here even on the same port.
public struct GatewayUpstreamServer: Equatable, Sendable {
  public let port: Int
  public let secret: InstanceSecret?

  public init(port: Int, secret: InstanceSecret?) {
    self.port = port
    self.secret = secret
  }
}

/// Runs the instance challenge against the loopback server; the tests fake
/// it. The completion runs on the main actor.
@MainActor
public protocol GatewayServerVerifying: AnyObject {
  func verify(_ server: GatewayUpstreamServer, completion: @escaping @MainActor (InstanceVerification) -> Void)
}

/// The live verifier: HivemindKit's InstanceVerifier over URLSession, to
/// http://127.0.0.1:<port>/api/health/instance.
@MainActor
public final class InstanceServerVerifier: GatewayServerVerifying {
  private let verifier: InstanceVerifier

  public init(verifier: InstanceVerifier = InstanceVerifier()) {
    self.verifier = verifier
  }

  public func verify(_ server: GatewayUpstreamServer, completion: @escaping @MainActor (InstanceVerification) -> Void) {
    guard let port = ServerPort(server.port) else { return completion(.failed(.unreachable("no port"))) }
    let verifier = verifier
    let secret = server.secret
    Task { @MainActor in
      completion(await verifier.verify(ServerEndpoint(port: port), secret: secret))
    }
  }
}

/// What a request learns about the server before anything is forwarded.
enum GatewayServerVerdict: Equatable, Sendable {
  /// It proved it is Hivemind Server.app's own server.
  case verified
  /// Nothing answered (stopped, restarting): 502 server-unavailable.
  case unavailable
  /// Something answered that could not prove it: 503 server-unverified.
  case unverified
}

/// What the gateway knows about the server right now.
enum GatewayServerTrust: Equatable, Sendable {
  /// Not checked since it started, restarted, failed a connection or asked
  /// for a new Human session: the next request checks first.
  case unchecked
  case verified(GatewayUpstreamServer)
  /// Failed the challenge at this time; asked again only after
  /// GatewayServer.recheckAfterFailure.
  case failed(GatewayUpstreamServer, at: Date)
}

/// One challenge in flight, shared by every request that arrives meanwhile.
@MainActor
final class GatewayServerCheck {
  let server: GatewayUpstreamServer
  var waiters: [@MainActor (GatewayServerVerdict) -> Void] = []
  var timer: (any Cancellable)?
  private var done = false

  init(server: GatewayUpstreamServer) {
    self.server = server
  }

  func finish(_ verdict: GatewayServerVerdict) {
    guard !done else { return }
    done = true
    timer?.cancel()
    let waiters = self.waiters
    self.waiters = []
    for waiter in waiters { waiter(verdict) }
  }
}

extension InstanceVerificationFailure {
  /// For the gateway log; never a secret.
  var logText: String {
    switch self {
    case .noSecret: "Hivemind Server has no instance secret for it"
    case .notOffered: "it has no instance secret, so Hivemind Server did not start it"
    case .wrongProof: "it answered with the wrong proof"
    case .badAnswer(let status): "it answered \(status) to the instance check"
    case .unreachable(let reason): "it did not answer (\(reason))"
    }
  }
}
