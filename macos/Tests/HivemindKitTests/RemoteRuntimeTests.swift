import Foundation
import Testing
@testable import HivemindKit

// The remote runtime (docs/remote-hosts.md#remote-runtime) and the host connection end to end, with real processes
// but no real host: a fake `ssh` (FakeSSH) that runs the remote command with `sh -c` under a temp remote HOME, a fake
// Hivemind Server bundle (FakeBundle), the app's own SSHProcessRunner and FoundationProcessLauncher, and real tar.

@Suite("Remote runtime")
struct RemoteRuntimeTests {
  @Test func theVersionMustNameAFolderAndTheStampFollowsTheCopiedFiles() throws {
    let root = try temporaryHome()
    defer { try? FileManager.default.removeItem(at: root) }
    let bundle = try FakeBundle(in: root)
    for bad in ["", ".hidden", "-x", "1.0/../..", "1 0", String(repeating: "1", count: 65)] {
      #expect(RemoteRuntime(server: bundle.server, version: bad) == nil)
    }
    let runtime = try #require(RemoteRuntime(server: bundle.server, version: "9.9.9-beta.1+build"))
    #expect(runtime.remoteFolder == "Library/Application Support/Hivemind/remote/9.9.9-beta.1+build")
    #expect(runtime.stamp.hasPrefix("9.9.9-beta.1+build "))
    #expect(RemoteRuntime(server: bundle.server)?.version == "9.9.9", "the package's version")
    #expect(RemoteRuntime(server: nil) == nil)

    let before = runtime.stamp
    try Data("{\"changed\":true}".utf8).write(to: bundle.contents.appendingPathComponent("Resources/server/node_modules/zod/package.json"))
    #expect(RemoteRuntime(server: bundle.server, version: "9.9.9-beta.1+build")?.stamp == before,
            "a dependency's file is not walked: package-lock.json stands for them")
    try Data("console.log('rebuilt, longer')\n".utf8).write(to: bundle.contents.appendingPathComponent("Resources/server/bin/hivemind.mjs"))
    #expect(RemoteRuntime(server: bundle.server, version: "9.9.9-beta.1+build")?.stamp != before, "a rebuild is copied again")
  }

  @Test func aCheckReadsThePlatformThenTheStamp() throws {
    let root = try temporaryHome()
    defer { try? FileManager.default.removeItem(at: root) }
    let runtime = try #require(RemoteRuntime(server: try FakeBundle(in: root).server, version: "1.0.0"))
    #expect(runtime.check("hivemind-platform Darwin arm64\nhivemind-stamp \(runtime.stamp)\n") == .current)
    #expect(runtime.check("Welcome!\nhivemind-platform Darwin arm64\nhivemind-stamp \(runtime.stamp)\nBye\n") == .current,
            "lines the host's shell startup files print are ignored")
    #expect(runtime.check("hivemind-platform Darwin arm64\nhivemind-stamp \n") == .outdated)
    #expect(runtime.check("hivemind-platform Darwin arm64\nhivemind-stamp 1.0.0 0000000000000000\n") == .outdated)
    #expect(runtime.check("hivemind-platform Darwin x86_64\nhivemind-stamp \(runtime.stamp)\n") == .unsupported("Darwin x86_64"))
    #expect(runtime.check("hivemind-platform Linux aarch64\n") == .unsupported("Linux aarch64"))
    #expect(runtime.check("Darwin arm64\n") == .unsupported("unknown"))
    #expect(runtime.check("") == .unsupported("unknown"))
  }
}

@Suite("Remote runtime over a fake ssh")
@MainActor struct RemoteRuntimeOverSSHTests {
  let ssh: FakeSSH
  let bundle: FakeBundle

  init() throws {
    ssh = try FakeSSH()
    bundle = try FakeBundle(in: ssh.root)
  }

  private func runtime(version: String = "9.9.9", platform: String = localPlatform()) -> RemoteRuntime? {
    RemoteRuntime(server: bundle.server, version: version, platform: platform)
  }

