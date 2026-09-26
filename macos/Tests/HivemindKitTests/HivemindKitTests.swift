import Foundation
import Testing
@testable import HivemindKit

struct ServerPortTests {
  @Test func acceptsTheValidRange() {
    #expect(ServerPort(1)?.value == 1)
    #expect(ServerPort(65535)?.value == 65535)
    #expect(ServerPort("7420")?.value == 7420)
    #expect(ServerPort(" 8080 ")?.value == 8080)
    #expect(ServerPort.default.value == 7420)
  }

  @Test func rejectsEverythingElse() {
    for text in ["", "0", "65536", "-1", "+80", "08080", "80a", "1e3", "7 420", "٧٤٢٠", "999999"] {
      #expect(ServerPort(text) == nil, "\(text)")
    }
    #expect(ServerPort(0) == nil)
    #expect(ServerPort(70000) == nil)
  }

  @Test func decodingValidates() throws {
    #expect(try JSONDecoder().decode(ServerPort.self, from: Data("7420".utf8)) == .default)
    #expect(throws: DecodingError.self) { try JSONDecoder().decode(ServerPort.self, from: Data("0".utf8)) }
  }
}

struct ServerEndpointTests {
  let endpoint = ServerEndpoint(port: ServerPort(7420)!)

  @Test func urlsArePinnedToTheLoopbackIPOrigin() {
    #expect(endpoint.baseURL.absoluteString == "http://127.0.0.1:7420/")
    #expect(endpoint.healthURL.absoluteString == "http://127.0.0.1:7420/api/health")
    #expect(endpoint.url(hash: "#/c/general").absoluteString == "http://127.0.0.1:7420/#/c/general")
    #expect(endpoint.url(hash: "/inbox").absoluteString == "http://127.0.0.1:7420/#/inbox")
    #expect(endpoint.url(hash: "").absoluteString == "http://127.0.0.1:7420/")
  }

  @Test func sameOriginIsExact() {
    #expect(endpoint.isSameOrigin(URL(string: "http://127.0.0.1:7420/api/x?y#z")!))
    #expect(!endpoint.isSameOrigin(URL(string: "http://localhost:7420/")!))
    #expect(!endpoint.isSameOrigin(URL(string: "https://127.0.0.1:7420/")!))
    #expect(!endpoint.isSameOrigin(URL(string: "http://127.0.0.1:7421/")!))
    #expect(!endpoint.isSameOrigin(URL(string: "http://127.0.0.1/")!))
    #expect(!endpoint.isSameOrigin(URL(string: "http://user@127.0.0.1:7420/")!))
    #expect(!endpoint.isSameOrigin(URL(string: "http://127.0.0.1.evil.test:7420/")!))
    #expect(ServerEndpoint(port: ServerPort(80)!).isSameOrigin(URL(string: "http://127.0.0.1/")!))
  }
}

struct PathsTests {
  let paths = HivemindPaths(home: URL(fileURLWithPath: "/Users/h", isDirectory: true))

  @Test func locations() {
    #expect(paths.defaultDataHome.path == "/Users/h/.hivemind")
    #expect(paths.discoveryFile.path == "/Users/h/Library/Application Support/Hivemind/server.json")
    #expect(paths.serverLog.path == "/Users/h/Library/Logs/Hivemind/server.log")
    #expect(paths.userCommandLineTool.path == "/Users/h/.local/bin/hivemind")
    #expect(paths.systemCommandLineTool.path == "/usr/local/bin/hivemind")
    #expect(HivemindPaths.lockFile(dataHome: paths.defaultDataHome).path == "/Users/h/.hivemind/server.lock")
  }

  @Test func tildeExpansion() {
    #expect(paths.expandingTilde("~").path == "/Users/h")
    #expect(paths.expandingTilde("~/hives/work").path == "/Users/h/hives/work")
    #expect(paths.expandingTilde("/srv/hive").path == "/srv/hive")
  }
}

