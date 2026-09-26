import Foundation

// The terminal broker's wire protocol: newline-delimited JSON objects, one
// per line, each with a "type"; binary terminal data is base64. It is the
// same over every transport (a Unix socket now, TLS for an iOS client later),
// so nothing here knows how the bytes travel. docs/terminal-broker.md is the
// reference; keep the two in step.
//
// Every value is validated on decode, and a frame with anything off is
// refused as a whole with a BrokerProtocolError whose `code` goes back to the
// peer in an `error` message. Unknown keys are ignored, so a later minor
// addition does not break an older peer; an unknown "type" is an error.

public enum BrokerProtocol {
  /// The version this build speaks. A client sends the highest it speaks in
  /// `hello`; the broker answers with the one both will use.
  public static let version = 1
  /// The oldest version this build still accepts.
  public static let minimumVersion = 1

  /// The version to speak with a client that offered `clientVersion`, or nil
  /// when there is none (the broker then answers unsupported-version).
  public static func negotiate(clientVersion: Int) -> Int? {
    clientVersion >= minimumVersion ? min(clientVersion, version) : nil
  }
}

/// Limits both sides enforce. The broker is the authority; a client checks
/// them first only to give a better message.
public enum BrokerLimits {
  /// One client → broker line, newline excluded.
  public static let maxRequestBytes = 1 << 20
  /// One broker → client line, newline excluded.
  public static let maxEventBytes = 4 << 20
  /// Launches in one `launch` (the Launch agent sheet's own cap).
  public static let maxLaunches = 24
  public static let maxCommandBytes = 8 * 1024
  public static let maxCwdBytes = 1024
  public static let maxTitleCharacters = 200
  public static let maxAgentCharacters = 64
  public static let maxClientLabelCharacters = 64
  public static let maxRequestIDCharacters = 64
  /// Attached streams one connection may hold at once.
  public static let maxStreamsPerClient = 16
  /// Decoded bytes in one `input` (a paste is split by the client).
  public static let maxInputBytes = 64 * 1024
  /// Decoded bytes in one `output`; a larger batch is sent as several.
  public static let maxOutputBytes = 64 * 1024
  public static let columns = 2...1000
  public static let rows = 1...500
  /// Output read from a PTY is batched for this long before it is sent.
  public static let outputBatchInterval: TimeInterval = 0.016
  /// Stop reading a stream's PTY while the connection's unsent bytes exceed
  /// this; resume once they drop below `resumeOutboundBytes`.
  public static let maxOutboundBytes = 1 << 20
  public static let resumeOutboundBytes = 256 * 1024
  /// How often the broker runs `tmux list-sessions` to push changes.
  public static let sessionsPollInterval: TimeInterval = 2
  /// A connection that has not sent a valid `hello` by then is closed.
  public static let helloTimeout: TimeInterval = 5
  /// Connections the broker serves at once; more are closed on accept.
  public static let maxConnections = 32
}

/// Why a frame was refused. `code` is what goes on the wire.
public enum BrokerErrorCode: String, Codable, Sendable, CaseIterable {
  /// Not JSON, not an object, a missing or mistyped field, or a value out of range.
  case badMessage = "bad-message"
  /// A line longer than the limit; the connection is closed after this.
  case tooLarge = "too-large"
  case unknownType = "unknown-type"
  case unsupportedVersion = "unsupported-version"
  /// No valid `hello` yet, or a wrong token; the connection is closed after this.
  case unauthorized
  /// tmux was not found; `launch`, `attach` and `kill` cannot work.
  case tmuxMissing = "tmux-missing"
  case noSuchSession = "no-such-session"
  case noSuchStream = "no-such-stream"
  case tooManyStreams = "too-many-streams"
  /// A launch's folder does not exist or is not a directory.
  case cwdMissing = "cwd-missing"
  /// tmux ran and failed; the message carries its first stderr line.
  case tmuxFailed = "tmux-failed"
  case `internal`
}

public struct BrokerProtocolError: Error, Equatable, Sendable, LocalizedError {
  public let code: BrokerErrorCode
  public let message: String