  private func installer(_ transport: SSHTransport, version: String = "9.9.9", platform: String = localPlatform()) -> RemoteRuntimeInstaller {
    let runtime = runtime(version: version, platform: platform)
    return RemoteRuntimeInstaller(runtime: { runtime }, transport: transport, runner: SSHProcessRunner(),
                                  temporaryFolder: ssh.root)
  }

  private func connection(_ transport: SSHTransport, installer: RemoteRuntimeInstaller) -> HostConnection {
    HostConnection(host: fakeHost, transport: transport, launcher: FoundationProcessLauncher(), runner: SSHProcessRunner(),
                   scheduler: MainQueueScheduler(), installer: installer, agentPort: ServerPort(7422)!)
  }

  private func remote(_ path: String) -> URL { ssh.remoteHome.appendingPathComponent(path) }

  private func mode(_ url: URL) throws -> Int {
    try FileManager.default.attributesOfItem(atPath: url.path)[.posixPermissions] as! Int
  }

  @Test func aConnectionComesUpOverTheMasterAndInstallsTheRuntimeOnceThenStops() async throws {
    defer { ssh.remove() }
    let transport = ssh.transport()
    let connection = connection(transport, installer: installer(transport))
    connection.start()
    #expect(await eventually { connection.isReady }, "state \(connection.state), runtime \(connection.runtime)")

    let folder = remote("Library/Application Support/Hivemind/remote/9.9.9")
    #expect(FileManager.default.isExecutableFile(atPath: folder.appendingPathComponent("node").path))
    #expect(try String(contentsOf: folder.appendingPathComponent("server/bin/hivemind.mjs"), encoding: .utf8) == "console.log('hivemind')\n")
    #expect(FileManager.default.fileExists(atPath: folder.appendingPathComponent("server/node_modules/zod/package.json").path))
    #expect(try String(contentsOf: folder.appendingPathComponent("tmux.conf"), encoding: .utf8) == TmuxCommand.configText)
    #expect(try String(contentsOf: folder.appendingPathComponent("runtime.stamp"), encoding: .utf8) == runtime()!.stamp + "\n")
    #expect(try mode(remote("Library/Application Support/Hivemind")) == 0o700)
    #expect(try mode(folder) == 0o700)
    let leftovers = try FileManager.default.contentsOfDirectory(atPath: folder.deletingLastPathComponent().path)
    #expect(leftovers == ["9.9.9"], "no unfinished copy is left")
    #expect(!FileManager.default.fileExists(atPath: folder.appendingPathComponent("._node").path), "no macOS metadata")

    let master = try #require(ssh.calls().first { $0.hasPrefix("-N ") })
    #expect(master.hasSuffix("-R 127.0.0.1:7422:127.0.0.1:7422 -R 1080 -L 5432:db.internal:5432 user@mini.local"))
    #expect(ssh.installs() == 1)

    // A new connection checks the stamp and copies nothing.
    connection.reconnect()
    #expect(await eventually { connection.isReady && ssh.calls().filter { $0.hasPrefix("-N ") }.count == 2 })
    #expect(ssh.installs() == 1, "the runtime is current: nothing is copied again")

    var stopped = false
    connection.stop { stopped = true }
    #expect(await eventually { stopped })
    #expect(connection.state == .stopped)
    #expect(!FileManager.default.fileExists(atPath: transport.controlPath(for: fakeHost).path), "the master removed its socket")
  }

