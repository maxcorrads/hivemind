import Foundation
import Testing
@testable import HivemindKit

// Launch secrets (OPENCODE_API_KEY from the Launch agent sheet): validation,
// redaction, the wire, the session script and the broker's private files.
// Files go under a temporary folder only; tmux, PTYs and sockets are fakes.

private let key = "sk-go-TEST_s3cr3t_VALUE"
private let atlas = SessionName("hm-acme-atlas")!

private func secrets(_ value: String = key) -> LaunchSecrets {
  try! LaunchSecrets(["OPENCODE_API_KEY": value])
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

struct LaunchSecretsTests {
  @Test func takesOnlyTheAllowlistedNameWithAPrintableValue() throws {
    #expect(LaunchSecrets.allowedNames == ["OPENCODE_API_KEY"])
    #expect(secrets().value("OPENCODE_API_KEY") == key)
    #expect(secrets().names == ["OPENCODE_API_KEY"])
    #expect(throws: Never.self) { try LaunchSecrets(["OPENCODE_API_KEY": String(repeating: "k", count: 512)]) }
    #expect(throws: Never.self) { try LaunchSecrets(["OPENCODE_API_KEY": "!~#$%&'()*+,-./:;<=>?@[\\]^_`{|}\""]) }
    let bad = ["", String(repeating: "k", count: 513), "sk go", "sk\tgo", "sk\ngo", "sk\rgo", "sk\0go", "skè", "sk\u{7F}", " sk", "sk\u{2028}"]
    for value in bad {
      #expect(throws: BrokerProtocolError.self, "\(value.debugDescription)") { try LaunchSecrets(["OPENCODE_API_KEY": value]) }
      #expect(!LaunchSecrets.isValidValue(value))
    }
    #expect(throws: BrokerProtocolError.self) { try LaunchSecrets([:]) }
    #expect(throws: BrokerProtocolError.self) { try LaunchSecrets(["PATH": "/tmp"]) }
    #expect(throws: BrokerProtocolError.self) { try LaunchSecrets(["OPENCODE_API_KEY": key, "ANTHROPIC_API_KEY": key]) }
    #expect(throws: BrokerProtocolError.self) { try LaunchSecrets(["opencode_api_key": key]) }
  }

  @Test func anErrorNeverQuotesTheValue() {
    for value in ["\(key) with space", "\(key)\n", String(repeating: key, count: 40)] {
      do {
        _ = try LaunchSecrets(["OPENCODE_API_KEY": value])
        Issue.record("accepted \(value.count) characters")
      } catch {
        #expect(error.code == .badMessage)
        #expect(!error.message.contains(key))
      }
    }
  }

  @Test func noDescriptionOrDumpShowsTheValue() throws {
    let launch = try BrokerLaunch(project: "acme", agent: "Atlas", title: "t", cwd: "/Users/me/acme", command: "opencode", secrets: secrets())
    let page = TerminalSessionLaunch(project: "acme", agent: "Atlas", title: "t", cwd: "~/acme", command: "opencode", secrets: secrets())!
    let values: [Any] = [
      secrets(), launch, page, BrokerRequest.launch([launch]), BrokerRequestFrame(id: "l", .launch([launch])),
      BridgeMessage.terminalLaunch(id: "l", launches: [page], openInTerminal: false),
    ]
    for value in values {
      for text in described(value) {
        #expect(!text.contains(key), "\(text)")
      }
    }
    #expect(secrets().description == "LaunchSecrets(OPENCODE_API_KEY: <redacted>)")
    #expect(described(launch)[0].contains("<redacted>"))
  }
}

struct LaunchSecretsWireTests {
  @Test func aLaunchCarriesItsSecretsOverTheWire() throws {
    let launch = try BrokerLaunch(project: "acme", agent: "Atlas", title: "t", cwd: "/Users/me/acme", command: "opencode", secrets: secrets())
    let frame = BrokerRequestFrame(id: "l", .launch([launch, brokerLaunch(nil)]))
    let line = try frame.line()
    #expect(String(decoding: line, as: UTF8.self).contains(#""secrets":{"OPENCODE_API_KEY":"\#(key)"}"#))
    let decoded = try BrokerRequestFrame.decode(line.dropLast())
    #expect(decoded == frame)
    guard case .launch(let launches) = decoded.request else { Issue.record("not a launch"); return }
    #expect(launches[0].secrets?.value("OPENCODE_API_KEY") == key)
    #expect(launches[1].secrets == nil)
    // A launch without secrets sends no key at all, as before.
    #expect(!String(decoding: try BrokerRequestFrame(.launch([brokerLaunch(nil)])).line(), as: UTF8.self).contains("secrets"))
  }

  @Test func refusesAnyOtherSecretWithoutEchoingIt() {
    let item = #"{"project":"acme","title":"t","cwd":"/Users/me/acme","command":"opencode","secrets":%@}"#
    let cases = [
      #"{"OPENCODE_API_KEY":"\#(key)","AWS_SECRET_ACCESS_KEY":"\#(key)"}"#,
      #"{"PATH":"\#(key)"}"#,
      #"{}"#,
      #"{"OPENCODE_API_KEY":"\#(key) x"}"#,
      #"{"OPENCODE_API_KEY":"\#(key)\n"}"#,
      #"{"OPENCODE_API_KEY":"\#(key)\u0000"}"#,
      #"{"OPENCODE_API_KEY":"\#(String(repeating: "k", count: 513))"}"#,
      #"{"OPENCODE_API_KEY":7}"#,
      #"["\#(key)"]"#,
      #""\#(key)""#,
    ]
    for secrets in cases {
      let json = #"{"type":"launch","launches":["# + String(format: item, secrets) + "]}"
      let error = frameError(json)
      #expect(error?.code == .badMessage, "\(secrets)")
      #expect(error?.message.hasPrefix("launches[0].secrets") == true, "\(error?.message ?? "")")
      #expect(error?.message.contains(key) == false)
    }
    #expect(frameError(#"{"type":"launch","launches":["# + String(format: item, "null") + "]}") == nil)
  }

  @Test func thePageMayPassOnlyTheAllowlistedSecret() {
    func message(_ secrets: Any) -> BridgeMessage? {
      BridgeMessage(body: ["type": "terminal-launch", "openInTerminal": false, "launches": [
        ["project": "acme", "agent": "Atlas", "title": "t", "cwd": "~/acme", "command": "opencode", "secrets": secrets],
      ]])
    }
    guard case .terminalLaunch(_, let launches, _)? = message(["OPENCODE_API_KEY": key]) else { Issue.record("dropped"); return }
    #expect(launches[0].secrets == secrets())
    #expect(launches[0].brokerLaunch(home: "/Users/me")?.secrets == secrets(), "the app hands them to the broker")
    #expect(message(NSNull()) != nil)
    let bad: [Any] = [
      ["OPENCODE_API_KEY": key, "OTHER": key], ["OTHER": key], [String: Any](), ["OPENCODE_API_KEY": 1],
      ["OPENCODE_API_KEY": "a b"], ["OPENCODE_API_KEY": String(repeating: "k", count: 513)], [key], key,
    ]
    for secrets in bad { #expect(message(secrets) == nil, "\(type(of: secrets))") }
  }
}

struct LaunchSecretsScriptTests {
  let tmux = TmuxCommand(executable: "/opt/homebrew/bin/tmux", configPath: "/Users/me/Library/Application Support/Hivemind/tmux.conf")
  let file = LaunchSecretFile(name: "OPENCODE_API_KEY", path: "/Users/me/Library/Application Support/Hivemind/launch-secrets/A.secret")

  @Test func theScriptReadsTheFileIntoTheVariableAndDeletesItBeforeAnythingElse() {
    let script = TmuxCommand.script(cwd: "/Users/me/acme", command: "opencode\n", secretFiles: [file])
    let quoted = "'/Users/me/Library/Application Support/Hivemind/launch-secrets/A.secret'"
    #expect(script == """
      if OPENCODE_API_KEY="$(/bin/cat -- \(quoted) 2>/dev/null)" && [ -n "$OPENCODE_API_KEY" ]; then export OPENCODE_API_KEY; \
      else unset OPENCODE_API_KEY; fi; /bin/rm -f -- \(quoted)
      cd -- '/Users/me/acme' || exit 1
      opencode

      exec /bin/zsh -l
      """)
    // Without secrets the script is what it always was.
    #expect(TmuxCommand.script(cwd: "/Users/me/acme", command: "opencode") == "cd -- '/Users/me/acme' || exit 1\nopencode\n\nexec /bin/zsh -l")
    // A name off the allowlist never reaches the script.
    #expect(!TmuxCommand.script(cwd: "/x", command: "c", secretFiles: [LaunchSecretFile(name: "X;id", path: "/p")]).contains("X;id"))
  }

  @Test func argvHoldsThePathNeverTheValue() throws {
    let launch = try BrokerLaunch(project: "acme", agent: "Atlas", title: "t", cwd: "/Users/me/acme", command: "opencode", secrets: secrets())
    let arguments = tmux.newSession(TmuxNewSession(name: atlas, launch: launch, secretFiles: [file]))
    #expect(!arguments.contains { $0.contains(key) })
    #expect(arguments.contains { $0.contains(file.path) })
    // Not in tmux's session environment either: the only -e is the session name.
    #expect(arguments.filter { $0 == "-e" }.count == 1)
    #expect(!arguments.contains { $0.hasPrefix("OPENCODE_API_KEY=") })
  }

  @Test func theLargestLaunchWithASecretStillFitsInOneTmuxCommand() throws {
    let wide = "😀"
    let launch = try BrokerLaunch(
      project: String(repeating: "p", count: 32), agent: String(repeating: wide, count: BrokerLimits.maxAgentCharacters),
      title: String(repeating: wide, count: BrokerLimits.maxTitleCharacters),
      cwd: "/" + String(repeating: "'", count: BrokerLimits.maxCwdBytes - 1),
      command: String(repeating: "x", count: BrokerLimits.maxCommandBytes),
      secrets: secrets(String(repeating: "k", count: LaunchSecrets.maxValueBytes)))
    let longest = TmuxCommand(executable: "/opt/homebrew/bin/tmux", configPath: "/" + String(repeating: "c", count: BrokerPaths.maxSocketPathBytes))
    // The folder sits next to the socket, whose path the broker keeps within 103 bytes.
    let folder = "/" + String(repeating: "s", count: BrokerPaths.maxSocketPathBytes) + "/launch-secrets"
    let files = LaunchSecretStore(folder: URL(fileURLWithPath: folder)).files(for: launch.secrets!)
    let name = BrokerLaunch.sessionNames(for: [launch], existing: []).first!
    let bytes = TmuxCommand.commandLineBytes(longest.newSession(TmuxNewSession(name: name, launch: launch, secretFiles: files)))
    #expect(bytes <= TmuxCommand.maxCommandLineBytes, "\(bytes)")
  }
}

struct LaunchSecretStoreTests {
  @Test func writesEachSecretToAFresh0600FileInA0700Folder() throws {
    let paths = HivemindPaths(home: try temporaryHome())
    let store = LaunchSecretStore(folder: paths.launchSecrets)
    #expect(paths.launchSecrets.path.hasSuffix("Library/Application Support/Hivemind/launch-secrets"))
    let files = store.files(for: secrets())
    #expect(files.count == 1)
    #expect(files[0].name == "OPENCODE_API_KEY")
    #expect(files[0].path.hasPrefix(paths.launchSecrets.path + "/"))
    #expect(!files[0].path.contains(key))
    #expect(!FileManager.default.fileExists(atPath: files[0].path), "nothing is written before write")
    try store.write(secrets(), to: files)
    #expect(mode(paths.launchSecrets.path) == 0o700)
    #expect(mode(files[0].path) == 0o600)
    #expect(try Data(contentsOf: URL(fileURLWithPath: files[0].path)) == Data(key.utf8), "exactly the value, no newline")
    #expect(store.files(for: secrets()) != files, "every launch gets a new name")
    store.remove(files)
    #expect(!FileManager.default.fileExists(atPath: files[0].path))
  }

  @Test func neverWritesThroughAnExistingFileOrLink() throws {
    let paths = HivemindPaths(home: try temporaryHome())
    let store = LaunchSecretStore(folder: paths.launchSecrets)
    try store.prepareFolder()
    let target = paths.appSupport.appendingPathComponent("elsewhere")
    try Data("keep".utf8).write(to: target)
    let files = store.files(for: secrets())
    try FileManager.default.createSymbolicLink(atPath: files[0].path, withDestinationPath: target.path)
    #expect(throws: BrokerFiles.Failure.self) { try store.write(secrets(), to: files) }
    #expect(try String(contentsOf: target, encoding: .utf8) == "keep")
  }

  @Test func refusesASymlinkedFolderAndTightensAnOpenOne() throws {
    let paths = HivemindPaths(home: try temporaryHome())
    let store = LaunchSecretStore(folder: paths.launchSecrets)
    try BrokerFiles.preparePrivateFolder(paths.appSupport)
    let other = paths.appSupport.appendingPathComponent("other", isDirectory: true)
    try FileManager.default.createDirectory(at: other, withIntermediateDirectories: true)
    try FileManager.default.createSymbolicLink(atPath: paths.launchSecrets.path, withDestinationPath: other.path)
    #expect(throws: BrokerFiles.Failure.self) { try store.write(secrets(), to: store.files(for: secrets())) }
    #expect(try FileManager.default.contentsOfDirectory(atPath: other.path).isEmpty)
    // Nor does a sweep follow it.
    let old = other.appendingPathComponent("old.secret")
    try Data("x".utf8).write(to: old)
    try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSinceNow: -3600)], ofItemAtPath: old.path)
    #expect(store.sweep() == 0)
    #expect(FileManager.default.fileExists(atPath: old.path))

    try FileManager.default.removeItem(atPath: paths.launchSecrets.path)
    try FileManager.default.createDirectory(at: paths.launchSecrets, withIntermediateDirectories: true)
    chmod(paths.launchSecrets.path, 0o755)
    try store.prepareFolder()
    #expect(mode(paths.launchSecrets.path) == 0o700)
  }

  @Test func aSweepDeletesOnlyFilesOlderThanTenMinutes() throws {
    let paths = HivemindPaths(home: try temporaryHome())
    let store = LaunchSecretStore(folder: paths.launchSecrets)
    #expect(store.sweep() == 0, "no folder yet")
    let stale = store.files(for: secrets())
    let fresh = store.files(for: secrets())
    try store.write(secrets(), to: stale)
    try store.write(secrets(), to: fresh)
    try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSinceNow: -(LaunchSecretStore.maxAge + 5))],
                                          ofItemAtPath: stale[0].path)
    #expect(LaunchSecretStore.maxAge == 600)
    #expect(store.sweep() == 1)
    #expect(!FileManager.default.fileExists(atPath: stale[0].path))
    #expect(FileManager.default.fileExists(atPath: fresh[0].path))
    #expect(store.sweep(now: Date(timeIntervalSinceNow: LaunchSecretStore.maxAge + 5)) == 1)
    #expect(try FileManager.default.contentsOfDirectory(atPath: paths.launchSecrets.path).isEmpty)
  }
}

@MainActor
struct BrokerLaunchSecretTests {
  let base = ["-u", "-L", "hivemind", "-f", BrokerHarness.config]

  func harness() throws -> (BrokerHarness, LaunchSecretStore) {
    let h = BrokerHarness()
    let store = LaunchSecretStore(folder: HivemindPaths(home: try temporaryHome()).launchSecrets)
    h.secretStore = store
    return (h, store)
  }

  func files(_ store: LaunchSecretStore) -> [String] {
    ((try? FileManager.default.contentsOfDirectory(atPath: store.folder.path)) ?? []).map { store.folder.appendingPathComponent($0).path }
  }

  func openCode(_ agent: String? = "Atlas", value: String = key) throws -> BrokerLaunch {
    try BrokerLaunch(project: "acme", agent: agent, title: "Acme - \(agent ?? "new")", cwd: "/Users/me/acme", command: "opencode",
                     secrets: secrets(value))
  }

  @Test func aNewSessionGetsTheSecretThroughA0600FileNeverArgv() async throws {
    let (h, store) = try harness()
    await h.start()
    let (transport, connection) = await h.client()
    await h.send(connection, .launch([try openCode(), brokerLaunch(nil)]), id: "go")
    let names = [atlas, SessionName("hm-acme-new-1")!]
    #expect(transport.take().first == BrokerEventFrame(id: "go", .launched(names: names, created: names, errors: [])))
    let written = files(store)
    #expect(written.count == 1, "one file, for the launch that has a secret")
    #expect(mode(written[0]) == 0o600)
    #expect(try Data(contentsOf: URL(fileURLWithPath: written[0])) == Data(key.utf8))
    let created = h.tmux.calls("new-session")
    #expect(!h.tmux.calls.joined().contains { $0.contains(key) }, "no tmux argument holds the value")
    #expect(created[0].contains { $0.hasPrefix("if OPENCODE_API_KEY=\"$(/bin/cat -- '\(written[0])'") })
    #expect(!created[1].contains { $0.contains("OPENCODE_API_KEY") })
    #expect(!h.tmux.environments.contains { $0.values.contains { $0.contains(key) } }, "nor tmux's environment")
    #expect(!h.logs.joined().contains(key))
    #expect(!String(decoding: transport.sent, as: UTF8.self).contains(key), "nor any answer")
  }

  @Test func aReusedSessionIgnoresTheSecret() async throws {
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

    h.tmux.scripted["new-session"] = nil
    await h.send(connection, .launch([try BrokerLaunch(project: "acme", agent: "Gone", title: "t", cwd: "/Users/me/gone",
                                                       command: "opencode", secrets: secrets())]))
    #expect(transport.events().first == .launched(
      names: [nil], created: [], errors: [BrokerLaunchFailure(index: 0, code: .cwdMissing, message: "launches[0].cwd: not a folder")]))
    #expect(files(store).isEmpty, "no file for a folder that is missing")
  }

  @Test func aSessionAnotherLaunchStartedMeanwhileDropsTheFile() async throws {
    let (h, store) = try harness()
    await h.start()
    let (transport, connection) = await h.client()
    h.tmux.scripted["new-session"] = TmuxResult(status: 1, stderr: "duplicate session: hm-acme-atlas\n")
    // has-session finds it: someone else started it between the list and new-session.
    h.tmux.scripted["has-session"] = TmuxResult(status: 0)
    await h.send(connection, .launch([try openCode()]))
    #expect(transport.events().first == .launched(names: [atlas], created: [], errors: []))
    #expect(files(store).isEmpty)
  }

  @Test func withoutAStoreALaunchWithSecretsFailsAndRunsNothing() async throws {
    let h = BrokerHarness()
    await h.start()
    let (transport, connection) = await h.client()
    await h.send(connection, .launch([try openCode(), brokerLaunch(nil)]))
    #expect(transport.events().first == .launched(
      names: [nil, SessionName("hm-acme-new-1")!], created: [SessionName("hm-acme-new-1")!],
      errors: [BrokerLaunchFailure(index: 0, code: .internal, message: "launches[0].secrets: this broker cannot pass secrets")]))
    #expect(h.tmux.calls("new-session").count == 1)
  }

  @Test func startAndEveryLaunchSweepLeftoverFiles() async throws {
    let (h, store) = try harness()
    let stale = store.files(for: secrets())
    try store.write(secrets(), to: stale)
    let old = Date(timeIntervalSinceNow: -(LaunchSecretStore.maxAge + 60))
    try FileManager.default.setAttributes([.modificationDate: old], ofItemAtPath: stale[0].path)
    await h.start()
    #expect(files(store).isEmpty, "the start swept it")
    #expect(h.logs.contains("[broker] removed 1 unread launch secret file(s)"))

    let again = store.files(for: secrets())
    try store.write(secrets(), to: again)
    try FileManager.default.setAttributes([.modificationDate: old], ofItemAtPath: again[0].path)
    let (_, connection) = await h.client()
    await h.send(connection, .launch([brokerLaunch("Bea")]))
    #expect(files(store).isEmpty, "a launch swept it")
  }
}