  public init(_ code: BrokerErrorCode, _ message: String) {
    self.code = code
    self.message = message
  }

  static func invalid(_ field: String, _ reason: String) -> BrokerProtocolError {
    BrokerProtocolError(.badMessage, "\(field): \(reason)")
  }

  public var errorDescription: String? { message }

  /// Whether the broker closes the connection after sending this error.
  public var closesConnection: Bool { code == .tooLarge || code == .unauthorized || code == .unsupportedVersion }
}

// MARK: - Values

/// A stream id: which attached session an input, resize, output or exit is
/// about. The broker assigns them per connection, from 1, never reused on it.
public typealias BrokerStreamID = Int

public struct TerminalSize: Equatable, Hashable, Sendable {
  public let columns: Int
  public let rows: Int

  public init?(columns: Int, rows: Int) {
    guard BrokerLimits.columns.contains(columns), BrokerLimits.rows.contains(rows) else { return nil }
    self.columns = columns
    self.rows = rows
  }
}

/// One tmux session to start (or find running) for an agent.
public struct BrokerLaunch: Equatable, Sendable {
  /// The project slug, as Hivemind validates it: ^[a-z0-9][a-z0-9-]{0,31}$.
  public let project: String
  /// The agent's name; nil for a new agent the server has not named yet.
  public let agent: String?
  /// Window name in tmux and Terminal.app title, e.g. "Acme - Atlas".
  public let title: String
  /// Absolute folder the session starts in.
  public let cwd: String
  /// Shell text run by `/bin/zsh -lc`, as the Launch agent sheet builds it.
  public let command: String
  /// The session this agent last reported (agent.terminalSession), to reuse
  /// when it is still running: an agent first launched as hm-<p>-new-<n>
  /// keeps that session on "Resume same employees". Only a hint: the broker
  /// never creates a session under a name the client picked.
  public let session: SessionName?

  public init(project: String, agent: String?, title: String, cwd: String, command: String, session: SessionName? = nil) throws(BrokerProtocolError) {
    try self.init(project: project, agent: agent, title: title, cwd: cwd, command: command, session: session, field: "launch")
  }

  init(project: String, agent: String?, title: String, cwd: String, command: String, session: SessionName?, field: String) throws(BrokerProtocolError) {
    guard Self.isProjectSlug(project) else {
      throw .invalid("\(field).project", "must be a project slug (lowercase letters, digits and dashes, at most 32)")
    }
    if let agent {
      guard !agent.isEmpty, agent.count <= BrokerLimits.maxAgentCharacters else {
        throw .invalid("\(field).agent", "must be 1–\(BrokerLimits.maxAgentCharacters) characters")
      }
      guard !BrokerText.hasControlCharacters(agent) else { throw .invalid("\(field).agent", "must not contain control characters") }
      guard !agent.trimmingCharacters(in: .whitespaces).isEmpty else { throw .invalid("\(field).agent", "must not be blank") }
    }
    guard title.count <= BrokerLimits.maxTitleCharacters, !title.contains("\0") else {
      throw .invalid("\(field).title", "must be at most \(BrokerLimits.maxTitleCharacters) characters without NUL")
    }
    guard cwd.hasPrefix("/") else { throw .invalid("\(field).cwd", "must be an absolute path") }
    guard cwd.utf8.count <= BrokerLimits.maxCwdBytes else { throw .invalid("\(field).cwd", "must be at most \(BrokerLimits.maxCwdBytes) bytes") }
    guard !cwd.contains("\0") else { throw .invalid("\(field).cwd", "must not contain NUL") }
    guard !command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { throw .invalid("\(field).command", "must not be empty") }
    guard command.utf8.count <= BrokerLimits.maxCommandBytes else {
      throw .invalid("\(field).command", "must be at most \(BrokerLimits.maxCommandBytes) bytes")
    }
    guard !command.contains("\0") else { throw .invalid("\(field).command", "must not contain NUL") }
    self.project = project
    self.agent = agent
    self.title = title
    self.cwd = cwd
    self.command = command
    self.session = session
  }

