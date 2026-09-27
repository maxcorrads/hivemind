import Foundation
import Testing
@testable import HivemindKit

// The Launch agent sheet's Environment variables (docs/terminal-broker.md#launch-environment): the same rules as the
// page (src/shared/launch-environment.vectors.json), redaction, the wire, the launch file and the session script.
// Files go under a temporary folder only; tmux, PTYs and sockets are fakes.

private let marker = "V4LUE_MARKER"
private let json = #"{"snapshot":false,"x":"\#(marker)"}"#
private let awkward = #"it's $HOME $(id) `id` "\#(marker)" 😀"#
private let atlas = SessionName("hm-acme-atlas")!

private func environment(_ values: [String: String] = ["OPENCODE_CONFIG_CONTENT": json, "OPENCODE_DISABLE_FFF": "1"]) -> LaunchEnvironment {
  try! LaunchEnvironment(values)
}

private struct Vectors: Decodable {
  let validNames: [String]
  let invalidNames: [String]
  let deniedNames: [String]
  let validValues: [String]
  let invalidValues: [String]
  let limits: [String: Int]

  static func load() throws -> Vectors {
    // macos/Tests/HivemindKitTests/ → the repository's src/shared/.
    let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().appendingPathComponent("src/shared/launch-environment.vectors.json")
    return try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
  }
}

private func mode(_ path: String) -> mode_t {
  var info = stat()
  _ = lstat(path, &info)
  return info.st_mode & 0o7777
}

private func described(_ value: Any) -> [String] {
  var dumped = ""
  dump(value, to: &dumped)
  return [String(describing: value), String(reflecting: value), dumped]
}

private func frameError(_ json: String) -> BrokerProtocolError? {
  do {
    _ = try BrokerRequestFrame.decode(Data(json.utf8))
    return nil
  } catch {
    return error
  }
}

struct LaunchEnvironmentRulesTests {
  @Test func followsTheSameRulesAsThePage() throws {
    let vectors = try Vectors.load()
    #expect(vectors.limits == ["variables": LaunchEnvironment.maxVariables, "nameChars": LaunchEnvironment.maxNameCharacters,
                               "valueBytes": LaunchEnvironment.maxValueBytes, "totalBytes": LaunchEnvironment.maxTotalBytes])
    for name in vectors.validNames {
      #expect(LaunchEnvironment.isValidName(name) && !LaunchEnvironment.isDenied(name), "\(name)")
      #expect(throws: Never.self, "\(name)") { try LaunchEnvironment([name: "v"]) }
    }
    for name in vectors.invalidNames {
      #expect(!LaunchEnvironment.isValidName(name), "\(name.debugDescription)")
      #expect(throws: BrokerProtocolError.self, "\(name.debugDescription)") { try LaunchEnvironment([name: "v"]) }
    }
    for name in vectors.deniedNames {
      #expect(LaunchEnvironment.isValidName(name) && LaunchEnvironment.isDenied(name), "\(name)")
      #expect(throws: BrokerProtocolError.self, "\(name)") { try LaunchEnvironment([name: "v"]) }
    }
    for value in vectors.validValues {
      #expect(LaunchEnvironment.isValidValue(value), "\(value.debugDescription)")
      #expect(try LaunchEnvironment(["A": value]).value("A") == value)
    }
    for value in vectors.invalidValues {
      #expect(!LaunchEnvironment.isValidValue(value), "\(value.debugDescription)")
      #expect(throws: BrokerProtocolError.self, "\(value.debugDescription)") { try LaunchEnvironment(["A": value]) }
    }
  }

  @Test func enforcesItsLimits() throws {
    let full = Dictionary(uniqueKeysWithValues: (1...32).map { ("V\($0)", "x") })
    #expect(try LaunchEnvironment(full).names.count == 32)
    #expect(throws: BrokerProtocolError.self) { try LaunchEnvironment(full.merging(["V33": "x"]) { a, _ in a }) }
    #expect(throws: Never.self) { try LaunchEnvironment(["A": String(repeating: "x", count: 8192)]) }
    #expect(throws: BrokerProtocolError.self) { try LaunchEnvironment(["A": String(repeating: "x", count: 8193)]) }
    // Bytes, not characters: 2,731 three-byte characters are 8,193 bytes.
    #expect(throws: BrokerProtocolError.self) { try LaunchEnvironment(["A": String(repeating: "日", count: 2731)]) }
    // In all: NAME=value bytes, at most 32 KiB. Four of "V1=" + 8,189 is 32,768.
    let exact = Dictionary(uniqueKeysWithValues: (1...4).map { ("V\($0)", String(repeating: "x", count: 8189)) })
    #expect(throws: Never.self) { try LaunchEnvironment(exact) }
    #expect(throws: BrokerProtocolError.self) { try LaunchEnvironment(exact.merging(["B": ""]) { a, _ in a }) }
    #expect(throws: BrokerProtocolError.self) { try LaunchEnvironment([:]) }
  }

  @Test func anErrorNeverQuotesTheValue() {
    let cases: [[String: String]] = [
      ["A": "\(marker)\n"], ["A": String(repeating: marker, count: 1000)], ["\(marker) x": "v"], ["1\(marker)": "v"],
      ["PATH": marker], ["HIVEMIND_X": marker], ["OPENCODE_API_KEY": marker],
    ]
    for values in cases {
      do {
        _ = try LaunchEnvironment(values)
        Issue.record("accepted \(values.keys.sorted())")
      } catch {
        #expect(error.code == .badMessage)
        #expect(!error.message.contains(marker), "\(error.message)")
      }
    }
  }

  @Test func noDescriptionOrDumpShowsAValue() throws {
    let launch = try BrokerLaunch(project: "acme", agent: "Atlas", title: "t", cwd: "/Users/me/acme", command: "opencode",
                                  environment: environment())
    let page = TerminalSessionLaunch(project: "acme", agent: "Atlas", title: "t", cwd: "~/acme", command: "opencode",
                                     environment: environment())!
    let values: [Any] = [
      environment(), launch, page, BrokerRequest.launch([launch]), BrokerRequestFrame(id: "l", .launch([launch])),
      BridgeMessage.terminalLaunch(id: "l", launches: [page], openInTerminal: false),
    ]
    for value in values {
      for text in described(value) { #expect(!text.contains(marker), "\(text)") }
    }
    #expect(environment().description == "LaunchEnvironment(OPENCODE_CONFIG_CONTENT: <redacted>, OPENCODE_DISABLE_FFF: <redacted>)")
  }
}

