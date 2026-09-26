import Foundation

// The iOS app's WebSocket to the gateway's terminal broker
// (wss://<gateway>/_hivemind/broker, docs/remote-access.md#terminal-broker):
// a WebSocketChannel over URLSessionWebSocketTask, which
// WebSocketBrokerConnector turns into the byte stream BrokerClient speaks.
//
// Each connection first asks `prepare` for its request, so it always
// carries a current device-session cookie (renewed when due) and goes to
// the host that issued it. The request carries no Origin: the gateway
// refuses one on its own endpoints. TLS is pinned by the `authenticate`
// handler the app passes in, since certificate code (Security) stays in
// the app; everything here is Foundation. The task sits behind
// WebSocketTasking, so the tests drive the channel with a fake one.

/// What the channel needs of URLSessionWebSocketTask.
@MainActor
public protocol WebSocketTasking: AnyObject {
  func resume()
  func send(text: String, completion: @escaping @MainActor @Sendable ((any Error)?) -> Void)
  /// One message per call; the next is only read when asked for, which is
  /// how the channel pauses (setReceiving(false)).
  func receive(completion: @escaping @MainActor @Sendable (Result<URLSessionWebSocketTask.Message, any Error>) -> Void)
  /// Ends the connection; no event follows.
  func cancel()
}

/// What the task reports besides replies to receive(), on the main actor:
/// the upgrade went through, the peer closed, or the task ended.
public struct WebSocketTaskEvents: Sendable {
  public var onOpen: @MainActor @Sendable () -> Void
  /// The server's close frame: its code, raw value.
  public var onClose: @MainActor @Sendable (Int) -> Void
  /// The task ended; with the HTTP status of a refused upgrade when there
  /// was one (401 when the session is gone).
  public var onComplete: @MainActor @Sendable ((any Error)?, Int?) -> Void

  public init(
    onOpen: @escaping @MainActor @Sendable () -> Void,
    onClose: @escaping @MainActor @Sendable (Int) -> Void,
    onComplete: @escaping @MainActor @Sendable ((any Error)?, Int?) -> Void
  ) {
    self.onOpen = onOpen
    self.onClose = onClose
    self.onComplete = onComplete
  }
}

@MainActor
public final class RemoteWebSocketChannel: WebSocketChannel {
  public typealias Prepare = @MainActor () async throws -> URLRequest
  public typealias MakeTask = @MainActor (URLRequest, WebSocketTaskEvents) -> any WebSocketTasking

  /// At least what the gateway may send in one message (a broker event line
  /// and its newline); URLSessionWebSocketTask's default is 1 MiB.
  public nonisolated static let maximumMessageSize = GatewayLimits.maxBrokerMessageOutBytes + 1024
  /// A normal close (1000) is an orderly end; anything else is reported.
  static let normalClosure = 1000

  private enum State {
    case idle
    case preparing
    case connecting
    case open
    case finished
  }

  private let prepare: Prepare
  private let makeTask: MakeTask
  /// Told when the gateway refused the upgrade with 401: the device session
  /// the request carried is not valid there any more (Hivemind Server
  /// restarted, say), so the next attempt must not reuse it.
  private let onUnauthorized: @MainActor () -> Void
  private var state = State.idle
  private var handlers: WebSocketChannelHandlers?
  private var task: (any WebSocketTasking)?
  private var receiving = true
  private var receivePending = false
  /// Messages sent before the upgrade completed.
  private var queued: [String] = []

  public init(prepare: @escaping Prepare, makeTask: @escaping MakeTask, onUnauthorized: @escaping @MainActor () -> Void = {}) {
    self.prepare = prepare
    self.makeTask = makeTask
    self.onUnauthorized = onUnauthorized
  }

  public func start(handlers: WebSocketChannelHandlers) {
    guard case .idle = state else { return }
    self.handlers = handlers
    state = .preparing
    Task { @MainActor [weak self] in
      guard let self else { return }
      let request: URLRequest
      do {
        request = try await self.prepare()
      } catch {
        return self.finish(error.localizedDescription)
      }
      self.connect(request)
    }
  }

  private func connect(_ request: URLRequest) {
    guard case .preparing = state else { return }
    state = .connecting
    let task = makeTask(request, WebSocketTaskEvents(
      onOpen: { [weak self] in self?.opened() },
      onClose: { [weak self] code in
        self?.finish(code == Self.normalClosure ? nil : "The gateway closed the terminal connection (\(code))")
      },
      onComplete: { [weak self] error, status in self?.completed(error: error, status: status) }))
    self.task = task
    task.resume()
  }

  private func opened() {
    guard case .connecting = state else { return }
    state = .open
    let waiting = queued
    queued = []
    for text in waiting { write(text) }
    handlers?.onOpen()
    pump()
  }

  private func completed(error: (any Error)?, status: Int?) {
    guard state != .finished else { return }
    if status == 401 {
      onUnauthorized()
      return finish("The gateway refused the device session")
    }
    if let status, status != 101 {
      return finish("The gateway answered \(status)")
    }
    finish(error.map { $0.localizedDescription })
  }

  public func send(_ message: Data) {
    let text = String(decoding: message, as: UTF8.self)
    switch state {
    case .idle, .preparing, .connecting: queued.append(text)
    case .open: write(text)
    case .finished: break
    }
  }

  private func write(_ text: String) {
    task?.send(text: text) { [weak self] error in
      guard let self, let error else { return }
      self.finish(error.localizedDescription)
    }
  }

  public func setReceiving(_ receiving: Bool) {
    self.receiving = receiving
    pump()
  }