  public static func isProjectSlug(_ value: String) -> Bool {
    let bytes = Array(value.utf8)
    guard (1...32).contains(bytes.count), let first = bytes.first, BrokerText.isLowerAlnum(first) else { return false }
    return bytes.allSatisfy { BrokerText.isLowerAlnum($0) || $0 == UInt8(ascii: "-") }
  }

  /// The session each launch goes to, in order. A launch whose `session`
  /// is running reuses it when that session was launched for the same
  /// project and for this agent or a new one (`reusable(_:)`). Otherwise a
  /// named agent always gets hm-<project>-<agent> (reused when it is
  /// running), and a new agent the first hm-<project>-new-<n> that is neither
  /// running nor given to an earlier launch of the same batch.
  public static func sessionNames(for launches: [BrokerLaunch], existing: some Sequence<BrokerSession>) -> [SessionName] {
    let running = Dictionary(existing.map { ($0.name, $0) }, uniquingKeysWith: { first, _ in first })
    var taken = Set(running.keys)
    return launches.map { launch in
      if let session = launch.session, let owner = running[session], launch.reusable(owner) { return session }
      let name = launch.agent.map { SessionName(project: launch.project, agent: $0) }
        ?? SessionName.newAgent(project: launch.project, existing: taken)
      taken.insert(name)
      return name
    }
  }

  /// Whether the `session` hint may name `owner`. The hint comes from the agent's own join (a label any agent can set),
  /// so it only reuses a session launched for the same project, and for no agent yet (hm-<project>-new-<n>) or for
  /// this one: resuming one agent never reports another agent's session, or another project's, as its own.
  func reusable(_ owner: BrokerSession) -> Bool {
    owner.project == project && (owner.agent == nil || owner.agent == agent)
  }
}

/// A session on the Hivemind tmux server, as `sessions` lists it.
public struct BrokerSession: Equatable, Sendable, Codable {
  public let name: SessionName
  /// The project slug and agent name recorded at launch (tmux user options
  /// @hivemind_project / @hivemind_agent); nil for a session the broker did
  /// not start or a new agent. Labels only: the page maps agents to sessions
  /// by the server's agent.terminalSession.
  public let project: String?
  public let agent: String?
  /// False when the session's active pane is dead.
  public let alive: Bool
  /// tmux clients attached (Terminal.app windows and broker streams alike).
  public let attached: Int
  /// Unix time in milliseconds, like every Hivemind timestamp.
  public let createdAt: Int64

  public init(name: SessionName, project: String?, agent: String?, alive: Bool, attached: Int, createdAt: Int64) {
    self.name = name
    self.project = project
    self.agent = agent
    self.alive = alive
    self.attached = attached
    self.createdAt = createdAt
  }
}

/// One launch that did not start, by its index in the `launch` message.
public struct BrokerLaunchFailure: Equatable, Sendable, Codable {
  public let index: Int
  public let code: BrokerErrorCode
  public let message: String

  public init(index: Int, code: BrokerErrorCode, message: String) {
    self.index = index
    self.code = code
    self.message = message
  }
}

// MARK: - Client → broker

public enum BrokerRequest: Equatable, Sendable {
  /// Must be the first message. `version` is the highest the client speaks;
  /// `token` the contents of broker.token; `client` a label for the log.
  case hello(version: Int, token: String, client: String?)
  /// Answered once with `sessions`.
  case sessionsList
  /// `sessions` now and after every change, until unsubscribed or closed.
  case sessionsSubscribe
  case sessionsUnsubscribe
  /// 1–24 launches; answered with `launched`.
  case launch([BrokerLaunch])
  /// Attach a new stream to a running session at this size; answered with
  /// `attached`, then `output` until `exit`.
  case attach(session: SessionName, size: TerminalSize)
  /// Bytes typed or pasted into a stream (1–64 KiB).
  case input(stream: BrokerStreamID, data: Data)
  case resize(stream: BrokerStreamID, size: TerminalSize)
  /// Close a stream; the session keeps running. Answered with `exit`.
  case detach(stream: BrokerStreamID)
  /// Kill a session and everything in it; answered with `killed`.
  case kill(session: SessionName)

