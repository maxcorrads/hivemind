import Darwin
import Foundation
import Testing
@testable import HivemindKit

/// Mutable stand-ins for the process table and signals the controller sees.
@MainActor
final class FakeSystem {
  var alive: Set<Int32> = []
  var starts: [Int32: Date] = [:]
  var signals: [(pid: Int32, signal: Int32)] = []
  var lock: InstanceLockOwner?
}

/// UserDefaults' behaviour for the keys the store uses, in memory.
final class MemorySettings: SettingsStorage {
  var values: [String: Any] = [:]
  func object(forKey key: String) -> Any? { values[key] }
  func string(forKey key: String) -> String? { values[key] as? String }
  func set(_ value: Any?, forKey key: String) { values[key] = value }
  func removeObject(forKey key: String) { values[key] = nil }
}

struct MutableProbe: PortProbing {
  let listening: @Sendable (Int) -> Bool
  func isListening(_ port: ServerPort) -> Bool { listening(port.value) }
}

/// A port set the probe reads across the MainActor boundary.
final class PortSet: @unchecked Sendable {
  private let lock = NSLock()
  private var ports: Set<Int> = []
  func insert(_ port: Int) { lock.withLock { _ = ports.insert(port) } }
  func remove(_ port: Int) { lock.withLock { _ = ports.remove(port) } }
  func contains(_ port: Int) -> Bool { lock.withLock { ports.contains(port) } }
}

@MainActor
struct ServerAppControllerTests {
  let launcher = FakeLauncher()
  let scheduler = FakeScheduler()
  let system = FakeSystem()
  let taken = PortSet()
  let home: URL
  let paths: HivemindPaths
  let defaults = MemorySettings()

  init() throws {
    home = try temporaryHome()
    paths = HivemindPaths(home: home)
  }

  var server: BundledServer { BundledServer(contents: URL(fileURLWithPath: "/Apps/Hivemind Server.app/Contents")) }
  var store: ServerAppSettingsStore { ServerAppSettingsStore(defaults: defaults) }
  var discovery: DiscoveryStore { DiscoveryStore(paths: paths) }

  func controller(server: BundledServer?? = nil) -> ServerAppController {
    let system = self.system
    let taken = self.taken
    let deps = ServerAppController.Dependencies(
      launcher: launcher, scheduler: scheduler, probe: MutableProbe { taken.contains($0) },
      lockOwner: { _ in system.lock }, isAlive: { system.alive.contains($0) },
      processStart: { system.starts[$0] }, signal: { system.signals.append(($0, $1)) },
      baseEnvironment: ["PATH": "/usr/bin:/bin", "HIVEMIND_PORT": "1", "NODE_OPTIONS": "--require evil"],
      backoff: BackoffPolicy(initial: 1, multiplier: 2, maximum: 8, stableAfter: 30, maxAttempts: 3),
      stopTimeout: 10)
    return ServerAppController(
      paths: paths, server: server ?? self.server, version: "9.9.9", store: store,
      log: RotatingLog(file: paths.serverLog), dependencies: deps)
  }

  func ready(_ port: Int = 7420) {
    launcher.current?.say("hivemind on http://127.0.0.1:\(port)")
  }

  func logText() throws -> String { try String(contentsOf: paths.serverLog, encoding: .utf8) }

  // MARK: Launch

