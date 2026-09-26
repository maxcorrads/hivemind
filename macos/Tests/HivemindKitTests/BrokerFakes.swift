import Foundation
@testable import HivemindKit

// Fakes for the terminal broker's seams. Nothing here runs tmux, opens a
// PTY or touches a socket: FakeTmux keeps its sessions in a dictionary,
// FakeTerminal records what the broker asked of it, and FakeTransport
// collects the lines the broker sent.

/// A tmux server in memory, answering the argv TmuxCommand builds.
@MainActor
final class FakeTmux: TmuxRunning {
  struct Session {
    var created: Int
    var attached = 0
    var dead = false
    var project: String?
    var agent: String?
  }

  var serverRunning = false
  var sessions: [String: Session] = [:]
  /// Every call's arguments after the common `-u -L hivemind -f <conf>`.
  var calls: [[String]] = []
  var executables: [String] = []
  var environments: [[String: String]] = []
  /// Answers that replace the simulation, by subcommand.
  var scripted: [String: TmuxResult] = [:]
  var clock = 1_700_000_000
  /// Suspends every call this many times before answering, as a real child
  /// process would, so requests of two connections can interleave.
  var yields = 0

  nonisolated static let baseCount = 5

  func run(executable: String, arguments: [String], environment: [String: String]) async -> TmuxResult {
    for _ in 0..<yields { await Task.yield() }
    let args = Array(arguments.dropFirst(Self.baseCount))
    calls.append(args)
    executables.append(executable)
    environments.append(environment)
    guard let command = args.first else { return TmuxResult(status: 1, stderr: "usage") }
    if let answer = scripted[command] { return answer }
    switch command {
    case "list-sessions":
      guard serverRunning else { return TmuxResult(status: 1, stderr: "no server running on /private/tmp/tmux-501/hivemind\n") }
      let lines = sessions.sorted { $0.key < $1.key }.map { name, s in
        "\(name)|\(s.created)|\(s.attached)|\(s.dead ? 1 : 0)|\(s.project ?? "")|\(s.agent ?? "")"
      }
      return TmuxResult(status: 0, stdout: lines.joined(separator: "\n") + "\n")
    case "has-session":
      guard serverRunning else { return TmuxResult(status: 1, stderr: "no server running on /private/tmp/tmux-501/hivemind\n") }
      return sessions[target(args)] != nil ? TmuxResult(status: 0) : TmuxResult(status: 1, stderr: "can't find session: \(target(args))\n")
    case "new-session":
      let name = args[args.firstIndex(of: "-s")! + 1]
      if sessions[name] != nil { return TmuxResult(status: 1, stderr: "duplicate session: \(name)\n") }
      clock += 1
      serverRunning = true
      sessions[name] = Session(created: clock, project: option(args, "@hivemind_project"), agent: option(args, "@hivemind_agent"))
      return TmuxResult(status: 0)
    case "kill-session":
      guard serverRunning else { return TmuxResult(status: 1, stderr: "no server running on /private/tmp/tmux-501/hivemind\n") }
      guard sessions.removeValue(forKey: target(args)) != nil else {
        return TmuxResult(status: 1, stderr: "can't find session: \(target(args))\n")
      }
      return TmuxResult(status: 0)
    default:
      return TmuxResult(status: 1, stderr: "unknown command: \(command)\n")
    }
  }

  func calls(_ command: String) -> [[String]] { calls.filter { $0.first == command } }

  func add(_ name: String, project: String? = "acme", agent: String? = nil, attached: Int = 0) {
    serverRunning = true
    clock += 1
    sessions[name] = Session(created: clock, attached: attached, project: project, agent: agent)
  }

  private func target(_ args: [String]) -> String {
    String(args[args.firstIndex(of: "-t")! + 1].dropFirst())
  }

  private func option(_ args: [String], _ name: String) -> String? {
    args.firstIndex(of: name).map { args[$0 + 1] }
  }
}

@MainActor
final class FakeTerminal: BrokerTerminal {
  let spec: BrokerTerminalSpec
  let onOutput: @MainActor @Sendable (Data) -> Void
  let onExit: @MainActor @Sendable (Int?) -> Void
  var input: [Data] = []
  var sizes: [TerminalSize] = []
  var reading = true
  var readingChanges: [Bool] = []
  var terminated = 0
  var acceptsInput = true

  init(spec: BrokerTerminalSpec, onOutput: @escaping @MainActor @Sendable (Data) -> Void,
       onExit: @escaping @MainActor @Sendable (Int?) -> Void) {
    self.spec = spec
    self.onOutput = onOutput
    self.onExit = onExit
  }

  func write(_ data: Data) -> Bool {
    guard acceptsInput else { return false }
    input.append(data)
    return true
  }

  func resize(_ size: TerminalSize) { sizes.append(size) }