  public var type: String {
    switch self {
    case .hello: "hello"
    case .sessionsList: "sessions.list"
    case .sessionsSubscribe: "sessions.subscribe"
    case .sessionsUnsubscribe: "sessions.unsubscribe"
    case .launch: "launch"
    case .attach: "attach"
    case .input: "input"
    case .resize: "resize"
    case .detach: "detach"
    case .kill: "kill"
    }
  }
}

/// A request plus the optional `id` the client picked; the broker echoes it
/// on the reply (or error) so the client can match them.
public struct BrokerRequestFrame: Equatable, Sendable {
  public let id: String?
  public let request: BrokerRequest

  public init(id: String? = nil, _ request: BrokerRequest) {
    self.id = id
    self.request = request
  }

  /// One line, without its newline. Everything the broker receives goes
  /// through here.
  public static func decode(_ line: Data) throws(BrokerProtocolError) -> BrokerRequestFrame {
    guard line.count <= BrokerLimits.maxRequestBytes else {
      throw BrokerProtocolError(.tooLarge, "a message must be at most \(BrokerLimits.maxRequestBytes) bytes")
    }
    return try BrokerCoding.decode(BrokerRequestFrame.self, from: line)
  }

  /// JSON plus the newline, ready to write.
  public func line() throws(BrokerProtocolError) -> Data {
    try BrokerCoding.line(self, limit: BrokerLimits.maxRequestBytes)
  }
}

extension BrokerRequestFrame: Codable {
  private enum Key: String, CodingKey {
    case type, id, version, token, client, launches, session, cols, rows, stream, data
    case project, agent, title, cwd, command
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: Key.self)
    let type = try BrokerCoding.string(c, .type)
    let id = try BrokerCoding.requestID(c, .id)
    let request: BrokerRequest
    switch type {
    case "hello":
      let version = try BrokerCoding.int(c, .version)
      let token = try BrokerCoding.string(c, .token)
      guard token.utf8.count <= 256 else { throw BrokerProtocolError.invalid("token", "is too long") }
      let client = try BrokerCoding.optionalString(c, .client)
      if let client {
        guard client.count <= BrokerLimits.maxClientLabelCharacters, !BrokerText.hasControlCharacters(client) else {
          throw BrokerProtocolError.invalid("client", "must be at most \(BrokerLimits.maxClientLabelCharacters) characters, no control characters")
        }
      }
      request = .hello(version: version, token: token, client: client)
    case "sessions.list": request = .sessionsList
    case "sessions.subscribe": request = .sessionsSubscribe
    case "sessions.unsubscribe": request = .sessionsUnsubscribe
    case "launch":
      var items: UnkeyedDecodingContainer
      do { items = try c.nestedUnkeyedContainer(forKey: .launches) } catch {
        throw BrokerProtocolError.invalid("launches", "must be an array")
      }
      guard let count = items.count, (1...BrokerLimits.maxLaunches).contains(count) else {
        throw BrokerProtocolError.invalid("launches", "must hold 1–\(BrokerLimits.maxLaunches) launches")
      }
      var launches: [BrokerLaunch] = []
      while !items.isAtEnd {
        let field = "launches[\(launches.count)]"
        let item: KeyedDecodingContainer<Key>
        do { item = try items.nestedContainer(keyedBy: Key.self) } catch {
          throw BrokerProtocolError.invalid(field, "must be an object")
        }
        launches.append(try BrokerLaunch(
          project: BrokerCoding.string(item, .project, field: "\(field).project"),
          agent: BrokerCoding.optionalString(item, .agent, field: "\(field).agent"),
          title: BrokerCoding.string(item, .title, field: "\(field).title"),
          cwd: BrokerCoding.string(item, .cwd, field: "\(field).cwd"),
          command: BrokerCoding.string(item, .command, field: "\(field).command"),
          session: BrokerCoding.optionalSession(item, .session, field: "\(field).session"),
          field: field))
      }
      request = .launch(launches)
    case "attach":
      request = .attach(session: try BrokerCoding.session(c, .session), size: try BrokerCoding.size(c, cols: .cols, rows: .rows))
    case "input":
      let data = try BrokerCoding.data(c, .data)
      guard !data.isEmpty, data.count <= BrokerLimits.maxInputBytes else {
        throw BrokerProtocolError.invalid("data", "must be 1–\(BrokerLimits.maxInputBytes) bytes")
      }
      request = .input(stream: try BrokerCoding.stream(c, .stream), data: data)
    case "resize":
      request = .resize(stream: try BrokerCoding.stream(c, .stream), size: try BrokerCoding.size(c, cols: .cols, rows: .rows))
    case "detach":
      request = .detach(stream: try BrokerCoding.stream(c, .stream))
    case "kill":
      request = .kill(session: try BrokerCoding.session(c, .session))
    default:
      throw BrokerProtocolError(.unknownType, "unknown message type \(BrokerText.quoted(type))")
    }
    self.init(id: id, request)
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: Key.self)
    try c.encode(request.type, forKey: .type)
    try c.encodeIfPresent(id, forKey: .id)
    switch request {
    case .hello(let version, let token, let client):
      try c.encode(version, forKey: .version)
      try c.encode(token, forKey: .token)
      try c.encodeIfPresent(client, forKey: .client)
    case .sessionsList, .sessionsSubscribe, .sessionsUnsubscribe:
      break
    case .launch(let launches):
      var items = c.nestedUnkeyedContainer(forKey: .launches)
      for launch in launches {
        var item = items.nestedContainer(keyedBy: Key.self)
        try item.encode(launch.project, forKey: .project)
        try item.encodeIfPresent(launch.agent, forKey: .agent)
        try item.encode(launch.title, forKey: .title)
        try item.encode(launch.cwd, forKey: .cwd)
        try item.encode(launch.command, forKey: .command)
        try item.encodeIfPresent(launch.session, forKey: .session)
      }
    case .attach(let session, let size):
      try c.encode(session, forKey: .session)
      try c.encode(size.columns, forKey: .cols)
      try c.encode(size.rows, forKey: .rows)
    case .input(let stream, let data):
      try c.encode(stream, forKey: .stream)
      try c.encode(data, forKey: .data)
    case .resize(let stream, let size):
      try c.encode(stream, forKey: .stream)
      try c.encode(size.columns, forKey: .cols)
      try c.encode(size.rows, forKey: .rows)
    case .detach(let stream):
      try c.encode(stream, forKey: .stream)
    case .kill(let session):
      try c.encode(session, forKey: .session)
    }
  }
}

