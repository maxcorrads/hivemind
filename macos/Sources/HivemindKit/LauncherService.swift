import CryptoKit
import Foundation

/// The launcher channel is available only to the Server.app that owns the
/// current instance secret. No browser cookie or agent identity is used here.
public enum LauncherProof {
  public static func sign(_ request: inout URLRequest, secret: InstanceSecret, now: Date = Date(), nonce: InstanceNonce = .generate()) {
    let method = request.httpMethod ?? "GET"
    let url = request.url!
    let path = url.path + (url.query.map { "?" + $0 } ?? "")
    let timestamp = String(Int(now.timeIntervalSince1970))
    let bodyHash = Hex32.encode(SHA256.hash(data: request.httpBody ?? Data()))
    let message = "hivemind-launcher-v1\n\(method)\n\(path)\n\(timestamp)\n\(nonce.hex)\n\(bodyHash)"
    let signature = Hex32.encode(HMAC<SHA256>.authenticationCode(for: Data(message.utf8), using: secret.key))
    request.setValue(timestamp, forHTTPHeaderField: "X-Hivemind-Timestamp")
    request.setValue(nonce.hex, forHTTPHeaderField: "X-Hivemind-Nonce")
    request.setValue(signature, forHTTPHeaderField: "X-Hivemind-Signature")
  }
}

public protocol LauncherHTTP: Sendable {
  func send(_ request: URLRequest) async throws -> (status: Int, body: Data)
}

/// An ephemeral session never sends Human cookies to the launcher channel.
public struct URLSessionLauncherHTTP: LauncherHTTP {
  private let session: URLSession

  public init() {
    let config = URLSessionConfiguration.ephemeral
    config.httpCookieStorage = nil
    config.httpShouldSetCookies = false
    config.urlCache = nil
    config.requestCachePolicy = .reloadIgnoringLocalCacheData
    session = URLSession(configuration: config)
  }

  public func send(_ request: URLRequest) async throws -> (status: Int, body: Data) {
    let (body, response) = try await session.data(for: request)
    return ((response as? HTTPURLResponse)?.statusCode ?? 0, body)
  }
}

public struct LauncherCommand: Codable, Equatable, Sendable {
  public enum Kind: String, Codable, Sendable { case launch, kill }
  public let id: String
  public let kind: Kind
  public let requestId: String?
  public let templateId: String?
  public let project: String?
  public let agent: String?
  public let title: String?
  public let session: String
  public let cwd: String?
  public let command: String?
  public let environment: [String: String]?

  public init(id: String, kind: Kind, requestId: String? = nil, templateId: String? = nil,
              project: String? = nil, agent: String? = nil, title: String? = nil,
              session: String, cwd: String? = nil, command: String? = nil,
              environment: [String: String]? = nil) {
    self.id = id; self.kind = kind; self.requestId = requestId; self.templateId = templateId
    self.project = project; self.agent = agent; self.title = title; self.session = session
    self.cwd = cwd; self.command = command; self.environment = environment
  }

  public var digest: String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    return Hex32.encode(SHA256.hash(data: try! encoder.encode(self)))
  }
}

public struct LauncherResult: Codable, Equatable, Sendable {
  public enum Status: String, Codable, Sendable { case launched, failed, killed }
  public let status: Status
  public let session: String?
  public let error: String?

  public static func launched(_ session: SessionName) -> Self { .init(status: .launched, session: session.rawValue, error: nil) }
  public static let killed = Self(status: .killed, session: nil, error: nil)
  public static func failed(_ message: String) -> Self { .init(status: .failed, session: nil, error: String(message.prefix(500))) }
}

/// Persisted before a broker side effect. An intent without a result is never
/// executed a second time: it is reconciled against the tmux session first.
public struct LauncherJournalEntry: Codable, Equatable, Sendable {
  public let digest: String
  public let session: String
  public let kind: LauncherCommand.Kind
  public let result: LauncherResult?

  public init(digest: String, session: String, kind: LauncherCommand.Kind, result: LauncherResult? = nil) {
    self.digest = digest; self.session = session; self.kind = kind; self.result = result
  }
}

@MainActor public protocol LauncherJournaling {
  func read(_ id: String) throws -> LauncherJournalEntry?
  func write(_ entry: LauncherJournalEntry, id: String) throws
}

/// One private file per command, so a redelivery after either process
/// restarts still has its original intent/result. Command and environment
/// values are never persisted; only their SHA-256 digest is.
@MainActor public final class FileLauncherJournal: LauncherJournaling {
  public let folder: URL

  public init(folder: URL) { self.folder = folder }

  private func file(_ id: String) throws -> URL {
    guard UUID(uuidString: id) != nil else { throw BrokerFiles.Failure("invalid launcher command id") }
    return folder.appendingPathComponent(id.lowercased() + ".json")
  }

  public func read(_ id: String) throws -> LauncherJournalEntry? {
    let url = try file(id)
    guard FileManager.default.fileExists(atPath: url.path) else { return nil }
    return try JSONDecoder().decode(LauncherJournalEntry.self, from: Data(contentsOf: url))
  }