  @Test func aNewVersionReplacesTheRuntimeAndKeepsOnlyTheNewestOlderOne() async throws {
    defer { ssh.remove() }
    let transport = ssh.transport()
    for version in ["1.0.0", "1.1.0", "1.2.0"] {
      let outcome = await installer(transport, version: version).ensure(on: fakeHost, installing: {})
      #expect(throws: Never.self) { try outcome.get() }
      // ls -t sorts by modification time, which a fast run can leave equal.
      try await Task.sleep(for: .milliseconds(1100))
    }
    let base = remote("Library/Application Support/Hivemind/remote")
    #expect(try FileManager.default.contentsOfDirectory(atPath: base.path).sorted() == ["1.1.0", "1.2.0"])

    // The same version with other files is copied again, in place.
    try Data("console.log('rebuilt, longer')\n".utf8).write(to: bundle.contents.appendingPathComponent("Resources/server/bin/hivemind.mjs"))
    var copied = false
    let outcome = await installer(transport, version: "1.2.0").ensure(on: fakeHost, installing: { copied = true })
    #expect(throws: Never.self) { try outcome.get() }
    #expect(copied)
    #expect(try String(contentsOf: base.appendingPathComponent("1.2.0/server/bin/hivemind.mjs"), encoding: .utf8)
      == "console.log('rebuilt, longer')\n")
    #expect(ssh.installs() == 4)
  }

  @Test func aHostOnAnotherPlatformGetsNoCopy() async throws {
    defer { ssh.remove() }
    let outcome = await installer(ssh.transport(), platform: "Darwin ppc").ensure(on: fakeHost, installing: {})
    #expect(throws: BrokerFiles.Failure("The host reports \(localPlatform()); the remote runtime runs on Darwin ppc only")) {
      try outcome.get()
    }
    #expect(ssh.installs() == 0)
  }

  @Test func anUnbundledAppSaysSoAndRunsNothing() async throws {
    defer { ssh.remove() }
    let installer = RemoteRuntimeInstaller(runtime: { nil }, transport: ssh.transport(), runner: SSHProcessRunner())
    let outcome = await installer.ensure(on: fakeHost, installing: {})
    #expect(throws: BrokerFiles.Failure(RemoteRuntimeInstaller.unbundled)) { try outcome.get() }
    #expect(ssh.calls().isEmpty)
  }

  @Test func aRefusedLoginIsOfflineWithSshsReason() async throws {
    defer { ssh.remove() }
    let transport = ssh.transport(fail: "user@mini.local: Permission denied (publickey).")
    let connection = connection(transport, installer: installer(transport))
    connection.start()
    #expect(await eventually {
      if case .waitingToReconnect(1, _, "user@mini.local: Permission denied (publickey).") = connection.state { true } else { false }
    }, "\(connection.state)")
    connection.stop()
    #expect(connection.state == .stopped)
  }

  @Test func theRunnerFeedsTheInputToTheCommandAndReportsAFailedInput() async throws {
    defer { ssh.remove() }
    let runner = SSHProcessRunner()
    let cat = LaunchSpec(executable: URL(fileURLWithPath: "/bin/cat"), arguments: [], environment: [:])
    let echo = LaunchSpec(executable: URL(fileURLWithPath: "/bin/echo"), arguments: ["piped"], environment: [:])
    #expect(await runner.run(cat, input: echo, timeout: 10) == SSHResult(status: 0, stdout: "piped\n"))
    #expect(await runner.run(cat, input: nil, timeout: 10) == SSHResult(status: 0), "no input is an empty stdin")
    let failing = LaunchSpec(executable: URL(fileURLWithPath: "/usr/bin/false"), arguments: [], environment: [:])
    let result = await runner.run(cat, input: failing, timeout: 10)
    #expect(result.status == SSHResult.launchFailed)
    #expect(result.reason == "The archive could not be written (false exited with status 1)")
    let sleeper = LaunchSpec(executable: URL(fileURLWithPath: "/bin/sleep"), arguments: ["30"], environment: [:])
    let started = Date()
    let slow = await runner.run(sleeper, input: nil, timeout: 1)
    #expect(Date().timeIntervalSince(started) < 10)
    #expect(slow.status == SSHResult.launchFailed && slow.reason == "Timed out after 1 s")
    let missing = LaunchSpec(executable: ssh.root.appendingPathComponent("no-ssh"), arguments: [], environment: [:])
    #expect(await runner.run(missing, input: nil, timeout: 1).status == SSHResult.launchFailed)
  }
}