// MARK: - Broker → client

public enum BrokerEvent: Equatable, Sendable {
  /// The answer to a good `hello`. `tmuxPath` is nil when tmux is not
  /// installed: the client then offers "Install tmux: brew install tmux".
  case welcome(version: Int, tmuxPath: String?)
  /// Every hm-* session, sorted by name. Sent for `sessions.list`, on
  /// `sessions.subscribe` and whenever the list changes while subscribed.
  case sessions([BrokerSession])
  /// One entry per launch, in order: its session, or nil when it failed
  /// (the failure is in `errors`). `created` lists the sessions this launch
  /// started; the others were already running and are reused.
  case launched(names: [SessionName?], created: [SessionName], errors: [BrokerLaunchFailure])
  case attached(stream: BrokerStreamID, session: SessionName)
  /// Bytes the terminal printed, in order, 1–64 KiB each.
  case output(stream: BrokerStreamID, data: Data)
  /// The stream is over: detached, the session ended, or its tmux client
  /// exited. `status` is the attach process's exit status when there was one.
  case exit(stream: BrokerStreamID, status: Int?)
  case killed(session: SessionName)
  /// `stream` is set when the error is about one stream.
  case error(code: BrokerErrorCode, message: String, stream: BrokerStreamID?)

  public var type: String {
    switch self {
    case .welcome: "welcome"
    case .sessions: "sessions"
    case .launched: "launched"
    case .attached: "attached"
    case .output: "output"
    case .exit: "exit"
    case .killed: "killed"
    case .error: "error"
    }
  }