  public func write(_ entry: LauncherJournalEntry, id: String) throws {
    let url = try file(id)
    try BrokerFiles.preparePrivateFolder(folder)
    try BrokerFiles.writePrivately(JSONEncoder().encode(entry), to: url)
  }
}

@MainActor public protocol LauncherBrokering {
  func sessions() async throws -> [BrokerSession]
  func launch(_ launch: BrokerLaunch) async throws -> SessionName
  func kill(_ session: SessionName) async throws
}

public struct LauncherApproval: Decodable, Equatable, Sendable {
  public let id: String
  public let reason: String?
  public init(id: String, reason: String?) { self.id = id; self.reason = reason }
}

@MainActor public protocol LauncherApprovalNotifying: AnyObject {
  func notify(_ approval: LauncherApproval)
}

/// Performs exactly one queue command at a time, then acknowledges its saved
/// result. A failed acknowledgement is retried by the server's durable queue.
@MainActor public final class LauncherService {
  public struct Server: Equatable, Sendable {
    public let endpoint: ServerEndpoint
    public let secret: InstanceSecret
    public init(endpoint: ServerEndpoint, secret: InstanceSecret) { self.endpoint = endpoint; self.secret = secret }
  }

  private struct Next: Decodable { let command: LauncherCommand? }
  private let server: @MainActor () -> Server?
  private let http: any LauncherHTTP
  private let broker: any LauncherBrokering
  private let journal: any LauncherJournaling
  private let notifier: (any LauncherApprovalNotifying)?
  private let now: @Sendable () -> Date
  private var notifiedApprovals = Set<String>()
  private var loop: Task<Void, Never>?
  /// A replacement loop waits for the old one to finish any in-flight
  /// broker effect before it may reconcile the same durable command.
  private var draining: Task<Void, Never>?

  public init(server: @escaping @MainActor () -> Server?, http: any LauncherHTTP = URLSessionLauncherHTTP(),
              broker: any LauncherBrokering, journal: any LauncherJournaling,
              notifier: (any LauncherApprovalNotifying)? = nil,
              now: @escaping @Sendable () -> Date = Date.init) {
    self.server = server; self.http = http; self.broker = broker; self.journal = journal
    self.notifier = notifier; self.now = now
  }

  public func start() {
    guard loop == nil, server() != nil else { return }
    let previous = draining
    loop = Task { [weak self] in
      await previous?.value
      guard !Task.isCancelled else { return }
      await self?.run()
    }
  }
  public func stop() {
    loop?.cancel()
    if let loop { draining = loop }
    loop = nil
  }
  public func serverChanged() { stop(); if server() != nil { start() } }

  private func run() async {
    while !Task.isCancelled {
      do {
        try await pollOnce()
      } catch {
        // Network, proof and journal failures are transient. Never log a
        // command or an environment value in a generic error description.
        try? await Task.sleep(for: .seconds(2))
      }
    }
  }

  /// Exposed for fake HTTP/broker tests; a live run uses the same path.
  public func pollOnce() async throws {
    guard let current = server() else { return }
    guard await verify(current) else { throw BrokerFiles.Failure("launcher server verification failed") }
    if notifier != nil { try? await refreshApprovals(current) }
    try Task.checkCancellation()
    let path = "/api/launcher/next?timeoutMs=25000"
    let (status, data) = try await signed(current, method: "GET", path: path, body: nil, timeout: 30)
    guard status == 200 else { throw BrokerFiles.Failure("launcher poll HTTP \(status)") }
    guard let command = try JSONDecoder().decode(Next.self, from: data).command else { return }
    guard UUID(uuidString: command.id) != nil else { throw BrokerFiles.Failure("invalid launcher command id") }
    try Task.checkCancellation()
    guard server() == current, await verify(current) else { throw BrokerFiles.Failure("launcher server changed") }
    try Task.checkCancellation()
    let result = try await execute(command)
    guard server() == current, await verify(current) else { throw BrokerFiles.Failure("launcher server changed") }
    let body = try JSONEncoder().encode(result)
    let resultPath = "/api/launcher/\(command.id)/result"
    let (posted, _) = try await signed(current, method: "POST", path: resultPath, body: body, timeout: 5)
    guard posted == 200 else { throw BrokerFiles.Failure("launcher result HTTP \(posted)") }
  }

  private func refreshApprovals(_ current: Server) async throws {
    struct Response: Decodable { let requests: [LauncherApproval] }
    let (status, data) = try await signed(current, method: "GET", path: "/api/launcher/approvals", body: nil, timeout: 5)
    guard status == 200, server() == current, await verify(current) else { return }
    let requests = try JSONDecoder().decode(Response.self, from: data).requests
    guard !Task.isCancelled else { return }
    for approval in requests where UUID(uuidString: approval.id) != nil {
      if notifiedApprovals.insert(approval.id).inserted { notifier?.notify(approval) }
    }
  }