struct DiscoveryTests {
  @Test func roundTripsAtomicallyWithPrivatePermissions() throws {
    let paths = HivemindPaths(home: try temporaryHome())
    let store = DiscoveryStore(paths: paths)
    #expect(store.read() == nil)
    let discovery = ServerDiscovery(
      port: ServerPort(7421)!, pid: 4242, home: "/Users/h/.hivemind",
      startedAt: Date(timeIntervalSince1970: 1_790_000_000), version: "0.5.0")
    try store.write(discovery)
    #expect(store.read() == discovery)
    let mode = try FileManager.default.attributesOfItem(atPath: store.file.path)[.posixPermissions] as? Int
    #expect(mode == 0o600)
    let json = try String(contentsOf: store.file, encoding: .utf8)
    #expect(json == #"{"home":"/Users/h/.hivemind","pid":4242,"port":7421,"startedAt":"2026-09-21T14:13:20Z","version":"0.5.0"}"# + "\n")
  }

  @Test func liveReadIgnoresADeadPid() throws {
    let store = DiscoveryStore(paths: HivemindPaths(home: try temporaryHome()))
    try store.write(ServerDiscovery(port: .default, pid: 9, home: "/h", startedAt: Date(), version: "1"))
    #expect(store.readLive(isAlive: { _ in false }) == nil)
    #expect(store.readLive(isAlive: { $0 == 9 })?.pid == 9)
  }

  @Test func corruptFilesReadAsMissing() throws {
    let store = DiscoveryStore(paths: HivemindPaths(home: try temporaryHome()))
    try FileManager.default.createDirectory(at: store.file.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data("{\"port\":0}".utf8).write(to: store.file)
    #expect(store.read() == nil)
  }

  @Test func removeOnlyDeletesItsOwnDiscovery() throws {
    let store = DiscoveryStore(paths: HivemindPaths(home: try temporaryHome()))
    try store.write(ServerDiscovery(port: .default, pid: 2, home: "/h", startedAt: Date(), version: "1"))
    store.remove(ifOwnedBy: 1)
    #expect(store.read()?.pid == 2)
    store.remove(ifOwnedBy: 2)
    #expect(store.read() == nil)
  }

  @Test func locatorPrefersALiveDiscovery() throws {
    let store = DiscoveryStore(paths: HivemindPaths(home: try temporaryHome()))
    #expect(ServerLocator.endpoint(discovery: store, configuredPort: nil).port == .default)
    #expect(ServerLocator.endpoint(discovery: store, configuredPort: ServerPort(8000)).port.value == 8000)
    try store.write(ServerDiscovery(port: ServerPort(9000)!, pid: 5, home: "/h", startedAt: Date(), version: "1"))
    #expect(ServerLocator.endpoint(discovery: store, configuredPort: ServerPort(8000), isAlive: { _ in true }).port.value == 9000)
    #expect(ServerLocator.endpoint(discovery: store, configuredPort: ServerPort(8000), isAlive: { _ in false }).port.value == 8000)
  }
}

@MainActor
struct DiscoveryPublisherTests {
  @Test func publishesWhileRunningAndWithdrawsOtherwise() throws {
    let store = DiscoveryStore(paths: HivemindPaths(home: try temporaryHome()))
    let settings = ServerLaunchSettings(port: ServerPort(7422)!, dataHome: URL(fileURLWithPath: "/data"))
    let publisher = DiscoveryPublisher(store: store, version: "0.5.0", settings: { settings })
    let since = Date(timeIntervalSince1970: 1_790_000_000)
    publisher.update(for: .starting(pid: 10))
    #expect(store.read() == nil)
    publisher.update(for: .running(pid: 10, since: since))
    #expect(store.read() == ServerDiscovery(port: ServerPort(7422)!, pid: 10, home: "/data", startedAt: since, version: "0.5.0"))
    publisher.update(for: .stopping(pid: 10))
    #expect(store.read() == nil)
    publisher.update(for: .running(pid: 11, since: since))
    #expect(store.read()?.pid == 11)
    publisher.update(for: .waitingToRestart(attempt: 1, at: since))
    #expect(store.read() == nil)
  }