  public static func error(_ error: BrokerProtocolError, stream: BrokerStreamID? = nil) -> BrokerEvent {
    .error(code: error.code, message: error.message, stream: stream)
  }
}

public struct BrokerEventFrame: Equatable, Sendable {
  /// The `id` of the request this answers; nil for a pushed event.
  public let id: String?
  public let event: BrokerEvent

  public init(id: String? = nil, _ event: BrokerEvent) {
    self.id = id
    self.event = event
  }

  /// One line, without its newline. Everything a client receives goes through here.
  public static func decode(_ line: Data) throws(BrokerProtocolError) -> BrokerEventFrame {
    guard line.count <= BrokerLimits.maxEventBytes else {
      throw BrokerProtocolError(.tooLarge, "a message must be at most \(BrokerLimits.maxEventBytes) bytes")
    }
    return try BrokerCoding.decode(BrokerEventFrame.self, from: line)
  }

  public func line() throws(BrokerProtocolError) -> Data {
    try BrokerCoding.line(self, limit: BrokerLimits.maxEventBytes)
  }
}

extension BrokerEventFrame: Codable {
  private enum Key: String, CodingKey {
    case type, id, version, tmuxPath, items, names, created, errors, stream, session, data, status, code, message
  }

  public init(from decoder: any Decoder) throws {
    let c = try decoder.container(keyedBy: Key.self)
    let type = try BrokerCoding.string(c, .type)
    let id = try BrokerCoding.requestID(c, .id)
    let event: BrokerEvent
    switch type {
    case "welcome":
      event = .welcome(version: try BrokerCoding.int(c, .version), tmuxPath: try BrokerCoding.optionalString(c, .tmuxPath))
    case "sessions":
      do { event = .sessions(try c.decode([BrokerSession].self, forKey: .items)) } catch {
        throw BrokerProtocolError.invalid("items", "must be a list of sessions")
      }
    case "launched":
      do {
        event = .launched(
          names: try c.decode([SessionName?].self, forKey: .names),
          created: try c.decode([SessionName].self, forKey: .created),
          errors: try c.decode([BrokerLaunchFailure].self, forKey: .errors))
      } catch {
        throw BrokerProtocolError.invalid("launched", "needs names, created and errors")
      }
    case "attached":
      event = .attached(stream: try BrokerCoding.stream(c, .stream), session: try BrokerCoding.session(c, .session))
    case "output":
      let data = try BrokerCoding.data(c, .data)
      guard !data.isEmpty, data.count <= BrokerLimits.maxOutputBytes else {
        throw BrokerProtocolError.invalid("data", "must be 1–\(BrokerLimits.maxOutputBytes) bytes")
      }
      event = .output(stream: try BrokerCoding.stream(c, .stream), data: data)
    case "exit":
      event = .exit(stream: try BrokerCoding.stream(c, .stream), status: try BrokerCoding.optionalInt(c, .status))
    case "killed":
      event = .killed(session: try BrokerCoding.session(c, .session))
    case "error":
      let code: BrokerErrorCode
      do { code = try c.decode(BrokerErrorCode.self, forKey: .code) } catch {
        // A newer broker's code still reads as an error.
        code = .internal
      }
      let stream = try c.decodeIfPresent(BrokerStreamID.self, forKey: .stream)
      event = .error(code: code, message: String(try BrokerCoding.string(c, .message).prefix(1000)), stream: stream)
    default:
      throw BrokerProtocolError(.unknownType, "unknown message type \(BrokerText.quoted(type))")
    }
    self.init(id: id, event)
  }