  /// Approve/reject comes only from the verified native bridge via the
  /// broker, including the iOS gateway. A browser has no signed endpoint.
  public func decide(requestId: String, templateId: TemplateID?, approve: Bool) async -> Result<Void, BrokerProtocolError> {
    guard UUID(uuidString: requestId) != nil, let current = server(), await verify(current) else {
      return .failure(.init(.unauthorized, "Hivemind Server is unavailable or unverified"))
    }
    let action = approve ? "approve" : "reject"
    let path = "/api/launcher/requests/\(requestId)/\(action)"
    do {
      let values: [String: String] = approve ? templateId.map { ["templateId": $0.rawValue] } ?? [:] : [:]
      let body = try JSONEncoder().encode(values)
      let (status, _) = try await signed(current, method: "POST", path: path, body: body, timeout: 5)
      guard server() == current else { return .failure(.init(.unauthorized, "Hivemind Server changed")) }
      guard (200..<300).contains(status) else { return .failure(.init(.internal, "Approval request failed (HTTP \(status))")) }
      return .success(())
    } catch {
      return .failure(.init(.internal, "Approval request could not be delivered"))
    }
  }

  private func verify(_ current: Server) async -> Bool {
    let nonce = InstanceNonce.generate()
    do {
      var request = URLRequest(url: current.endpoint.instanceURL(nonce: nonce), timeoutInterval: 3)
      request.httpMethod = "GET"
      let (status, data) = try await http.send(request)
      return InstanceVerifier.interpret(status: status, body: data, secret: current.secret,
                                        nonce: nonce, port: current.endpoint.port) == .verified && server() == current
    } catch { return false }
  }

  private func signed(_ current: Server, method: String, path: String, body: Data?, timeout: TimeInterval) async throws -> (Int, Data) {
    let url = URL(string: String(path.dropFirst()), relativeTo: current.endpoint.baseURL)!.absoluteURL
    var request = URLRequest(url: url, timeoutInterval: timeout)
    request.httpMethod = method
    request.httpBody = body
    if body != nil { request.setValue("application/json", forHTTPHeaderField: "Content-Type") }
    LauncherProof.sign(&request, secret: current.secret, now: now())
    let (status, data) = try await http.send(request)
    return (status, data)
  }

  public func execute(_ command: LauncherCommand) async throws -> LauncherResult {
    guard UUID(uuidString: command.id) != nil, let session = SessionName(command.session) else {
      return .failed("invalid launcher command id or session")
    }
    let digest = command.digest
    if let saved = try journal.read(command.id) {
      guard saved.digest == digest, saved.session == session.rawValue, saved.kind == command.kind else {
        return .failed("launcher command id was reused with different content")
      }
      if let result = saved.result { return result }
      let sessions = try await broker.sessions()
      let owner = sessions.first { $0.name == session }
      let exists = owner?.alive == true
      let result: LauncherResult
      switch command.kind {
      case .launch:
        result = exists && owner?.project == command.project && owner?.agent == command.agent
          ? .launched(session) : .failed("launch outcome uncertain after restart")
      case .kill: result = exists ? .failed("kill outcome uncertain after restart") : .killed
      }
      try journal.write(.init(digest: digest, session: session.rawValue, kind: command.kind, result: result), id: command.id)
      return result
    }
    let sessions = try await broker.sessions()
    let existing = sessions.first { $0.name == session }
    let result: LauncherResult
    if command.kind == .launch {
      guard let project = command.project, let agent = command.agent, let title = command.title,
            let cwd = command.cwd, let text = command.command,
            let template = command.templateId.flatMap(TemplateID.init),
            BrokerLaunch.isProjectSlug(project), SessionName(project: project, agent: agent) == session else {
        return .failed("invalid launcher launch fields")
      }
      if let existing {
        result = existing.alive && existing.project == project && existing.agent == agent
          ? .launched(session) : .failed("session exists but does not belong to this worker")
      } else {
        let launch: BrokerLaunch
        do {
          let environment = try command.environment.map { try LaunchEnvironment($0) }
          launch = try BrokerLaunch(project: project, agent: agent, title: title, cwd: cwd, command: text,
                                    session: session, environment: environment, template: template)
        } catch { return .failed("invalid launcher launch fields") }
        try Task.checkCancellation()
        try journal.write(.init(digest: digest, session: session.rawValue, kind: .launch), id: command.id)
        try Task.checkCancellation()
        do {
          let started = try await broker.launch(launch)
          result = started == session ? .launched(session) : .failed("broker returned a different session")
        } catch { result = .failed("broker launch failed") }
      }
    } else if existing == nil {
      result = .killed
    } else {
      try Task.checkCancellation()
      try journal.write(.init(digest: digest, session: session.rawValue, kind: .kill), id: command.id)
      try Task.checkCancellation()
      do { try await broker.kill(session); result = .killed }
      catch { result = .failed("broker kill failed") }
    }
    try journal.write(.init(digest: digest, session: session.rawValue, kind: command.kind, result: result), id: command.id)
    return result
  }
}