  /// Asks for the next message unless one is being read or reading is paused.
  private func pump() {
    guard case .open = state, receiving, !receivePending, let task else { return }
    receivePending = true
    task.receive { [weak self] result in
      guard let self, case .open = self.state else { return }
      self.receivePending = false
      switch result {
      case .success(.string(let text)):
        self.handlers?.onMessage(Data(text.utf8))
        self.pump()
      case .success(.data):
        self.finish("The gateway sent a binary message")
      case .success:
        self.finish("The gateway sent an unknown message")
      case .failure(let error):
        self.finish(error.localizedDescription)
      }
    }
  }

  public func close() {
    guard state != .finished else { return }
    state = .finished
    handlers = nil
    queued = []
    task?.cancel()
    task = nil
  }

  /// Ends the connection once and tells the owner, unless it closed it.
  private func finish(_ reason: String?) {
    guard state != .finished else { return }
    let handlers = handlers
    close()
    handlers?.onClose(reason)
  }
}

// MARK: - URLSession

/// The live WebSocketTasking: a URLSessionWebSocketTask in a URLSession of
/// its own, ephemeral (no cookie storage, no cache: the Cookie header is
/// set on the request) and invalidated when the connection ends, which
/// releases its delegate. Server trust goes to `authenticate`.
@MainActor
public final class URLSessionWebSocketTasking: WebSocketTasking {
  public typealias Authenticate = @Sendable (URLAuthenticationChallenge) -> (URLSession.AuthChallengeDisposition, URLCredential?)

  private let session: URLSession
  private let task: URLSessionWebSocketTask

  public init(request: URLRequest, events: WebSocketTaskEvents, authenticate: @escaping Authenticate) {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.httpCookieStorage = nil
    configuration.httpShouldSetCookies = false
    configuration.urlCache = nil
    configuration.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
    // Callbacks on the main queue, in order.
    session = URLSession(configuration: configuration, delegate: Delegate(events: events, authenticate: authenticate), delegateQueue: .main)
    task = session.webSocketTask(with: request)
    task.maximumMessageSize = RemoteWebSocketChannel.maximumMessageSize
  }

  /// The factory RemoteWebSocketChannel takes.
  public static func maker(authenticate: @escaping Authenticate) -> RemoteWebSocketChannel.MakeTask {
    { request, events in URLSessionWebSocketTasking(request: request, events: events, authenticate: authenticate) }
  }

  public func resume() { task.resume() }

  public func send(text: String, completion: @escaping @MainActor @Sendable ((any Error)?) -> Void) {
    task.send(.string(text)) { error in
      DispatchQueue.main.async { MainActor.assumeIsolated { completion(error) } }
    }
  }

  public func receive(completion: @escaping @MainActor @Sendable (Result<URLSessionWebSocketTask.Message, any Error>) -> Void) {
    task.receive { result in
      DispatchQueue.main.async { MainActor.assumeIsolated { completion(result) } }
    }
  }

  public func cancel() {
    task.cancel(with: .normalClosure, reason: nil)
    session.invalidateAndCancel()
  }

  private final class Delegate: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
    let events: WebSocketTaskEvents
    let authenticate: Authenticate

    init(events: WebSocketTaskEvents, authenticate: @escaping Authenticate) {
      self.events = events
      self.authenticate = authenticate
    }

    func urlSession(
      _ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
      completionHandler: @escaping @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
    ) {
      let (disposition, credential) = authenticate(challenge)
      completionHandler(disposition, credential)
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
      let events = events
      MainActor.assumeIsolated { events.onOpen() }
    }

    func urlSession(
      _ session: URLSession, webSocketTask: URLSessionWebSocketTask,
      didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?
    ) {
      let events = events
      let code = closeCode.rawValue
      MainActor.assumeIsolated { events.onClose(code) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: (any Error)?) {
      let events = events
      let status = (task.response as? HTTPURLResponse)?.statusCode
      session.finishTasksAndInvalidate()
      MainActor.assumeIsolated { events.onComplete(error, status) }
    }
  }
}

/// The broker over the gateway for one Mac: BrokerClient with this as its
/// connector sends the placeholder token, which the gateway replaces
/// (GatewayBrokerHello).
public enum RemoteBrokerConnection {
  /// The broker request for `session`: its origin's /_hivemind/broker, with
  /// the session cookie and nothing else a browser would add.
  public static func request(for session: RemoteDeviceSession) -> URLRequest {
    var request = URLRequest(url: session.endpoint.brokerURL, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData, timeoutInterval: RemoteClientRequest.timeout)
    request.httpShouldHandleCookies = false
    request.setValue(session.cookieHeader, forHTTPHeaderField: "Cookie")
    return request
  }

  /// hello.client for the broker's log; the gateway replaces it with the
  /// device's own label anyway.
  public static let clientLabel = "Hivemind iOS"

  /// Longer than the local broker's 5 s: a connection may first fetch a
  /// device session and try several hosts over Wi-Fi or a VPN.
  public static let helloTimeout: TimeInterval = 30

  /// A BrokerClient configuration for one Mac. `session` gives the current
  /// device session (renewing it when due); `invalidate` drops one the
  /// gateway refused.
  @MainActor
  public static func configuration(
    session: @escaping @MainActor () async throws -> RemoteDeviceSession,
    invalidate: @escaping @MainActor () -> Void,
    makeTask: @escaping RemoteWebSocketChannel.MakeTask
  ) -> BrokerClient.Configuration {
    BrokerClient.Configuration(
      connector: WebSocketBrokerConnector(makeChannel: {
        RemoteWebSocketChannel(
          prepare: { request(for: try await session()) },
          makeTask: makeTask,
          onUnauthorized: invalidate)
      }),
      token: { GatewayBrokerHello.deviceToken },
      clientLabel: clientLabel,
      helloTimeout: helloTimeout)
  }
}
