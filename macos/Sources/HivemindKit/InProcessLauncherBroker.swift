import Foundation

/// Uses the same authenticated broker request path as a socket client, but
/// hands frames directly to the Server.app's broker instance. This preserves
/// its launch serialization, tmux ownership checks and template vault handoff.
@MainActor public final class InProcessLauncherBroker: LauncherBrokering {
  private let current: @MainActor () -> TerminalBroker?

  public init(current: @escaping @MainActor () -> TerminalBroker?) { self.current = current }

  public func sessions() async throws -> [BrokerSession] {
    let event = try await request(.sessionsList)
    guard case .sessions(let sessions) = event else { throw failure(event) }
    return sessions
  }

  public func launch(_ launch: BrokerLaunch) async throws -> SessionName {
    let event = try await request(.launch([launch]))
    guard case .launched(let names, _, let errors) = event, let name = names.first ?? nil, errors.isEmpty else {
      throw failure(event)
    }
    return name
  }

  public func kill(_ session: SessionName) async throws {
    let event = try await request(.kill(session: session))
    guard case .killed(let killed) = event, killed == session else { throw failure(event) }
  }

  private func failure(_ event: BrokerEvent) -> BrokerProtocolError {
    if case .error(let code, let message, _) = event { return .init(code, message) }
    return .init(.internal, "unexpected broker reply")
  }

  private func request(_ value: BrokerRequest) async throws -> BrokerEvent {
    guard let broker = current(), broker.isRunning else {
      throw BrokerProtocolError(.internal, "terminal broker is not running")
    }
    let transport = DirectTransport()
    guard let connection = broker.accept(transport) else {
      throw BrokerProtocolError(.internal, "terminal broker refused its launcher")
    }
    transport.connection = connection
    defer { connection.close() }
    let welcome = try await exchange(.hello(version: BrokerProtocol.version, token: broker.token.value, client: "launcher"),
                                     connection: connection, transport: transport)
    guard case .welcome = welcome else { throw failure(welcome) }
    return try await exchange(value, connection: connection, transport: transport)
  }

  private func exchange(_ request: BrokerRequest, connection: BrokerConnection, transport: DirectTransport) async throws -> BrokerEvent {
    let id = UUID().uuidString
    let frame = try BrokerRequestFrame(id: id, request).line()
    return try await withCheckedThrowingContinuation { continuation in
      transport.reply = { event in
        guard event.id == id else { return }
        transport.reply = nil
        transport.onClosed = nil
        continuation.resume(returning: event.event)
      }
      transport.onClosed = {
        transport.reply = nil
        transport.onClosed = nil
        continuation.resume(throwing: BrokerProtocolError(.internal, "terminal broker connection closed"))
      }
      connection.received(frame)
    }
  }
}

@MainActor private final class DirectTransport: BrokerTransport {
  weak var connection: BrokerConnection?
  var reply: ((BrokerEventFrame) -> Void)?
  var onClosed: (() -> Void)?

  func send(_ data: Data) {
    if let frame = try? BrokerEventFrame.decode(Data(data.dropLast())) { reply?(frame) }
    else { onClosed?() }
    connection?.wrote(data.count)
  }

  func close() { connection = nil; onClosed?() }
}