struct LaunchEnvironmentWireTests {
  @Test func aLaunchCarriesItsEnvironmentOverTheWire() throws {
    let launch = try BrokerLaunch(project: "acme", agent: "Atlas", title: "t", cwd: "/Users/me/acme", command: "opencode",
                                  environment: environment(["A": awkward]))
    let frame = BrokerRequestFrame(id: "l", .launch([launch, brokerLaunch(nil)]))
    let line = try frame.line()
    let decoded = try BrokerRequestFrame.decode(line.dropLast())
    #expect(decoded == frame)
    guard case .launch(let launches) = decoded.request else { Issue.record("not a launch"); return }
    #expect(launches[0].environment?.value("A") == awkward)
    #expect(launches[1].environment == nil)
    #expect(!String(decoding: try BrokerRequestFrame(.launch([brokerLaunch(nil)])).line(), as: UTF8.self).contains("environment"))
  }

  @Test func refusesABadEnvironmentWithoutEchoingIt() {
    let item = #"{"project":"acme","title":"t","cwd":"/Users/me/acme","command":"opencode","environment":%@}"#
    let cases = [
      #"{"PATH":"\#(marker)"}"#, #"{"path":"\#(marker)"}"#, #"{"HIVEMIND_TMUX_SESSION":"\#(marker)"}"#, #"{"DYLD_X":"\#(marker)"}"#,
      #"{"OPENCODE_API_KEY":"\#(marker)"}"#, #"{"1A":"\#(marker)"}"#, #"{}"#, #"{"A":"\#(marker)\n"}"#, #"{"A":"\#(marker)\r"}"#,
      #"{"A":"\#(marker)\u0000"}"#, #"{"A":"\#(String(repeating: "k", count: 8193))"}"#, #"{"A":7}"#, #"["\#(marker)"]"#, #""\#(marker)""#,
    ]
    for environment in cases {
      let error = frameError(#"{"type":"launch","launches":["# + String(format: item, environment) + "]}")
      #expect(error?.code == .badMessage, "\(environment)")
      #expect(error?.message.hasPrefix("launches[0].environment") == true, "\(error?.message ?? "")")
      #expect(error?.message.contains(marker) == false)
    }
    #expect(frameError(#"{"type":"launch","launches":["# + String(format: item, "null") + "]}") == nil)
  }

  @Test func thePageMayPassOnlyValidVariables() {
    func message(_ environment: Any) -> BridgeMessage? {
      BridgeMessage(body: ["type": "terminal-launch", "openInTerminal": false, "launches": [
        ["project": "acme", "agent": "Atlas", "title": "t", "cwd": "~/acme", "command": "opencode", "environment": environment],
      ]])
    }
    guard case .terminalLaunch(_, let launches, _)? = message(["OPENCODE_CONFIG_CONTENT": json, "OPENCODE_DISABLE_FFF": "1"]) else {
      Issue.record("dropped")
      return
    }
    #expect(launches[0].environment == environment())
    #expect(launches[0].brokerLaunch(home: "/Users/me")?.environment == environment(), "the app hands them to the broker")
    #expect(message(NSNull()) != nil)
    let bad: [Any] = [
      ["PATH": "/tmp"], ["TMUX": "x"], ["LD_PRELOAD": "x"], ["hivemind_x": "x"], ["A": "a\nb"], ["A": 1], [String: Any](),
      ["A": String(repeating: "k", count: 8193)], Dictionary(uniqueKeysWithValues: (1...33).map { ("V\($0)", "x") }), ["x"], "A=b",
    ]
    for environment in bad { #expect(message(environment) == nil, "\(type(of: environment))") }
  }
}

struct LaunchEnvironmentFileTests {
  let tmux = TmuxCommand(executable: "/opt/homebrew/bin/tmux", configPath: "/Users/me/Library/Application Support/Hivemind/tmux.conf")

  @Test func theFileHoldsOneLinePerVariableEnvironmentFirst() throws {
    let bytes = LaunchSecretStore.contents(environment: environment(["B": awkward, "A": "", "C": "  x  "]),
                                           secrets: try LaunchSecrets(["OPENCODE_API_KEY": "sk-go"]))
    #expect(String(decoding: bytes, as: UTF8.self) == "A=\nB=\(awkward)\nC=  x  \nOPENCODE_API_KEY=sk-go\n")
    #expect(LaunchSecretStore.contents(environment: nil, secrets: nil).isEmpty)
  }

  @Test func writesTheVariablesToAFresh0600File() throws {
    let paths = HivemindPaths(home: try temporaryHome())
    let store = LaunchSecretStore(folder: paths.launchSecrets)
    let file = store.file()
    try store.write(environment: environment(), secrets: nil, to: file)
    #expect(mode(paths.launchSecrets.path) == 0o700)
    #expect(mode(file.path) == 0o600)
    #expect(try String(contentsOfFile: file.path, encoding: .utf8) == "OPENCODE_CONFIG_CONTENT=\(json)\nOPENCODE_DISABLE_FFF=1\n")
    #expect(!file.path.contains(marker))
  }

  @Test func argvHoldsThePathNeverAValue() throws {
    let launch = try BrokerLaunch(project: "acme", agent: "Atlas", title: "t", cwd: "/Users/me/acme", command: "opencode",
                                  environment: environment(["A": awkward, "OPENCODE_CONFIG_CONTENT": json]))
    let file = LaunchEnvironmentFile(path: "/Users/me/Library/Application Support/Hivemind/launch-secrets/B.env")
    let arguments = tmux.newSession(TmuxNewSession(name: atlas, launch: launch, environmentFile: file))
    #expect(!arguments.contains { $0.contains(marker) || $0.contains("OPENCODE_CONFIG_CONTENT") })
    #expect(arguments.contains { $0.hasPrefix("if builtin test -r '\(file.path)'; then") })
    #expect(arguments.filter { $0 == "-e" }.count == 1, "the only -e is the session name")
    let script = TmuxCommand.script(cwd: "/Users/me/acme", command: "opencode", environmentFile: file)
    #expect(script.range(of: "/bin/rm -f -- '\(file.path)'")!.lowerBound < script.range(of: "cd -- ")!.lowerBound, "loaded before the cd")
  }

  @Test func theLargestLaunchWithEverythingStillFitsInOneTmuxCommand() throws {
    let wide = "😀"
    let full = Dictionary(uniqueKeysWithValues: (1...4).map { ("V\($0)", String(repeating: "x", count: 8189)) })
    let launch = try BrokerLaunch(
      project: String(repeating: "p", count: 32), agent: String(repeating: wide, count: BrokerLimits.maxAgentCharacters),
      title: String(repeating: wide, count: BrokerLimits.maxTitleCharacters),
      cwd: "/" + String(repeating: "'", count: BrokerLimits.maxCwdBytes - 1),
      command: String(repeating: "x", count: BrokerLimits.maxCommandBytes),
      secrets: try LaunchSecrets(["OPENCODE_API_KEY": String(repeating: "k", count: LaunchSecrets.maxValueBytes)]),
      environment: try LaunchEnvironment(full))
    let longest = TmuxCommand(executable: "/opt/homebrew/bin/tmux", configPath: "/" + String(repeating: "c", count: BrokerPaths.maxSocketPathBytes))
    // The folder sits next to the socket, whose path the broker keeps within 103 bytes.
    let folder = "/" + String(repeating: "s", count: BrokerPaths.maxSocketPathBytes) + "/launch-secrets"
    let file = LaunchSecretStore(folder: URL(fileURLWithPath: folder)).file()
    let name = BrokerLaunch.sessionNames(for: [launch], existing: []).first!
    let bytes = TmuxCommand.commandLineBytes(longest.newSession(TmuxNewSession(name: name, launch: launch, environmentFile: file)))
    #expect(bytes <= TmuxCommand.maxCommandLineBytes, "\(bytes)")
  }
}

@MainActor
struct BrokerLaunchEnvironmentTests {
  func harness() throws -> (BrokerHarness, LaunchSecretStore) {
    let h = BrokerHarness()
    let store = LaunchSecretStore(folder: HivemindPaths(home: try temporaryHome()).launchSecrets)
    h.secretStore = store
    return (h, store)
  }

  func files(_ store: LaunchSecretStore) -> [String] {
    ((try? FileManager.default.contentsOfDirectory(atPath: store.folder.path)) ?? []).map { store.folder.appendingPathComponent($0).path }
  }

  func openCode(_ agent: String? = "Atlas", secrets: LaunchSecrets? = nil) throws -> BrokerLaunch {
    try BrokerLaunch(project: "acme", agent: agent, title: "Acme - \(agent ?? "new")", cwd: "/Users/me/acme", command: "opencode",
                     secrets: secrets, environment: environment(["A": awkward, "OPENCODE_CONFIG_CONTENT": json]))
  }

  @Test func aNewSessionGetsItsVariablesAndTheSecretInOneFileNeverArgv() async throws {
    let (h, store) = try harness()
    await h.start()
    let (transport, connection) = await h.client()
    await h.send(connection, .launch([try openCode(secrets: try LaunchSecrets(["OPENCODE_API_KEY": "sk-go-\(marker)"])), brokerLaunch(nil)]),
                 id: "go")
    let names = [atlas, SessionName("hm-acme-new-1")!]
    #expect(transport.take().first == BrokerEventFrame(id: "go", .launched(names: names, created: names, errors: [])))
    let written = files(store)
    #expect(written.count == 1, "one file, for the launch that has variables")
    #expect(mode(written[0]) == 0o600)
    #expect(try String(contentsOfFile: written[0], encoding: .utf8)
      == "A=\(awkward)\nOPENCODE_CONFIG_CONTENT=\(json)\nOPENCODE_API_KEY=sk-go-\(marker)\n")
    let created = h.tmux.calls("new-session")
    #expect(!h.tmux.calls.joined().contains { $0.contains(marker) }, "no tmux argument holds a value")
    #expect(created[0].contains { $0.hasPrefix("if builtin test -r '\(written[0])'; then") })
    #expect(!created[1].contains { $0.contains("builtin test -r") })
    #expect(!h.tmux.environments.contains { $0.values.contains { $0.contains(marker) } }, "nor tmux's environment")
    #expect(!h.logs.joined().contains(marker))
    #expect(!String(decoding: transport.sent, as: UTF8.self).contains(marker), "nor any answer")
  }

  @Test func aReusedSessionIgnoresTheVariables() async throws {
    let (h, store) = try harness()
    h.tmux.add("hm-acme-atlas", agent: "Atlas")
    await h.start()
    let (transport, connection) = await h.client()
    await h.send(connection, .launch([try openCode()]))
    #expect(transport.events().first == .launched(names: [atlas], created: [], errors: []))
    #expect(h.tmux.calls("new-session").isEmpty)
    #expect(files(store).isEmpty, "nothing is written for a session that is not started")
  }

  @Test func aLaunchThatDoesNotStartLeavesNoFile() async throws {
    let (h, store) = try harness()
    await h.start()
    let (transport, connection) = await h.client()
    h.tmux.scripted["new-session"] = TmuxResult(status: 1, stderr: "create window failed: fork failed\n")
    await h.send(connection, .launch([try openCode()]))
    #expect(transport.events().first == .launched(
      names: [nil], created: [], errors: [BrokerLaunchFailure(index: 0, code: .tmuxFailed, message: "create window failed: fork failed")]))
    #expect(files(store).isEmpty)
  }

  @Test func withoutAStoreALaunchWithVariablesFailsAndRunsNothing() async throws {
    let h = BrokerHarness()
    await h.start()
    let (transport, connection) = await h.client()
    await h.send(connection, .launch([try openCode(), brokerLaunch(nil)]))
    #expect(transport.events().first == .launched(
      names: [nil, SessionName("hm-acme-new-1")!], created: [SessionName("hm-acme-new-1")!],
      errors: [BrokerLaunchFailure(index: 0, code: .internal, message: "launches[0].environment: this broker cannot pass environment variables")]))
    #expect(h.tmux.calls("new-session").count == 1)
  }
}
