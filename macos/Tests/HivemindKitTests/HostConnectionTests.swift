import Foundation
import Testing
@testable import HivemindKit

// The host connection (docs/remote-hosts.md#host-connection) on fakes: the ssh command lines, then the supervised
// master's states on a FakeLauncher, a FakeScheduler and FakeSSHRunner. Nothing runs ssh.

@Suite("SSH transport")
struct SSHTransportTests {
  let transport = SSHTransport(environment: ["PATH": "/usr/bin:/bin"], controlFolder: URL(fileURLWithPath: "/private/ssh"))

  @Test func theMasterCarriesTheAgentForwardThenTheHostsForwardsVerbatimAndTheDestinationLast() {
    let spec = transport.masterSpec(fakeHost, agentPort: ServerPort(7422)!, remoteAgentPort: ServerPort(7423)!)
    let socket = transport.controlPath(for: fakeHost).path
    #expect(spec.executable.path == "/usr/bin/ssh")
    #expect(spec.arguments == [
      "-N", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-S", socket,
      "-o", "ControlMaster=yes", "-o", "ControlPersist=no",
      "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-o", "ConnectTimeout=10",
      "-o", "ExitOnForwardFailure=yes",
      "-R", "127.0.0.1:7423:127.0.0.1:7422",
      "-R", "1080", "-L", "5432:db.internal:5432",
      "user@mini.local",
    ])
    #expect(spec.environment == ["PATH": "/usr/bin:/bin"])
  }

  @Test func everyOtherCommandReusesTheMastersSocketInBatchMode() {
    let socket = transport.controlPath(for: fakeHost).path
    let common = ["-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-S", socket]
    #expect(transport.checkSpec(fakeHost).arguments == common + ["-O", "check", "user@mini.local"])
    #expect(transport.exitSpec(fakeHost).arguments == common + ["-O", "exit", "user@mini.local"])
    #expect(transport.commandSpec(fakeHost, command: "uname -m").arguments
      == common + ["-o", "ControlMaster=no", "-T", "user@mini.local", "uname -m"])
  }

  @Test func theControlSocketIsShortFixedPerHostAndPrivate() throws {
    let path = transport.controlPath(for: fakeHost)
    #expect(path.deletingLastPathComponent().path == "/private/ssh")
    #expect(path.lastPathComponent.count == 16)
    #expect(path == transport.controlPath(for: fakeHost))
    let other = RemoteHost(id: "20000000-0000-4000-8000-000000000002", label: "Other", ssh: "user@mini.local")
    #expect(transport.controlPath(for: other) != path)

    let home = URL(fileURLWithPath: "/Users/h")
    #expect(SSHTransport.controlFolder(paths: HivemindPaths(home: home)) == HivemindPaths(home: home).hostSockets)
    let long = URL(fileURLWithPath: "/Users/" + String(repeating: "a", count: 60))
    #expect(SSHTransport.controlFolder(paths: HivemindPaths(home: long)).path == "/tmp/hivemind-ssh-\(getuid())",
            "a socket that would not fit in a sockaddr_un moves to a private /tmp folder")
  }

  @Test func theReasonIsSshsLastLineWorthShowing() {
    #expect(SSHTransport.reason(in: ["debug1: x", "user@mini.local: Permission denied (publickey).", "", "  "])
      == "user@mini.local: Permission denied (publickey).")
    #expect(SSHTransport.reason(in: ["", "debug1: only"]) == nil)
    #expect(SSHTransport.reason(in: [String(repeating: "x", count: 300)])?.count == 200)
  }
}

@Suite("Host connection")
@MainActor struct HostConnectionTests {
  let launcher = FakeLauncher()
  let scheduler = FakeScheduler()
  let runner = FakeSSHRunner()
  let installer = FakeInstaller()
  let folder: URL

  init() throws { folder = try temporaryHome().appendingPathComponent("ssh") }

  func connection(backoff: BackoffPolicy = HostConnection.backoff) -> HostConnection {
    HostConnection(host: fakeHost, transport: SSHTransport(environment: [:], controlFolder: folder), launcher: launcher,
                   runner: runner, scheduler: scheduler, installer: installer, agentPort: ServerPort(7422)!, backoff: backoff)
  }

  /// Waits for the steps in flight, runs what is due in `seconds`, then waits for the steps that started.
  func advance(_ connection: HostConnection, _ seconds: TimeInterval) async {
    await connection.settle()
    scheduler.advance(seconds)
    await connection.settle()
  }

  @Test func aStartClearsAnOldMasterThenLaunchesOneAndIsOnlineOnceItAnswersThenChecksTheRuntime() async throws {
    let connection = connection()
    runner.failingChecks = 1
    connection.start()
    #expect(connection.state == .connecting)
    await connection.settle()
    #expect(runner.kinds == ["exit"], "a master a crashed app left behind is asked to exit first")
    #expect(launcher.specs.count == 1)
    #expect(launcher.specs[0].arguments.first == "-N")
    #expect(launcher.specs[0].arguments.suffix(5) == ["-R", "1080", "-L", "5432:db.internal:5432", "user@mini.local"])
    #expect(FileManager.default.fileExists(atPath: folder.path), "the control folder is made, private")
    await advance(connection, HostConnection.checkInterval)
    #expect(connection.state == .connecting, "the first check fails: not up yet")
    await advance(connection, HostConnection.checkInterval)
    guard case .online = connection.state else { Issue.record("not online: \(connection.state)"); return }
    #expect(runner.kinds == ["exit", "check", "check"])
    #expect(installer.ensured == [fakeHost.id])
    #expect(connection.runtime == .ready)
    #expect(connection.isReady)
  }