  public func encode(to encoder: any Encoder) throws {
    var c = encoder.container(keyedBy: Key.self)
    try c.encode(event.type, forKey: .type)
    try c.encodeIfPresent(id, forKey: .id)
    switch event {
    case .welcome(let version, let tmuxPath):
      try c.encode(version, forKey: .version)
      // Always present, null when missing, so a client can tell "no tmux" from an old broker.
      try c.encode(tmuxPath, forKey: .tmuxPath)
    case .sessions(let items):
      try c.encode(items, forKey: .items)
    case .launched(let names, let created, let errors):
      try c.encode(names, forKey: .names)
      try c.encode(created, forKey: .created)
      try c.encode(errors, forKey: .errors)
    case .attached(let stream, let session):
      try c.encode(stream, forKey: .stream)
      try c.encode(session, forKey: .session)
    case .output(let stream, let data):
      try c.encode(stream, forKey: .stream)
      try c.encode(data, forKey: .data)
    case .exit(let stream, let status):
      try c.encode(stream, forKey: .stream)
      try c.encode(status, forKey: .status)
    case .killed(let session):
      try c.encode(session, forKey: .session)
    case .error(let code, let message, let stream):
      try c.encode(code, forKey: .code)
      try c.encode(message, forKey: .message)
      try c.encodeIfPresent(stream, forKey: .stream)
    }
  }
}

// MARK: - Framing

/// Splits a byte stream into lines, refusing any line over `limit` before it
/// is all buffered. Blank lines are skipped. Transport-agnostic: feed it
/// whatever a socket read returned.
public struct BrokerLineReader: Sendable {
  public let limit: Int
  private var pending: [UInt8] = []

  public init(limit: Int) {
    self.limit = limit
  }

  /// The complete lines in `bytes` (plus what was pending), without their
  /// newlines. Throws too-large once a line cannot fit; the reader is then
  /// unusable and the connection should close.
  public mutating func append(_ bytes: some Sequence<UInt8>) throws(BrokerProtocolError) -> [Data] {
    var lines: [Data] = []
    for byte in bytes {
      if byte == UInt8(ascii: "\n") {
        if !pending.isEmpty { lines.append(Data(pending)) }
        pending.removeAll(keepingCapacity: true)
      } else {
        guard pending.count < limit else {
          pending.removeAll()
          throw BrokerProtocolError(.tooLarge, "a message must be at most \(limit) bytes")
        }
        pending.append(byte)
      }
    }
    return lines
  }

  /// Bytes of a line not yet ended.
  public var pendingCount: Int { pending.count }
}

// MARK: - Helpers

enum BrokerCoding {
  static func decode<T: Decodable>(_ type: T.Type, from line: Data) throws(BrokerProtocolError) -> T {
    do {
      return try JSONDecoder().decode(T.self, from: line)
    } catch let error as BrokerProtocolError {
      throw error
    } catch let DecodingError.keyNotFound(key, context) {
      throw .invalid(path(context.codingPath + [key]), "is missing")
    } catch let DecodingError.typeMismatch(_, context) where !context.codingPath.isEmpty {
      throw .invalid(path(context.codingPath), "has the wrong type")
    } catch let DecodingError.valueNotFound(_, context) {
      throw .invalid(path(context.codingPath), "must not be null")
    } catch let DecodingError.dataCorrupted(context) where !context.codingPath.isEmpty {
      throw .invalid(path(context.codingPath), context.debugDescription)
    } catch {
      throw BrokerProtocolError(.badMessage, "a message must be one JSON object")
    }
  }

  static func line<T: Encodable>(_ value: T, limit: Int) throws(BrokerProtocolError) -> Data {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    let data: Data
    do { data = try encoder.encode(value) } catch {
      throw BrokerProtocolError(.internal, "cannot encode: \(error.localizedDescription)")
    }
    guard data.count <= limit else { throw BrokerProtocolError(.tooLarge, "a message must be at most \(limit) bytes") }
    return data + Data([UInt8(ascii: "\n")])
  }

  static func path(_ keys: [any CodingKey]) -> String {
    keys.reduce("") { out, key in
      if let index = key.intValue { return out + "[\(index)]" }
      return out.isEmpty ? key.stringValue : out + "." + key.stringValue
    }
  }

