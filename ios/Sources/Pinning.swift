import Foundation
import HivemindKit
import Security

// Certificate pinning for everything the app sends to a gateway: the web
// view's loads (its navigation delegate), the pairing and session calls
// (PinnedHTTPTransport) and the broker WebSocket (URLSessionWebSocketTasking).
// A gateway has a self-signed certificate, so there is no system trust to
// ask: a server is accepted only when its leaf certificate hashes to the
// fingerprint from the QR code (docs/remote-access.md#tls-and-pinning).

enum ServerTrustPinning {
  struct Outcome {
    let disposition: URLSession.AuthChallengeDisposition
    let credential: URLCredential?
    /// The server presented a certificate other than the pinned one.
    let mismatch: Bool
  }

  /// `host`: when given, only a challenge for that host is judged by the pin;
  /// any other host gets the system's own evaluation (the web view may load
  /// an https resource from elsewhere, which the pin says nothing about).
  static func evaluate(_ challenge: URLAuthenticationChallenge, pin: CertificateFingerprint, host: String? = nil) -> Outcome {
    let space = challenge.protectionSpace
    guard space.authenticationMethod == NSURLAuthenticationMethodServerTrust else {
      // No client certificates, no HTTP authentication: a gateway asks for neither.
      return Outcome(disposition: .rejectProtectionSpace, credential: nil, mismatch: false)
    }
    if let host, !sameHost(space.host, host) {
      return Outcome(disposition: .performDefaultHandling, credential: nil, mismatch: false)
    }
    guard let trust = space.serverTrust, let leaf = leafCertificate(trust), pin.matches(certificateDER: leaf) else {
      return Outcome(disposition: .cancelAuthenticationChallenge, credential: nil, mismatch: true)
    }
    return Outcome(disposition: .useCredential, credential: URLCredential(trust: trust), mismatch: false)
  }

  /// The DER bytes of the certificate the server presented first.
  static func leafCertificate(_ trust: SecTrust) -> Data? {
    guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let leaf = chain.first else { return nil }
    return SecCertificateCopyData(leaf) as Data
  }

  /// Protection-space hosts come without brackets and in any case.
  static func sameHost(_ a: String, _ b: String) -> Bool {
    func bare(_ host: String) -> String {
      let trimmed = host.hasPrefix("[") && host.hasSuffix("]") ? String(host.dropFirst().dropLast()) : host
      return GatewayEndpoint(host: trimmed, port: 1)?.host ?? trimmed.lowercased()
    }
    return bare(a) == bare(b)
  }

  /// The handler URLSessionWebSocketTasking takes, for one Mac.
  static func authenticator(pin: CertificateFingerprint) -> URLSessionWebSocketTasking.Authenticate {
    { challenge in
      let outcome = evaluate(challenge, pin: pin)
      return (outcome.disposition, outcome.credential)
    }
  }
}

/// The gateway's own endpoints over an ephemeral URLSession: no cookie
/// store, no cache, no redirects, TLS pinned. One session per request, so
/// a pin never outlives the call it was made for.
struct PinnedHTTPTransport: RemoteHTTPTransport {
  func send(_ request: URLRequest, pin: CertificateFingerprint) async throws -> RemoteHTTPResponse {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpCookieStorage = nil
    configuration.httpShouldSetCookies = false
    configuration.urlCache = nil
    configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
    configuration.waitsForConnectivity = false
    let delegate = PinningDelegate(pin: pin)
    let session = URLSession(configuration: configuration, delegate: delegate, delegateQueue: nil)
    defer { session.finishTasksAndInvalidate() }
    do {
      let (data, response) = try await session.data(for: request)
      guard let http = response as? HTTPURLResponse else { throw RemoteClientError.badResponse("not an HTTP reply") }
      var headers: [String: String] = [:]
      for (name, value) in http.allHeaderFields {
        if let name = name as? String, let value = value as? String { headers[name] = value }
      }
      return RemoteHTTPResponse(status: http.statusCode, headers: headers, body: data)
    } catch let error as RemoteClientError {
      throw error
    } catch {
      if delegate.mismatch.value { throw RemoteClientError.pinMismatch }
      throw RemoteClientError.unreachable(error.localizedDescription)
    }
  }

  private final class PinningDelegate: NSObject, URLSessionTaskDelegate, Sendable {
    let pin: CertificateFingerprint
    let mismatch = Flag()

    init(pin: CertificateFingerprint) { self.pin = pin }

    func urlSession(
      _ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
      completionHandler: @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
      let outcome = ServerTrustPinning.evaluate(challenge, pin: pin)
      if outcome.mismatch { mismatch.set() }
      completionHandler(outcome.disposition, outcome.credential)
    }

    func urlSession(
      _ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
      newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void
    ) {
      // A gateway never redirects its own endpoints; following one would
      // send the device token somewhere else.
      completionHandler(nil)
    }
  }
}

/// A flag set from URLSession's delegate queue and read after the call.
final class Flag: @unchecked Sendable {
  private let lock = NSLock()
  private var raised = false

  var value: Bool { lock.withLock { raised } }
  func set() { lock.withLock { raised = true } }
}