  @Test func aMasterThatExitsIsOfflineWithSshsReasonAndReconnectsWithBackoff() async throws {
    let connection = connection()
    connection.start()
    await connection.settle()
    launcher.current?.say("user@mini.local: Permission denied (publickey).")
    launcher.current?.crash(status: 255)
    #expect(connection.state == .waitingToReconnect(attempt: 1, at: scheduler.clock.addingTimeInterval(2),
                                                    reason: "user@mini.local: Permission denied (publickey)."))
    #expect(connection.lastError == "user@mini.local: Permission denied (publickey).")
    #expect(!connection.isReady)
    await advance(connection, 2)
    #expect(launcher.launched.count == 2, "a new master after 2 s")
    launcher.current?.crash(status: 255)
    #expect(connection.state == .waitingToReconnect(attempt: 2, at: scheduler.clock.addingTimeInterval(4), reason: "ssh exited with status 255"))
    await advance(connection, 4)
    launcher.current?.crash(status: 255)
    guard case .waitingToReconnect(3, let at, _) = connection.state else { Issue.record("\(connection.state)"); return }
    #expect(at == scheduler.clock.addingTimeInterval(8))
  }

  @Test func theBackoffNeverGivesUpAndAStableConnectionResetsIt() async throws {
    let connection = connection()
    connection.start()
    await connection.settle()
    for _ in 0..<12 {
      launcher.current?.crash(status: 255)
      await advance(connection, 60)
    }
    #expect(launcher.launched.count == 13, "a host that sleeps comes back on its own")
    await advance(connection, HostConnection.checkInterval)
    #expect(connection.state.isOnline)
    scheduler.advance(31)
    launcher.current?.crash(status: 255)
    guard case .waitingToReconnect(1, _, _) = connection.state else { Issue.record("\(connection.state)"); return }
  }

  @Test func aMasterThatNeverAnswersIsEndedAndCountsAsAFailedConnection() async throws {
    let connection = connection()
    runner.failingChecks = .max
    connection.start()
    await connection.settle()
    for _ in 0..<Int(HostConnection.connectTimeout / HostConnection.checkInterval) + 1 {
      await advance(connection, HostConnection.checkInterval)
    }
    #expect(launcher.current?.terminated == 1)
    guard case .waitingToReconnect(1, _, let reason) = connection.state else { Issue.record("\(connection.state)"); return }
    #expect(reason == "The connection did not come up within 30 s")
  }

  @Test func aStopEndsTheMasterAndNothingReconnects() async throws {
    let connection = connection()
    connection.start()
    await advance(connection, HostConnection.checkInterval)
    #expect(connection.state.isOnline)
    var stopped = false
    connection.stop { stopped = true }
    #expect(stopped && connection.state == .stopped)
    #expect(launcher.current?.terminated == 1)
    await advance(connection, 120)
    #expect(launcher.launched.count == 1)
    #expect(connection.runtime == .unknown)
  }

  @Test func reconnectReplacesTheMasterAtOnce() async throws {
    let connection = connection()
    connection.start()
    await advance(connection, HostConnection.checkInterval)
    connection.reconnect()
    await advance(connection, HostConnection.checkInterval)
    #expect(launcher.launched.count == 2)
    #expect(launcher.launched[0].terminated == 1)
    #expect(connection.state.isOnline)
  }

  @Test func aRuntimeThatFailsLeavesTheHostOnlineButNotReady() async throws {
    let connection = connection()
    installer.outcome = .failure(.init("Install failed: tar: Error"))
    installer.installs = true
    var states: [RemoteRuntimeState] = []
    connection.onChange = { if states.last != connection.runtime { states.append(connection.runtime) } }
    connection.start()
    await advance(connection, HostConnection.checkInterval)
    #expect(connection.state.isOnline)
    #expect(connection.runtime == .failed("Install failed: tar: Error"))
    #expect(states.suffix(3) == [.checking, .installing, .failed("Install failed: tar: Error")])
    #expect(!connection.isReady)
    #expect(HostStatus(connection, now: scheduler.now()).title == "Build Mac — online, runtime failed")
  }

  @Test func theMenuSaysWhereEachHostIs() async throws {
    let connection = connection()
    #expect(HostStatus(connection, now: scheduler.now()).title == "Build Mac — off")
    connection.start()
    #expect(HostStatus(connection, now: scheduler.now()).title == "Build Mac — connecting…")
    await connection.settle()
    launcher.current?.say("Error: remote port forwarding failed for listen port 7422")
    launcher.current?.crash(status: 255)
    let offline = HostStatus(connection, now: scheduler.now())
    #expect(offline.title == "Build Mac — offline")
    #expect(offline.detail == "Error: remote port forwarding failed for listen port 7422. Retrying in 2 s.")
    await advance(connection, 2)
    await advance(connection, HostConnection.checkInterval)
    #expect(HostStatus(connection, now: scheduler.now()).title == "Build Mac — online")
  }
}