  @Test func launchesServeWithTheDataFolderAndPort() throws {
    let sut = controller()
    sut.launch()
    let spec = try #require(launcher.specs.first)
    #expect(spec.executable.path == "/Apps/Hivemind Server.app/Contents/Helpers/node")
    #expect(spec.arguments == ["/Apps/Hivemind Server.app/Contents/Resources/server/bin/hivemind.mjs", "serve", "--port", "7420"])
    #expect(spec.environment["HIVEMIND_HOME"] == paths.defaultDataHome.path)
    #expect(spec.environment["HIVEMIND_PORT"] == "7420", "the inherited value is replaced, not passed through")
    #expect(spec.environment["NODE_OPTIONS"] == nil)
    #expect(spec.workingDirectory == paths.defaultDataHome)
    var isDirectory: ObjCBool = false
    #expect(FileManager.default.fileExists(atPath: paths.defaultDataHome.path, isDirectory: &isDirectory) && isDirectory.boolValue,
            "Process refuses a missing working directory")
    #expect(sut.status.title == "Starting on port 7420…")
  }

  @Test func publishesDiscoveryWhileRunningAndWithdrawsOnStop() throws {
    let sut = controller()
    sut.launch()
    ready()
    #expect(sut.status.title == "Running on port 7420")
    let published = try #require(discovery.read())
    #expect(published.pid == 100)
    #expect(published.port == .default)
    #expect(published.home == paths.defaultDataHome.path)
    #expect(published.version == "9.9.9")
    sut.stop()
    #expect(sut.state == .stopped)
    #expect(discovery.read() == nil)
  }

  @Test func publishesThePortTheServerAnnounced() throws {
    let sut = controller()
    sut.launch()
    ready(7777)
    #expect(try #require(discovery.read()).port.value == 7777)
    #expect(sut.endpoint.port.value == 7777)
  }

  @Test func logsTheServerOutputAndTheAppsOwnEvents() throws {
    let sut = controller()
    sut.launch()
    launcher.current?.say("migrating", on: .stdout)
    ready()
    let log = try logText()
    #expect(log.contains("[app] Hivemind Server 9.9.9 launched"))
    #expect(log.contains("[app] starting hivemind serve on port 7420"))
    #expect(log.contains("[out] migrating"))
    #expect(log.contains("[err] hivemind on http://127.0.0.1:7420"))
    #expect(log.contains("[app] server ready on http://127.0.0.1:7420/"))
  }

  @Test func clearsAStaleDiscoveryFileOnLaunch() throws {
    try discovery.write(ServerDiscovery(port: .default, pid: 4242, home: "/x", startedAt: Date(), version: "0"))
    controller().launch()
    #expect(discovery.read() == nil)
  }

  @Test func keepsALiveDiscoveryFileOnLaunch() throws {
    system.alive = [4242]
    try discovery.write(ServerDiscovery(port: .default, pid: 4242, home: "/x", startedAt: Date(), version: "0"))
    controller().launch()
    #expect(discovery.read()?.pid == 4242, "it may be our previous server, which the UI can still use")
  }

  @Test func withoutBundledNodeNothingStarts() {
    let sut = controller(server: .some(nil))
    var changes = 0
    sut.onChange = { changes += 1 }
    sut.launch()
    #expect(launcher.launched.isEmpty)
    #expect(sut.status.kind == .failed)
    #expect(sut.status.title.hasPrefix("Node.js is not bundled"))
    #expect(!sut.status.canStart && !sut.status.canRestart)
    #expect(changes == 1)
  }

  // MARK: Refusals

  @Test func refusesADataFolderAnotherServerHolds() {
    system.lock = InstanceLockOwner(pid: 55, token: "t", startedAt: nil)
    let sut = controller()
    sut.launch()
    #expect(launcher.launched.isEmpty)
    #expect(sut.state == .failed("Another Hivemind server (pid 55) is already using \(paths.defaultDataHome.path)"))
    #expect(sut.status.canStart)
    #expect(sut.previousServer == nil, "no server.json names it, so it is not ours to stop")
  }

  @Test func refusesATakenPortAndRetriesAtOnceOnANewPort() throws {
    taken.insert(7420)
    let sut = controller()
    sut.launch()
    #expect(sut.state == .failed("Port 7420 is already in use"))
    sut.update(ServerAppSettings(port: try #require(ServerPort(7421))))
    #expect(launcher.specs.last?.arguments.suffix(2) == ["--port", "7421"])
    #expect(sut.state == .starting(pid: 100))
  }

  // MARK: Settings

  @Test func aPortChangeRestartsARunningServerAndPersists() throws {
    let sut = controller()
    sut.launch()
    ready()
    let port = try #require(ServerPort(8123))
    sut.update(ServerAppSettings(port: port))
    #expect(launcher.launched.count == 2)
    #expect(launcher.launched[0].terminated == 1)
    #expect(launcher.specs.last?.environment["HIVEMIND_PORT"] == "8123")
    #expect(store.load().port == port)
    #expect(discovery.read() == nil, "the old server's discovery went with it")
  }

  @Test func settingsChangeWhileStoppedOnlySaves() throws {
    let sut = controller()
    let folder = home.appendingPathComponent("other hive", isDirectory: true)
    sut.update(ServerAppSettings(dataHome: folder))
    #expect(launcher.launched.isEmpty)
    #expect(store.load().dataHome?.path == folder.path)
    #expect(sut.dataHome.path == folder.path)
    sut.start()
    #expect(launcher.specs.first?.environment["HIVEMIND_HOME"] == folder.path)
  }

  @Test func aDataFolderChangeWhileWaitingToRestartStartsAtOnce() throws {
    let sut = controller()
    sut.launch()
    launcher.current?.crash()
    guard case .waitingToRestart = sut.state else { Issue.record("expected a pending restart"); return }
    sut.update(ServerAppSettings(dataHome: home.appendingPathComponent("b", isDirectory: true)))
    #expect(launcher.launched.count == 2)
    scheduler.advance(60)
    #expect(launcher.launched.count == 2, "the pending restart was replaced, not added to")
  }

  @Test func sameSettingsDoNotRestart() {
    let sut = controller()
    sut.launch()
    ready()
    sut.update(ServerAppSettings(port: .default, dataHome: paths.defaultDataHome))
    #expect(launcher.launched.count == 1, "the default folder spelled out is the same folder")
    #expect(defaults.object(forKey: SettingsKey.dataHome) == nil, "and is stored as the default")
  }

  // MARK: Crashes

  @Test func surfacesTheLastErrorWhileRestarting() {
    let sut = controller()
    sut.launch()
    launcher.current?.say("Error: SQLITE_CORRUPT: database disk image is malformed")
    launcher.current?.say("    at Database.open (node:sqlite:1:1)")
    launcher.current?.crash()
    #expect(sut.status.title == "Crashed, restarting (attempt 1)")
    #expect(sut.status.detail == "Error: SQLITE_CORRUPT: database disk image is malformed")
    #expect(sut.status.canStart && sut.status.canStop)
  }

  // MARK: Open Hivemind

  @Test func whenReadyWaitsForTheReadyLine() {
    let sut = controller()
    sut.launch()
    var opened: [URL] = []
    sut.whenReady { opened.append($0.baseURL) }
    #expect(opened.isEmpty)
    ready(7500)
    #expect(opened == [URL(string: "http://127.0.0.1:7500/")!])
  }

  @Test func whenReadyRunsAtOnceWhenTheServerCannotStart() {
    taken.insert(7420)
    let sut = controller()
    sut.launch()
    var opened = 0
    sut.whenReady { _ in opened += 1 }
    #expect(opened == 1, "something else holds the port; show it rather than nothing")
  }

  @Test func aStopDropsWhatWaitedForReady() {
    let sut = controller()
    sut.launch()
    var opened = 0
    sut.whenReady { _ in opened += 1 }
    sut.stop()
    sut.start()
    ready()
    #expect(opened == 0)
  }

  @Test func openHivemindPrefersTheApp() {
    let endpoint = ServerEndpoint(port: .default)
    let app = URL(fileURLWithPath: "/Applications/Hivemind.app")
    #expect(OpenHivemindAction.decide(uiApp: app, endpoint: endpoint) == .launchApp(app))
    #expect(OpenHivemindAction.decide(uiApp: nil, endpoint: endpoint) == .openInBrowser(URL(string: "http://127.0.0.1:7420/")!))
  }

  // MARK: Quit

  @Test func shutdownStopsTheChildThenWithdrawsDiscovery() {
    let sut = controller()
    sut.launch()
    ready()
    launcher.current?.exitsOnTerminate = false
    #expect(sut.hasChild)
    var done = false
    sut.shutdown { done = true }
    #expect(!done)
    #expect(discovery.read() == nil, "withdrawn as soon as the server stops serving")
    scheduler.advance(10)
    #expect(launcher.current?.killed == 1)
    #expect(done)
    #expect(!sut.hasChild)
  }

  @Test func shutdownWithoutAChildCompletesAtOnce() {
    let sut = controller()
    var done = false
    sut.shutdown { done = true }
    #expect(done)
  }

  // MARK: A previous server of ours

  /// The state a force-quit app leaves: server.json and server.lock both name
  /// a live server this app started.
  func leavePreviousServer(pid: Int32 = 900, startedBeforeReady: Bool = true) throws {
    let ready = Date(timeIntervalSince1970: 2_000_000)
    system.alive.insert(pid)
    system.starts[pid] = startedBeforeReady ? ready.addingTimeInterval(-3) : ready.addingTimeInterval(60)
    system.lock = InstanceLockOwner(pid: pid, token: "t", startedAt: nil)
    try discovery.write(ServerDiscovery(port: .default, pid: pid, home: paths.defaultDataHome.path, startedAt: ready, version: "0"))
  }

  @Test func offersToStopAPreviousServerOfOurs() throws {
    try leavePreviousServer()
    let sut = controller()
    sut.launch()
    #expect(sut.previousServer?.pid == 900)
  }

  @Test func neverOffersARecycledPid() throws {
    try leavePreviousServer(startedBeforeReady: false)
    let sut = controller()
    sut.launch()
    #expect(sut.previousServer == nil, "that pid started after our server was ready, so it is another process")
  }

  @Test func neverOffersAServerOnAnotherDataFolder() throws {
    try leavePreviousServer()
    try discovery.write(ServerDiscovery(port: .default, pid: 900, home: "/elsewhere", startedAt: Date(timeIntervalSince1970: 2_000_000), version: "0"))
    let sut = controller()
    sut.launch()
    #expect(sut.previousServer == nil)
  }

  @Test func stoppingThePreviousServerThenStartsOurs() throws {
    try leavePreviousServer()
    let sut = controller()
    sut.launch()
    sut.stopPreviousServer()
    #expect(system.signals.map(\.signal) == [SIGTERM])
    #expect(system.signals.first?.pid == 900)
    #expect(sut.status.title == "Stopping the previous server (pid 900)…")
    #expect(sut.previousServer == nil)
    scheduler.advance(1)
    #expect(launcher.launched.isEmpty)
    system.alive.remove(900)
    system.lock = nil
    scheduler.advance(0.25)
    #expect(launcher.launched.count == 1)
    #expect(sut.state == .starting(pid: 100))
  }

  @Test func aPreviousServerIgnoringSigtermGetsSigkill() throws {
    try leavePreviousServer()
    let sut = controller()
    sut.launch()
    sut.stopPreviousServer()
    scheduler.advance(10.25)
    #expect(system.signals.map(\.signal) == [SIGTERM, SIGKILL])
    scheduler.advance(3)
    #expect(sut.status.title.hasPrefix("Error:"), "still alive after SIGKILL: give the menu back")
    #expect(launcher.launched.isEmpty)
  }

  @Test func processStartDateOfThisProcess() throws {
    let started = try #require(ProcessLiveness.startDate(getpid()))
    #expect(started <= Date())
    #expect(started > Date().addingTimeInterval(-24 * 3600))
    #expect(ProcessLiveness.startDate(-1) == nil)
  }
}

@MainActor
struct ServerAppStatusTests {
  let port = ServerPort.default

  @Test func eachStateHasItsWordsAndActions() {
    let since = Date()
    let cases: [(SupervisorState, String, ServerAppStatus.Kind, Bool, Bool, Bool)] = [
      (.stopped, "Stopped", .stopped, true, false, false),
      (.starting(pid: 1), "Starting on port 7420…", .busy, false, true, true),
      (.running(pid: 1, since: since), "Running on port 7420", .running, false, true, true),
      (.waitingToRestart(attempt: 2, at: since), "Crashed, restarting (attempt 2)", .busy, true, true, false),
      (.stopping(pid: 1), "Stopping…", .busy, false, false, false),
      (.failed("Port 7420 is already in use"), "Error: Port 7420 is already in use", .failed, true, false, false),
    ]
    for (state, title, kind, start, stop, restart) in cases {
      let status = ServerAppStatus(state: state, lastErrorLine: nil, port: port)
      #expect(status.title == title)
      #expect(status.kind == kind)
      #expect([status.canStart, status.canStop, status.canRestart] == [start, stop, restart], "\(state)")
    }
  }

  @Test func aServerErrorLineIsNotPrefixedTwice() {
    let status = ServerAppStatus(state: .failed("Error: listen EADDRINUSE: address already in use 127.0.0.1:7420"),
                                 lastErrorLine: nil, port: port)
    #expect(status.title == "Error: listen EADDRINUSE: address already in use 127.0.0.1:7420")
  }

  @Test func theErrorDetailIsNotRepeated() {
    let failed = ServerAppStatus(state: .failed("boom"), lastErrorLine: "boom", port: port)
    #expect(failed.detail == nil)
    let other = ServerAppStatus(state: .failed("Server exited with status 1"), lastErrorLine: "Error: boom", port: port)
    #expect(other.detail == "Error: boom")
    #expect(ServerAppStatus(state: .stopped, lastErrorLine: "old", port: port).detail == nil)
  }

  @Test func longLinesAreClippedToOneMenuLine() {
    let status = ServerAppStatus(state: .failed(String(repeating: "x", count: 500) + "\nsecond"), lastErrorLine: nil, port: port)
    #expect(status.title.count == ServerAppStatus.maxLineLength)
    #expect(status.title.hasSuffix("…"))
    #expect(!status.title.contains("second"))
  }
}

struct ServerAppSettingsTests {
  @Test func roundTripsAndKeepsDefaultsAbsent() throws {
    let defaults = MemorySettings()
    let store = ServerAppSettingsStore(defaults: defaults)
    #expect(store.load() == ServerAppSettings())
    let custom = ServerAppSettings(port: try #require(ServerPort(9000)), dataHome: URL(fileURLWithPath: "/tmp/hive", isDirectory: true))
    store.save(custom)
    #expect(store.load() == custom)
    store.save(ServerAppSettings())
    #expect(defaults.object(forKey: SettingsKey.port) == nil)
    #expect(defaults.object(forKey: SettingsKey.dataHome) == nil)
  }

  @Test func badStoredValuesFallBackToDefaults() throws {
    let defaults = MemorySettings()
    defaults.set(70000, forKey: SettingsKey.port)
    defaults.set("relative/path", forKey: SettingsKey.dataHome)
    #expect(ServerAppSettingsStore(defaults: defaults).load() == ServerAppSettings())
    defaults.set("7421", forKey: SettingsKey.port)
    #expect(ServerAppSettingsStore(defaults: defaults).load().port == .default, "a string is not a stored port")
  }

  @Test func launchSettingsUseTheDefaultFolderWhenUnset() {
    let paths = HivemindPaths(home: URL(fileURLWithPath: "/Users/me", isDirectory: true))
    #expect(ServerAppSettings().launchSettings(paths: paths).dataHome.path == "/Users/me/.hivemind")
  }

  @Test func abbreviatesTheHomeFolder() {
    let paths = HivemindPaths(home: URL(fileURLWithPath: "/Users/me", isDirectory: true))
    #expect(paths.abbreviated(URL(fileURLWithPath: "/Users/me/.hivemind")) == "~/.hivemind")
    #expect(paths.abbreviated(URL(fileURLWithPath: "/Users/me")) == "~")
    #expect(paths.abbreviated(URL(fileURLWithPath: "/Users/meme/x")) == "/Users/meme/x")
    #expect(paths.abbreviated(URL(fileURLWithPath: "/Volumes/Data/hive")) == "/Volumes/Data/hive")
  }
}

@MainActor
final class FakeLoginItem: LoginItemControlling {
  var status: LoginItemStatus
  var statusAfterRegister: LoginItemStatus = .enabled
  var failure: (any Error)?
  var openedSettings = 0

  init(status: LoginItemStatus) { self.status = status }

  func register() throws {
    if let failure { throw failure }
    status = statusAfterRegister
  }

  func unregister() throws {
    if let failure { throw failure }
    status = .disabled
  }

  func openSystemSettings() { openedSettings += 1 }
}

@MainActor
struct LoginItemToggleTests {
  @Test func turnsOnAndOff() {
    let item = FakeLoginItem(status: .disabled)
    #expect(LoginItemToggle.toggle(item) == .enabled)
    #expect(item.status == .enabled)
    #expect(LoginItemToggle.toggle(item) == .disabled)
    #expect(item.openedSettings == 0)
  }

  @Test func sendsTheUserToApproveIt() {
    let item = FakeLoginItem(status: .disabled)
    item.statusAfterRegister = .requiresApproval
    #expect(LoginItemToggle.toggle(item) == .needsApproval)
    #expect(item.openedSettings == 1)
    #expect(LoginItemToggle.toggle(item) == .needsApproval, "a pending approval is not unregistered")
    #expect(item.status == .requiresApproval)
    #expect(item.openedSettings == 2)
  }

  @Test func reportsFailures() {
    let item = FakeLoginItem(status: .disabled)
    item.failure = LaunchFailure()
    #expect(LoginItemToggle.toggle(item) == .failed("no such file"))
  }
}

struct CommandLineInstallerTests {
  let home: URL
  let paths: HivemindPaths
  let server = BundledServer(contents: URL(fileURLWithPath: "/Apps/Hivemind Server.app/Contents"))

  init() throws {
    home = try temporaryHome()
    paths = HivemindPaths(home: home)
  }

  var script: String { CommandLineTool.script(server: server, discoveryFile: paths.discoveryFile) }

  @Test func theUserFolderNeedsNoAdmin() {
    let plan = CommandLineInstaller(paths: paths).plan(for: paths.userCommandLineTool)
    #expect(plan == .init(destination: paths.userCommandLineTool, needsAdmin: false, existing: .none))
  }

  @Test func anUnwritableFolderNeedsAdmin() {
    let installer = CommandLineInstaller(paths: paths, isWritable: { _ in false })
    #expect(installer.plan(for: paths.systemCommandLineTool).needsAdmin)
  }

  @Test func writabilityIsCheckedWhereMkdirWouldStart() {
    let destination = home.appendingPathComponent("a/b/c/hivemind")
    #expect(CommandLineInstaller(paths: paths).nearestExistingFolder(of: destination).path == home.path)
  }

  @Test func installsExecutableAndRecognisesItsOwnScript() throws {
    let installer = CommandLineInstaller(paths: paths)
    try installer.installDirectly(script, at: paths.userCommandLineTool)
    let attributes = try FileManager.default.attributesOfItem(atPath: paths.userCommandLineTool.path)
    #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o755)
    #expect(try String(contentsOf: paths.userCommandLineTool, encoding: .utf8) == script)
    #expect(installer.plan(for: paths.userCommandLineTool).existing == .ours)
    try installer.installDirectly(script, at: paths.userCommandLineTool)
  }

  @Test func replacesALinkWithoutWritingThroughIt() throws {
    let fm = FileManager.default
    let target = home.appendingPathComponent("npm/hivemind.mjs")
    try fm.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data("#!/usr/bin/env node\n".utf8).write(to: target)
    try fm.createDirectory(at: paths.userCommandLineTool.deletingLastPathComponent(), withIntermediateDirectories: true)
    try fm.createSymbolicLink(at: paths.userCommandLineTool, withDestinationURL: target)
    let installer = CommandLineInstaller(paths: paths)
    #expect(installer.plan(for: paths.userCommandLineTool).existing == .other("a link to \(target.path)"))
    try installer.installDirectly(script, at: paths.userCommandLineTool)
    #expect(try String(contentsOf: target, encoding: .utf8) == "#!/usr/bin/env node\n", "the link's target is untouched")
    let type = try fm.attributesOfItem(atPath: paths.userCommandLineTool.path)[.type] as? FileAttributeType
    #expect(type == .typeRegular)
  }

  @Test func anotherFileIsReportedAsForeign() throws {
    try FileManager.default.createDirectory(at: paths.userCommandLineTool.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data("#!/bin/sh\necho mine\n".utf8).write(to: paths.userCommandLineTool)
    #expect(CommandLineInstaller(paths: paths).plan(for: paths.userCommandLineTool).existing == .other("a file"))
  }

  /// Runs the administrator command as the current user, as `do shell script` would run it as root.
  private func runAdminCommand(to destination: URL) throws -> Int32 {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/bin/sh")
    process.arguments = ["-c", CommandLineInstaller(paths: paths).adminInstallCommand(script: script, destination: destination)]
    try process.run()
    process.waitUntilExit()
    return process.terminationStatus
  }

  @Test func theAdminCommandCarriesTheScriptAndReadsNoFile() throws {
    let destination = home.appendingPathComponent("it's here/bin/hivemind")
    #expect(try runAdminCommand(to: destination) == 0)
    #expect(try String(contentsOf: destination, encoding: .utf8) == script)
    let mode = try FileManager.default.attributesOfItem(atPath: destination.path)[.posixPermissions] as? NSNumber
    #expect(mode?.intValue == 0o755)
    let left = try FileManager.default.contentsOfDirectory(atPath: destination.deletingLastPathComponent().path)
    #expect(left == ["hivemind"], "no temporary file is left behind")
    let source = CommandLineInstaller(paths: paths).adminAppleScript(script: script, destination: destination)
    #expect(source.hasPrefix("do shell script \"umask 022 && "))
    #expect(source.hasSuffix(" with administrator privileges"))
    #expect(!source.contains(paths.appSupport.path), "nothing is staged for root to read")
  }

  @Test func theAdminCommandReplacesALinkWithoutWritingThroughIt() throws {
    let fm = FileManager.default
    let target = home.appendingPathComponent("secret")
    try Data("keep\n".utf8).write(to: target)
    let destination = home.appendingPathComponent("bin/hivemind")
    try fm.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
    try fm.createSymbolicLink(at: destination, withDestinationURL: target)
    #expect(try runAdminCommand(to: destination) == 0)
    #expect(try String(contentsOf: target, encoding: .utf8) == "keep\n")
    #expect(try fm.attributesOfItem(atPath: destination.path)[.type] as? FileAttributeType == .typeRegular)
    #expect(try String(contentsOf: destination, encoding: .utf8) == script)
  }

  @Test func theAdminCommandRefusesAFolderAtTheDestination() throws {
    let destination = home.appendingPathComponent("bin/hivemind")
    try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
    #expect(try runAdminCommand(to: destination) != 0)
    #expect(try FileManager.default.contentsOfDirectory(atPath: destination.path).isEmpty)
    #expect(try FileManager.default.contentsOfDirectory(atPath: destination.deletingLastPathComponent().path) == ["hivemind"])
  }

  @Test func aFolderAtTheDestinationIsDescribedWithoutReadingIt() throws {
    try FileManager.default.createDirectory(at: paths.userCommandLineTool, withIntermediateDirectories: true)
    #expect(CommandLineInstaller(paths: paths).plan(for: paths.userCommandLineTool).existing == .other("not a regular file"))
  }

}