  static func string<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ key: K, field: String? = nil) throws(BrokerProtocolError) -> String {
    guard let value = try? c.decodeIfPresent(String.self, forKey: key) else {
      throw c.contains(key) ? .invalid(field ?? key.stringValue, "must be a string") : .invalid(field ?? key.stringValue, "is missing")
    }
    return value
  }

  /// Missing and null both read as nil; any other non-string is an error.
  static func optionalString<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ key: K, field: String? = nil) throws(BrokerProtocolError) -> String? {
    do { return try c.decodeIfPresent(String.self, forKey: key) } catch {
      throw .invalid(field ?? key.stringValue, "must be a string or null")
    }
  }

  /// An integer, not a bool or a fraction.
  static func int<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ key: K) throws(BrokerProtocolError) -> Int {
    guard c.contains(key) else { throw .invalid(key.stringValue, "is missing") }
    guard let value = try? optionalInt(c, key) else { throw .invalid(key.stringValue, "must be an integer") }
    return value
  }

  static func optionalInt<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ key: K) throws(BrokerProtocolError) -> Int? {
    if (try? c.decodeNil(forKey: key)) ?? true { return nil }
    // JSONDecoder reads true as 1 for Int; refuse a bool explicitly.
    if (try? c.decode(Bool.self, forKey: key)) != nil { throw .invalid(key.stringValue, "must be an integer") }
    guard let value = try? c.decode(Int.self, forKey: key) else { throw .invalid(key.stringValue, "must be an integer") }
    return value
  }

  static func requestID<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ key: K) throws(BrokerProtocolError) -> String? {
    guard let id = try optionalString(c, key) else { return nil }
    guard (1...BrokerLimits.maxRequestIDCharacters).contains(id.count), !BrokerText.hasControlCharacters(id) else {
      throw .invalid("id", "must be 1–\(BrokerLimits.maxRequestIDCharacters) characters, no control characters")
    }
    return id
  }

  static func session<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ key: K) throws(BrokerProtocolError) -> SessionName {
    guard let name = SessionName(try string(c, key)) else {
      throw .invalid(key.stringValue, "must match \(SessionName.pattern)")
    }
    return name
  }

  /// Missing or null: nil. Anything else must be a session name.
  static func optionalSession<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ key: K, field: String) throws(BrokerProtocolError) -> SessionName? {
    guard let value = try optionalString(c, key, field: field) else { return nil }
    guard let name = SessionName(value) else { throw .invalid(field, "must match \(SessionName.pattern)") }
    return name
  }

  static func stream<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ key: K) throws(BrokerProtocolError) -> BrokerStreamID {
    let value = try int(c, key)
    guard value >= 1, value <= Int(Int32.max) else { throw .invalid(key.stringValue, "must be a positive stream id") }
    return value
  }

  static func size<K: CodingKey>(_ c: KeyedDecodingContainer<K>, cols: K, rows: K) throws(BrokerProtocolError) -> TerminalSize {
    let columns = try int(c, cols)
    let lines = try int(c, rows)
    guard let size = TerminalSize(columns: columns, rows: lines) else {
      throw .invalid("cols/rows", "must be \(BrokerLimits.columns.lowerBound)–\(BrokerLimits.columns.upperBound) × \(BrokerLimits.rows.lowerBound)–\(BrokerLimits.rows.upperBound)")
    }
    return size
  }

  /// Standard base64 (JSONEncoder's own encoding for Data).
  static func data<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ key: K) throws(BrokerProtocolError) -> Data {
    let text = try string(c, key)
    guard let data = Data(base64Encoded: text) else { throw .invalid(key.stringValue, "must be base64") }
    return data
  }
}

enum BrokerText {
  static func isLowerAlnum(_ byte: UInt8) -> Bool {
    (UInt8(ascii: "a")...UInt8(ascii: "z")).contains(byte) || (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(byte)
  }

  static func hasControlCharacters(_ text: String) -> Bool {
    text.unicodeScalars.contains { CharacterSet.controlCharacters.contains($0) || CharacterSet.newlines.contains($0) }
  }

  /// A peer's value in an error message: quoted, cut, one line.
  static func quoted(_ value: String) -> String {
    let cut = value.count > 40 ? String(value.prefix(40)) + "…" : value
    return "\"" + String(String.UnicodeScalarView(cut.unicodeScalars.map { hasControlCharacters(String($0)) ? "?" : $0 })) + "\""
  }
}