  @Test func neverRemovesAnotherServersDiscovery() throws {
    let store = DiscoveryStore(paths: HivemindPaths(home: try temporaryHome()))
    let settings = ServerLaunchSettings(port: .default, dataHome: URL(fileURLWithPath: "/data"))
    let publisher = DiscoveryPublisher(store: store, version: "1", settings: { settings })
    publisher.update(for: .running(pid: 10, since: Date()))
    try store.write(ServerDiscovery(port: .default, pid: 99, home: "/other", startedAt: Date(), version: "1"))
    publisher.update(for: .stopped)
    #expect(store.read()?.pid == 99)
  }
}

struct InstanceLockTests {
  func dataHome(lock: String?) throws -> URL {
    let home = try temporaryHome()
    if let lock { try Data(lock.utf8).write(to: HivemindPaths.lockFile(dataHome: home)) }
    return home
  }

  @Test func liveOwnerNeedsAParsableLockAndALivePid() throws {
    let lock = #"{"pid":5558,"token":"75b315b9","startedAt":1790382073128}"# + "\n"
    let home = try dataHome(lock: lock)
    #expect(InstanceLockOwner.live(dataHome: home, isAlive: { $0 == 5558 })?.pid == 5558)
    #expect(InstanceLockOwner.live(dataHome: home, isAlive: { _ in false }) == nil)
    #expect(InstanceLockOwner.live(dataHome: try dataHome(lock: nil), isAlive: { _ in true }) == nil)
    #expect(InstanceLockOwner.live(dataHome: try dataHome(lock: "{not json"), isAlive: { _ in true }) == nil)
  }

  @Test func processLiveness() {
    #expect(ProcessLiveness.isAlive(getpid()))
    #expect(!ProcessLiveness.isAlive(0))
    #expect(!ProcessLiveness.isAlive(-1))
    #expect(ProcessLiveness.isAlive(1), "launchd exists; EPERM still counts as alive")
  }
}

struct BackoffTests {
  @Test func growsExponentiallyToTheCap() {
    let policy = BackoffPolicy(initial: 1, multiplier: 2, maximum: 10, stableAfter: 30, maxAttempts: 6)
    #expect((1...6).map { policy.delay(forAttempt: $0) } == [1, 2, 4, 8, 10, 10])
    #expect(policy.delay(forAttempt: 7) == nil)
    #expect(policy.delay(forAttempt: 0) == nil)
    #expect(policy.isStable(uptime: 30))
    #expect(!policy.isStable(uptime: 29.9))
  }
}

struct HealthCheckTests {
  let endpoint = ServerEndpoint(port: .default)