  func setReading(_ reading: Bool) {
    self.reading = reading
    readingChanges.append(reading)
  }

  func terminate() { terminated += 1 }

  func print(_ text: String) { onOutput(Data(text.utf8)) }
  func print(_ data: Data) { onOutput(data) }
  func exit(_ status: Int?) { onExit(status) }
}

struct SpawnFailure: Error, LocalizedError {
  var errorDescription: String? { "out of ptys" }
}

@MainActor
final class FakeSpawner: BrokerTerminalSpawning {
  var terminals: [FakeTerminal] = []
  var fail = false

  func spawn(
    _ spec: BrokerTerminalSpec,
    onOutput: @escaping @MainActor @Sendable (Data) -> Void,
    onExit: @escaping @MainActor @Sendable (Int?) -> Void
  ) throws -> any BrokerTerminal {
    if fail { throw SpawnFailure() }
    let terminal = FakeTerminal(spec: spec, onOutput: onOutput, onExit: onExit)
    terminals.append(terminal)
    return terminal
  }
}

@MainActor
final class FakeTransport: BrokerTransport {
  var sent = Data()
  var closed = 0
  private var read = 0

  func send(_ data: Data) { sent.append(data) }
  func close() { closed += 1 }

  var isClosed: Bool { closed > 0 }

  /// Every frame sent so far.
  var frames: [BrokerEventFrame] {
    sent.split(separator: UInt8(ascii: "\n")).map { try! BrokerEventFrame.decode(Data($0)) }
  }

  /// The frames sent since the last call.
  func take() -> [BrokerEventFrame] {
    let all = frames
    defer { read = all.count }
    return Array(all[read...])
  }

  func events() -> [BrokerEvent] { take().map(\.event) }
}

/// A broker over the fakes, with helpers to talk to it as a client would.
@MainActor
final class BrokerHarness {
  let scheduler = FakeScheduler()
  let tmux = FakeTmux()
  let spawner = FakeSpawner()
  let token = BrokerToken(String(repeating: "ab", count: 32))!
  var tmuxPath: String? = "/opt/homebrew/bin/tmux"
  var folders: Set<String> = ["/Users/me/acme", "/Users/me/beta"]
  var logs: [String] = []
  var changes = 0
  nonisolated static let config = "/Users/me/Library/Application Support/Hivemind/tmux.conf"
  nonisolated static let environment = ["PATH": "/usr/bin:/bin", "HOME": "/Users/me", "TMUX": "/private/tmp/tmux-501/default,1,0", "LANG": "it_IT.UTF-8"]

  lazy var broker: TerminalBroker = {
    let broker = TerminalBroker(
      token: token, configPath: Self.config,
      dependencies: .init(
        tmux: tmux, terminals: spawner, scheduler: scheduler,
        locateTmux: { [unowned self] in self.tmuxPath },
        isDirectory: { [unowned self] in self.folders.contains($0) },
        environment: Self.environment,
        log: { [unowned self] in self.logs.append($0) }))
    broker.onChange = { [unowned self] in self.changes += 1 }
    return broker
  }()

  func start() async {
    broker.start()
    await broker.settle()
  }

  func connect() -> (FakeTransport, BrokerConnection) {
    let transport = FakeTransport()
    return (transport, broker.accept(transport)!)
  }

  /// A connection that said hello; its welcome is already taken.
  func client() async -> (FakeTransport, BrokerConnection) {
    let (transport, connection) = connect()
    await send(connection, .hello(version: 1, token: token.value, client: "test"))
    _ = transport.take()
    return (transport, connection)
  }

  func send(_ connection: BrokerConnection, _ request: BrokerRequest, id: String? = nil) async {
    connection.received(try! BrokerRequestFrame(id: id, request).line())
    await broker.settle()
  }

  func sendRaw(_ connection: BrokerConnection, _ text: String) async {
    connection.received(Data(text.utf8))
    await broker.settle()
  }

  func advance(_ seconds: TimeInterval) async {
    scheduler.advance(seconds)
    await broker.settle()
  }

  /// Attaches to `session` and returns the stream id and its terminal.
  func attach(_ connection: BrokerConnection, _ transport: FakeTransport, _ session: String,
              cols: Int = 80, rows: Int = 24) async -> (BrokerStreamID, FakeTerminal)? {
    await send(connection, .attach(session: SessionName(session)!, size: TerminalSize(columns: cols, rows: rows)!))
    for event in transport.events() {
      if case .attached(let stream, _) = event { return (stream, spawner.terminals.last!) }
    }
    return nil
  }
}

func brokerLaunch(_ agent: String?, project: String = "acme", cwd: String = "/Users/me/acme",
            command: String = "claude") -> BrokerLaunch {
  try! BrokerLaunch(project: project, agent: agent, title: "\(project) - \(agent ?? "new")", cwd: cwd, command: command)
}