  @Test func healthyOnlyForHivemind() async {
    let ok = HealthChecker(http: FakeHTTP(result: .success((200, Data(#"{"ok":true,"name":"hivemind"}"#.utf8)))))
    #expect(await ok.check(endpoint) == .healthy)
    let other = HealthChecker(http: FakeHTTP(result: .success((200, Data(#"{"ok":true}"#.utf8)))))
    #expect(await other.check(endpoint) == .foreign)
    let error = HealthChecker(http: FakeHTTP(result: .success((503, Data(#"{"ok":true,"name":"hivemind"}"#.utf8)))))
    #expect(await error.check(endpoint) == .foreign)
    let html = HealthChecker(http: FakeHTTP(result: .success((200, Data("<html>".utf8)))))
    #expect(await html.check(endpoint) == .foreign)
  }

  @Test func unreachableCarriesTheError() async {
    let down = HealthChecker(http: FakeHTTP(result: .failure(URLError(.cannotConnectToHost))))
    guard case .unreachable = await down.check(endpoint) else {
      Issue.record("expected unreachable")
      return
    }
  }
}

struct ServerOutputTests {
  @Test func readyLine() {
    #expect(ServerOutput.listeningPort(in: "hivemind on http://127.0.0.1:7420")?.value == 7420)
    #expect(ServerOutput.listeningPort(in: "hivemind on http://127.0.0.1:7420 ")?.value == 7420)
    #expect(ServerOutput.listeningPort(in: "hivemind on http://localhost:7420") == nil)
    #expect(ServerOutput.listeningPort(in: "note: hivemind on http://127.0.0.1:7420") == nil)
  }

  @Test func fatalAndErrorLines() {
    #expect(ServerOutput.isFatal("Another Hivemind server (pid 1) is already running for HIVEMIND_HOME /x."))
    #expect(ServerOutput.isFatal("Error: listen EADDRINUSE: address already in use 127.0.0.1:7420"))
    #expect(!ServerOutput.isFatal("Error: boom"))
    #expect(ServerOutput.isError("Error: boom"))
    #expect(!ServerOutput.isError("    at main (file:///x.js:1:1)"))
    #expect(!ServerOutput.isError("Node.js v24.21.0"))
    #expect(!ServerOutput.isError("        ^"))
    #expect(!ServerOutput.isError("^"))
    #expect(!ServerOutput.isError(""))
    #expect(!ServerOutput.isError("hivemind on http://127.0.0.1:7420"))
  }
}

struct LaunchSettingsTests {
  let server = BundledServer(contents: URL(fileURLWithPath: "/Applications/Hivemind Server.app/Contents"))
  let home = URL(fileURLWithPath: "/Users/h")

  @Test func bundledLayout() {
    #expect(server.node.path == "/Applications/Hivemind Server.app/Contents/Helpers/node")
    #expect(server.cli.path == "/Applications/Hivemind Server.app/Contents/Resources/server/bin/hivemind.mjs")
  }

  @Test func specRunsServeWithTheChosenPortAndHome() {
    let settings = ServerLaunchSettings(port: ServerPort(7421)!, dataHome: URL(fileURLWithPath: "/Users/h/hive"))
    let spec = settings.spec(
      server: server,
      baseEnvironment: [
        "PATH": "/usr/bin:/bin:/opt/homebrew/bin", "LANG": "en_US.UTF-8",
        "NODE_OPTIONS": "--require /tmp/evil.js", "HIVEMIND_TOKEN": "t", "HIVEMIND_PORT": "1", "HIVEMIND_HOME": "/elsewhere",
      ],
      home: home)
    #expect(spec.executable == server.node)
    #expect(spec.arguments == [server.cli.path, "serve", "--port", "7421"])
    #expect(spec.workingDirectory?.path == "/Users/h/hive")
    #expect(spec.environment["HIVEMIND_HOME"] == "/Users/h/hive")
    #expect(spec.environment["LANG"] == "en_US.UTF-8")
    #expect(spec.environment["HOME"] == "/Users/h")
    #expect(spec.environment["NODE_OPTIONS"] == nil)
    #expect(spec.environment["HIVEMIND_TOKEN"] == nil)
    #expect(spec.environment["HIVEMIND_PORT"] == nil)
    #expect(spec.environment["PATH"] ==
      "/Applications/Hivemind Server.app/Contents/Helpers:/opt/homebrew/bin:/usr/local/bin:/Users/h/.local/bin:/usr/bin:/bin")
  }

  @Test func preflightChecksTheLockThenThePort() {
    let settings = ServerLaunchSettings(port: .default, dataHome: URL(fileURLWithPath: "/data"))
    let owner = try! JSONDecoder().decode(InstanceLockOwner.self, from: Data(#"{"pid":3,"token":"x"}"#.utf8))
    #expect(settings.preflight(probe: FakeProbe(), lockOwner: { _ in nil }) == nil)
    #expect(settings.preflight(probe: FakeProbe(listening: [7420]), lockOwner: { _ in nil }) == .portInUse(.default))
    #expect(settings.preflight(probe: FakeProbe(listening: [7420]), lockOwner: { _ in owner }) == .dataFolderInUse(pid: 3, dataHome: "/data"))
  }

  @Test func versionComesFromThePackedPackageJSON() throws {
    let contents = try temporaryHome()
    let root = contents.appendingPathComponent("Resources/server")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    try Data(#"{"name":"hivemind","version":"0.5.0"}"#.utf8).write(to: root.appendingPathComponent("package.json"))
    #expect(BundledServer(contents: contents).version() == "0.5.0")
    #expect(BundledServer(contents: URL(fileURLWithPath: "/nonexistent")).version() == nil)
  }
}

struct LineSplitterTests {
  @Test func splitsAcrossChunks() {
    var splitter = LineSplitter()
    #expect(splitter.append(Data("hel".utf8)) == [])
    #expect(splitter.append(Data("lo\r\nwor".utf8)) == ["hello"])
    #expect(splitter.append(Data("ld\n\n".utf8)) == ["world", ""])
    #expect(splitter.append(Data("tail".utf8)) == [])
    #expect(splitter.finish() == ["tail"])
    #expect(splitter.finish() == [])
  }

  @Test func capsRunawayLinesAndSurvivesBadUTF8() {
    var splitter = LineSplitter(maxLineBytes: 4)
    #expect(splitter.append(Data("abcdefghij".utf8)) == ["abcd", "efgh"])
    #expect(splitter.finish() == ["ij"])
    #expect(splitter.append(Data([0x66, 0xFF, 0x0A])) == ["f\u{FFFD}"])
  }
}

struct RotatingLogTests {
  @Test func rotatesAndKeepsTheNewestFiles() throws {
    let file = try temporaryHome().appendingPathComponent("Logs/server.log")
    let log = RotatingLog(file: file, maxBytes: 60, keep: 2, clock: { Date(timeIntervalSince1970: 0) })
    // Each line is 24 (timestamp) + 1 + 5 + 1 = 31 bytes: one fits, two do not.
    for index in 1...4 { log.append("line\(index)") }
    let read = { (url: URL) in try? String(contentsOf: url, encoding: .utf8) }
    #expect(read(file) == "1970-01-01T00:00:00.000Z line4\n")
    #expect(read(log.rotated(1)) == "1970-01-01T00:00:00.000Z line3\n")
    #expect(read(log.rotated(2)) == "1970-01-01T00:00:00.000Z line2\n")
    #expect(!FileManager.default.fileExists(atPath: log.rotated(3).path))
    let mode = try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? Int
    #expect(mode == 0o600)
  }

  @Test func tagsTheStream() throws {
    let file = try temporaryHome().appendingPathComponent("server.log")
    let log = RotatingLog(file: file, clock: { Date(timeIntervalSince1970: 0) })
    log.append("boom", channel: .stderr)
    log.append("hi", channel: .stdout)
    #expect(try String(contentsOf: file, encoding: .utf8) ==
      "1970-01-01T00:00:00.000Z [err] boom\n1970-01-01T00:00:00.000Z [out] hi\n")
  }

  @Test func anOversizedExistingFileRotatesFirst() throws {
    let file = try temporaryHome().appendingPathComponent("server.log")
    try Data(repeating: 0x41, count: 100).write(to: file)
    let log = RotatingLog(file: file, maxBytes: 50, keep: 1, clock: { Date(timeIntervalSince1970: 0) })
    log.append("x")
    #expect(try String(contentsOf: file, encoding: .utf8) == "1970-01-01T00:00:00.000Z x\n")
    #expect(try Data(contentsOf: log.rotated(1)).count == 100)
  }
}

struct CommandLineToolTests {
  let server = BundledServer(contents: URL(fileURLWithPath: "/Applications/Hivemind Server.app/Contents"))
  let discovery = URL(fileURLWithPath: "/Users/h/Library/Application Support/Hivemind/server.json")

  @Test func quoting() {
    #expect(CommandLineTool.shellQuoted("/a b/c") == "'/a b/c'")
    #expect(CommandLineTool.shellQuoted("it's") == #"'it'\''s'"#)
    #expect(CommandLineTool.appleScriptLiteral(#"a "b" \c"#) == #""a \"b\" \\c""#)
  }

  @Test func scriptExecsTheBundledNode() {
    let script = CommandLineTool.script(server: server, discoveryFile: discovery)
    #expect(script.hasPrefix("#!/bin/sh\n"))
    #expect(script.contains("node='/Applications/Hivemind Server.app/Contents/Helpers/node'\n"))
    #expect(script.contains("cli='/Applications/Hivemind Server.app/Contents/Resources/server/bin/hivemind.mjs'\n"))
    #expect(script.contains(#"exec "$node" "$cli" "$@""#))
    #expect(script.contains(#"sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' '/Users/h/Library/Application Support/Hivemind/server.json'"#))
  }

  /// Parses the script with /bin/sh -n (syntax only; nothing runs).
  @Test func scriptIsValidShell() throws {
    let file = try temporaryHome().appendingPathComponent("hivemind")
    try CommandLineTool.script(server: server, discoveryFile: discovery).write(to: file, atomically: true, encoding: .utf8)
    let check = Process()
    check.executableURL = URL(fileURLWithPath: "/bin/sh")
    check.arguments = ["-n", file.path]
    try check.run()
    check.waitUntilExit()
    #expect(check.terminationStatus == 0)
  }

  /// Runs the wrapper against a fake `node` (a shell script that prints its
  /// environment): no Node.js, no server, no port.
  func runWrapper(discovery: ServerDiscovery?, environment: [String: String] = [:]) throws -> [String] {
    let root = try temporaryHome()
    let fake = BundledServer(contents: root.appendingPathComponent("Fake Server.app/Contents"))
    let fm = FileManager.default
    try fm.createDirectory(at: fake.node.deletingLastPathComponent(), withIntermediateDirectories: true)
    try fm.createDirectory(at: fake.cli.deletingLastPathComponent(), withIntermediateDirectories: true)
    try "#!/bin/sh\necho \"url=${HIVEMIND_URL:-}\"\necho \"home=${HIVEMIND_HOME:-}\"\necho \"cli=$1\"\nshift\necho \"args=$*\"\n"
      .write(to: fake.node, atomically: true, encoding: .utf8)
    try fm.setAttributes([.posixPermissions: 0o755], ofItemAtPath: fake.node.path)
    try "".write(to: fake.cli, atomically: true, encoding: .utf8)
    let store = DiscoveryStore(file: root.appendingPathComponent("Application Support/Hivemind/server.json"))
    if let discovery { try store.write(discovery) }
    let wrapper = root.appendingPathComponent("hivemind")
    try CommandLineTool.script(server: fake, discoveryFile: store.file).write(to: wrapper, atomically: true, encoding: .utf8)

    let run = Process()
    let out = Pipe()
    run.executableURL = URL(fileURLWithPath: "/bin/sh")
    run.arguments = [wrapper.path, "status", "--json"]
    run.environment = ["PATH": "/usr/bin:/bin"].merging(environment) { $1 }
    run.standardOutput = out
    try run.run()
    run.waitUntilExit()
    #expect(run.terminationStatus == 0)
    let text = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    let lines = text.split(separator: "\n").map(String.init)
    #expect(lines.contains("cli=\(fake.cli.path)"))
    return lines.filter { !$0.hasPrefix("cli=") }
  }

  @Test func wrapperFollowsTheRunningServer() throws {
    let discovery = ServerDiscovery(port: ServerPort(7431)!, pid: 1, home: "/Users/h/My Hive",
                                    startedAt: Date(timeIntervalSince1970: 0), version: "0.5.0")
    #expect(try runWrapper(discovery: discovery) ==
      ["url=http://127.0.0.1:7431", "home=/Users/h/My Hive", "args=status --json"])
    #expect(try runWrapper(discovery: discovery, environment: ["HIVEMIND_URL": "http://127.0.0.1:9", "HIVEMIND_HOME": "/x"]) ==
      ["url=http://127.0.0.1:9", "home=/x", "args=status --json"])
    #expect(try runWrapper(discovery: nil) == ["url=", "home=", "args=status --json"])
    // A home JSON had to escape is not guessed at.
    var odd = discovery
    odd.home = #"/Users/h/a"b"#
    #expect(try runWrapper(discovery: odd) == ["url=http://127.0.0.1:7431", "home=", "args=status --json"])
  }
}

struct NavigationPolicyTests {
  let endpoint = ServerEndpoint(port: .default)

  func decide(_ string: String) -> NavigationDecision { NavigationPolicy.decide(URL(string: string)!, endpoint: endpoint) }

  @Test func pinsToTheLocalOrigin() {
    #expect(decide("http://127.0.0.1:7420/#/c/general") == .allow)
    #expect(decide("about:blank") == .allow)
    #expect(decide("blob:http://127.0.0.1:7420/0b7c") == .allow)
    #expect(decide("https://github.com/maxcorrads/hivemind") == .openExternally)
    #expect(decide("http://localhost:7420/") == .openExternally)
    #expect(decide("mailto:someone@example.com") == .openExternally)
    #expect(decide("blob:https://evil.test/0b7c") == .deny)
    #expect(decide("file:///etc/passwd") == .deny)
    #expect(decide("javascript:alert(1)") == .deny)
    #expect(decide("data:text/html,hi") == .deny)
    #expect(decide("about:config") == .deny)
    #expect(decide("https://user:pw@evil.test/") == .deny)
  }
}

struct BridgeTests {
  @Test func parsesMessages() {
    #expect(BridgeMessage(body: ["type": "ready"]) == .ready)
    #expect(BridgeMessage(body: ["type": "badge", "count": NSNumber(value: 3)]) == .badge(count: 3))
    #expect(BridgeMessage(body: ["type": "badge", "count": NSNumber(value: 0)]) == .badge(count: 0))
    #expect(BridgeMessage(body: [
      "type": "notify", "title": "#general", "body": "Ada: hi", "tag": "m1", "target": "/c/general/t/m1",
    ]) == .notify(title: "#general", body: "Ada: hi", tag: "m1", target: "#/c/general/t/m1"))
    #expect(BridgeMessage(body: ["type": "notify", "title": "t"]) == .notify(title: "t", body: "", tag: nil, target: nil))
  }

  @Test func dropsMalformedMessages() {
    #expect(BridgeMessage(body: "ready") == nil)
    #expect(BridgeMessage(body: ["type": "nope"]) == nil)
    #expect(BridgeMessage(body: ["type": "notify", "body": "no title"]) == nil)
    #expect(BridgeMessage(body: ["type": "badge", "count": NSNumber(value: -1)]) == nil)
    #expect(BridgeMessage(body: ["type": "badge", "count": NSNumber(value: 1.5)]) == nil)
    #expect(BridgeMessage(body: ["type": "badge", "count": NSNumber(value: true)]) == nil)
    #expect(BridgeMessage(body: ["type": "badge", "count": "3"]) == nil)
    #expect(BridgeMessage(body: ["type": "notify", "title": "t", "target": "#/c/a b"]) == .notify(title: "t", body: "", tag: nil, target: nil))
  }

  @Test func capsText() {
    guard case .notify(let title, _, _, _) = BridgeMessage(body: ["type": "notify", "title": String(repeating: "x", count: 10_000)]) else {
      Issue.record("expected notify")
      return
    }
    #expect(title.count == 4096)
  }

  @Test func dockBadge() {
    #expect(dockBadgeLabel(count: 0) == nil)
    #expect(dockBadgeLabel(count: 12) == "12")
  }

  @Test func commandsBecomeCustomEvents() {
    #expect(BridgeCommand.jump.javaScript ==
      #"window.dispatchEvent(new CustomEvent("hivemind:native", {detail: {"command":"jump"}}));"#)
    #expect(BridgeCommand.forYou.name == "for-you")
    #expect(BridgeCommand.newChannel.name == "new-channel")
    #expect(BridgeCommand.toggleTheme.name == "toggle-theme")
    #expect(BridgeCommand.settings.name == "settings")
    #expect(BridgeCommand.navigate(hash: "#/c/x\"</script>").javaScript ==
      ##"window.dispatchEvent(new CustomEvent("hivemind:native", {detail: {"command":"navigate","hash":"#\/c\/x\"<\/script>"}}));"##)
  }
}
