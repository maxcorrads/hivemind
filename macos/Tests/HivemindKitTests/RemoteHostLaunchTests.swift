import Foundation
import Testing
@testable import HivemindKit

// Launch on a host (docs/remote-hosts.md#launch), end to end on this Mac: the broker runs its host scripts through the
// fake `ssh` (FakeSSH), which runs each one with `sh -c` under a temp remote HOME, and the host's tmux is a fake one in
// the temp folder (FakeRemoteTmux): no real host, tmux server, login or home is ever reached.

private let atlas = SessionName("hm-acme-atlas")!
private let thread = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0"
private let runtimeFolder = "Library/Application Support/Hivemind/remote/9.9.9"

/// A tmux in the fake host's files: its sessions in `~/.fake-tmux/sessions` (list-sessions' lines), the script each
/// new session would run in `~/.fake-tmux/script-<name>`, and every call in `~/.fake-tmux/calls`. Its attach-session
/// prints the session and TERM, then echoes one line typed into it.
private let fakeTmuxScript = #"""
  #!/bin/sh
  state="$HOME/.fake-tmux"
  mkdir -p "$state"
  printf '%s\n' "$*" >> "$state/calls"
  [ "$1" = -u ] && shift
  [ "$1" = -L ] && shift 2
  if [ "$1" = -f ]; then printf '%s\n' "$2" > "$state/conf"; shift 2; fi
  command=$1; shift
  target() { while [ $# -gt 0 ]; do if [ "$1" = -t ]; then printf '%s' "${2#=}"; return; fi; shift; done; }
  case $command in
    list-sessions)
      [ -f "$state/sessions" ] || { echo "no server running on /private/tmp/tmux-501/hivemind" >&2; exit 1; }
      cat "$state/sessions"; exit 0 ;;
    has-session)
      name=$(target "$@")
      grep -q "^$name|" "$state/sessions" 2>/dev/null && exit 0
      echo "can't find session: $name" >&2; exit 1 ;;
    attach-session)
      name=$(target "$@")
      grep -q "^$name|" "$state/sessions" 2>/dev/null || { echo "can't find session: $name" >&2; exit 1; }
      printf 'attached %s TERM=%s\n' "$name" "$TERM"
      IFS= read -r line && printf 'typed %s\n' "$line"
      exit 0 ;;
    kill-session)
      name=$(target "$@")
      if grep -q "^$name|" "$state/sessions" 2>/dev/null; then
        grep -v "^$name|" "$state/sessions" > "$state/next"; mv "$state/next" "$state/sessions"; exit 0
      fi
      echo "can't find session: $name" >&2; exit 1 ;;
    new-session)
      name= project= agent= script=
      while [ $# -gt 0 ]; do
        case $1 in
          -s) name=$2; shift 2 ;;
          -lic) script=$2; shift 2 ;;
          @hivemind_project) project=$2; shift 2 ;;
          @hivemind_agent) agent=$2; shift 2 ;;
          *) shift ;;
        esac
      done
      if grep -q "^$name|" "$state/sessions" 2>/dev/null; then echo "duplicate session: $name" >&2; exit 1; fi
      printf '%s|1700000000|0|0|%s|%s\n' "$name" "$project" "$agent" >> "$state/sessions"
      printf '%s' "$script" > "$state/script-$name"
      exit 0 ;;
  esac
  echo "unknown command: $command" >&2
  exit 1
  """#

/// The broker's hosts over the fake ssh: each script runs as HostsService runs it, `RemoteRuntime.remote` over the
/// host's `commandSpec`, with SSHProcessRunner.
@MainActor
private final class ShellHosts: BrokerRemoteHosts {
  let ssh: FakeSSH
  var hosts: [BrokerRemoteHost]
  var scripts: [String] = []

  init(ssh: FakeSSH, hosts: [BrokerRemoteHost]) {
    self.ssh = ssh
    self.hosts = hosts
  }

  var brokerHosts: [BrokerRemoteHost] { hosts }

  func run(onHost id: String, script: String, stdin: Data, timeout: TimeInterval) async -> SSHResult {
    scripts.append(script)
    return await SSHProcessRunner().run(ssh.transport().commandSpec(fakeHost, command: RemoteRuntime.remote(script)),
                                        stdin: stdin, timeout: timeout)
  }

  func terminalSpec(onHost id: String, command: String) -> LaunchSpec? {
    hosts.contains { $0.id == id } ? ssh.transport().terminalSpec(fakeHost, command: command) : nil
  }
}

/// A broker with one host, Build Mac, whose home is FakeSSH's remote home, and a project folder there.
@MainActor
private struct RemoteFixture {
  let ssh: FakeSSH
  let hosts: ShellHosts
  let h = BrokerHarness()
  let tmuxPath: String

  init(ready: Bool = true, hosts count: Int = 1) throws {
    ssh = try FakeSSH()
    tmuxPath = ssh.root.appendingPathComponent("bin/fake-tmux").path
    try Data(fakeTmuxScript.utf8).write(to: URL(fileURLWithPath: tmuxPath))
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: tmuxPath)
    hosts = ShellHosts(ssh: ssh, hosts: count == 0 ? [] : [
      BrokerRemoteHost(id: fakeHost.id, label: fakeHost.label, ready: ready, runtimeFolder: runtimeFolder)])
    try FileManager.default.createDirectory(atPath: project, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(atPath: support, withIntermediateDirectories: true)
    h.remoteHosts = hosts
    h.remoteTmux = RemoteTmuxLookup(candidates: [tmuxPath], searchPath: false)
  }

  var home: String { ssh.remoteHome.path }
  var project: String { home + "/acme" }
  var support: String { home + "/Library/Application Support/Hivemind" }
  var secrets: String { support + "/launch-secrets" }
  var state: String { home + "/.fake-tmux" }

  func launch(_ agent: String? = "Atlas", cwd: String? = nil, command: String = "codex", secrets: LaunchSecrets? = nil,
              environment: LaunchEnvironment? = nil, account: LaunchAccount? = nil, host: String? = fakeHost.id) throws -> BrokerLaunch {
    try BrokerLaunch(project: "acme", agent: agent, title: "Acme - \(agent ?? "new")", cwd: cwd ?? project, command: command,
                     secrets: secrets, environment: environment, account: account, host: host)
  }

  /// The host's launch files.
  func launchFiles() -> [String] {
    ((try? FileManager.default.contentsOfDirectory(atPath: secrets)) ?? []).sorted().map { secrets + "/" + $0 }
  }

  func read(_ path: String) -> String? { try? String(contentsOfFile: path, encoding: .utf8) }

  func seed(_ lines: [String]) throws {
    try FileManager.default.createDirectory(atPath: state, withIntermediateDirectories: true)
    try Data((lines.joined(separator: "\n") + "\n").utf8).write(to: URL(fileURLWithPath: state + "/sessions"))
  }

  func remove() { ssh.remove() }
}

private func mode(_ path: String) -> mode_t {
  var info = stat()
  return lstat(path, &info) == 0 ? info.st_mode & 0o7777 : 0
}

/// A git repository with one commit, for a host to clone; git runs with a home of its own, so no user config applies.
private func makeOrigin(at path: String) throws {
  for arguments in [["init", "--quiet", path], ["-C", path, "-c", "user.name=Test", "-c", "user.email=test@example.com",
                                                "-c", "commit.gpgsign=false", "commit", "--quiet", "--allow-empty", "-m", "first"]] {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
    process.arguments = arguments
    process.environment = ["PATH": "/usr/bin:/bin", "HOME": (path as NSString).deletingLastPathComponent, "GIT_CONFIG_NOSYSTEM": "1"]
    process.standardOutput = FileHandle.nullDevice
    process.standardError = FileHandle.nullDevice
    try process.run()
    process.waitUntilExit()
    try #require(process.terminationStatus == 0)
  }
}

@MainActor
@Suite(.serialized)
struct RemoteHostLaunchTests {
  @Test func aLaunchOnAHostRunsThereWithItsVariablesOnStdinOnly() async throws {
    let r = try RemoteFixture()
    defer { r.remove() }
    await r.h.start()
    let (transport, connection) = await r.h.client()
    let launch = try r.launch(secrets: LaunchSecrets(["OPENCODE_API_KEY": "sk-secret-value"]),
                              environment: LaunchEnvironment(["TASK_ENV": "env-value"]))
    await r.h.send(connection, .launch([launch]), id: "go")
    #expect(transport.take().first == BrokerEventFrame(id: "go", .launched(names: [atlas], created: [atlas], errors: [])))
    #expect(r.h.tmux.calls("new-session").isEmpty, "nothing starts on this Mac")

    // The launch file: on the host, 0600, written from stdin; its values are on no command line.
    let files = r.launchFiles()
    try #require(files.count == 1)
    #expect(r.read(files[0]) == "TASK_ENV=env-value\nOPENCODE_API_KEY=sk-secret-value\n")
    #expect(mode(files[0]) == 0o600)
    #expect(mode(r.secrets) == 0o700)
    let argv = r.ssh.calls().joined(separator: "\n")
    #expect(!argv.contains("sk-secret-value") && !argv.contains("env-value"))
    #expect(!r.hosts.scripts.joined().contains("sk-secret-value"))
    // The same TmuxCommand, with the host's tmux and its runtime's config; the script loads and deletes that file.
    let script = try #require(r.read(r.state + "/script-hm-acme-atlas"))
    #expect(script == TmuxCommand.script(cwd: r.project, command: "codex", environmentFile: LaunchEnvironmentFile(path: files[0])))
    #expect(r.read(r.state + "/conf") == r.home + "/" + runtimeFolder + "/tmux.conf\n")

    // Listed with its host.
    await r.h.send(connection, .sessionsList, id: "list")
    #expect(transport.take().first == BrokerEventFrame(id: "list", .sessions([BrokerSession(
      name: atlas, project: "acme", agent: "Atlas", alive: true, attached: 0, createdAt: 1_700_000_000_000, host: fakeHost.id)])))
  }

  @Test func namesAreUniqueAcrossHostsAndARunningAgentIsReusedWhereItRuns() async throws {
    let r = try RemoteFixture()
    defer { r.remove() }
    try r.seed(["hm-acme-new-1|1700000000|0|0|acme|", "hm-acme-atlas|1700000000|0|0|acme|Atlas"])
    await r.h.start()
    let (transport, connection) = await r.h.client()
    // Two launches on this Mac: the new agent skips the host's new-1, and Atlas runs on the host already.
    await r.h.send(connection, .launch([brokerLaunch(nil), brokerLaunch("Atlas")]))
    let second = SessionName("hm-acme-new-2")!
    #expect(transport.events().first == .launched(names: [second, atlas], created: [second], errors: []))
    #expect(r.h.tmux.calls("new-session").count == 1)
    // And a new agent on the host takes the next free number there too.
    await r.h.send(connection, .launch([try r.launch(nil)]))
    #expect(transport.events().first == .launched(names: [SessionName("hm-acme-new-3")!], created: [SessionName("hm-acme-new-3")!], errors: []))
  }

  @Test func aHostWithoutTheProjectClonesItFromThisMacsOrigin() async throws {
    let r = try RemoteFixture()
    defer { r.remove() }
    let origin = r.ssh.root.appendingPathComponent("origin repo").path
    try makeOrigin(at: origin)
    let target = r.home + "/work/acme"
    r.h.origins[target] = origin
    let missing = r.home + "/work/gone"
    r.h.origins[missing] = r.ssh.root.appendingPathComponent("no such repo").path
    await r.h.start()
    let (transport, connection) = await r.h.client()
    await r.h.send(connection, .launch([try r.launch(cwd: target), try r.launch("Bea", cwd: missing),
                                        try r.launch("Cy", cwd: r.home + "/nowhere")]))
    guard case .launched(let names, let created, let errors) = transport.events().first else { Issue.record("no answer"); return }
    #expect(names == [atlas, nil, nil])
    #expect(created == [atlas])
    #expect(FileManager.default.fileExists(atPath: target + "/.git"), "cloned at the same path")
    #expect(errors.count == 2)
    #expect(errors.first?.message.hasPrefix("launches[1].cwd: cannot clone the project into `\(missing)` on Build Mac: ") == true)
    #expect(errors.last == BrokerLaunchFailure(index: 2, code: .cwdMissing,
      message: "launches[2].cwd: not a folder on Build Mac, and this Mac's copy has no origin to clone it from"))
    // The origin went on stdin, never into a script.
    #expect(!r.hosts.scripts.joined().contains(origin))
  }

  @Test func aHostSessionAttachesInAStreamOverTheMasterAndIsKilledThere() async throws {
    let r = try RemoteFixture()
    defer { r.remove() }
    try r.seed(["hm-acme-atlas|1700000000|0|0|acme|Atlas"])
    await r.h.start()
    let (transport, connection) = await r.h.client()
    await r.h.send(connection, .sessionsList)
    _ = transport.take()
    await r.h.send(connection, .attach(session: atlas, size: TerminalSize(columns: 120, rows: 40)!), id: "a")
    #expect(transport.take() == [BrokerEventFrame(id: "a", .attached(stream: 1, session: atlas))])
    let terminal = try #require(r.h.spawner.terminals.first)
    let spec = terminal.spec
    // The PTY runs ssh -tt over the host's master to the host's tmux and its runtime's tmux.conf.
    let tmux = TmuxCommand(executable: r.tmuxPath, configPath: "\(r.home)/\(runtimeFolder)/tmux.conf")
    let remote = RemoteRuntime.remote(tmux.attachShellLine(atlas))
    #expect(spec.executable == r.ssh.executable.path)
    #expect(spec.arguments == r.ssh.transport().terminalSpec(fakeHost, command: remote).arguments)
    #expect(Array(spec.arguments.suffix(7)) == ["-o", "LogLevel=ERROR", "-e", "none", "-tt", "user@mini.local", remote])
    #expect(spec.size == TerminalSize(columns: 120, rows: 40))
    #expect(spec.environment["TERM"] == "xterm-256color")
    #expect(spec.environment["TMUX"] == nil)
    #expect(r.h.tmux.calls("has-session").isEmpty, "this Mac's tmux is never asked")
    #expect(r.read(r.state + "/calls")?.contains("has-session -t =hm-acme-atlas") == true, "the host is, first")

    // Its frames are a local stream's: output batched, input passed through as typed.
    terminal.print("hello from the host")
    await r.h.advance(BrokerLimits.outputBatchInterval)
    #expect(transport.events() == [.output(stream: 1, data: Data("hello from the host".utf8))])
    await r.h.send(connection, .input(stream: 1, data: Data("~.\r".utf8)))
    #expect(terminal.input == [Data("~.\r".utf8)])

    // What the PTY runs reaches the host's attach-session, through the fake ssh.
    let ran = await SSHProcessRunner().run(LaunchSpec(executable: URL(fileURLWithPath: spec.executable), arguments: spec.arguments,
                                                      environment: spec.environment), stdin: Data("whoami\n".utf8), timeout: 20)
    #expect(ran.status == 0)
    #expect(ran.stdout == "attached hm-acme-atlas TERM=xterm-256color\ntyped whoami\n")
    #expect(r.read(r.state + "/calls")?.contains("-u -L hivemind -f \(r.home)/\(runtimeFolder)/tmux.conf attach-session -t =hm-acme-atlas") == true)
    #expect(r.ssh.calls().last?.contains("-o LogLevel=ERROR -e none -tt user@mini.local") == true)

    // Detaching ends ssh, as it ends tmux attach here; the session runs on, and a kill ends it on its host.
    await r.h.send(connection, .detach(stream: 1), id: "d")
    #expect(terminal.terminated == 1)
    #expect(transport.take() == [BrokerEventFrame(id: "d", .exit(stream: 1, status: nil))])
    await r.h.send(connection, .kill(session: atlas), id: "k")
    #expect(transport.take().first == BrokerEventFrame(id: "k", .killed(session: atlas)))
    #expect(r.read(r.state + "/sessions") == "", "killed on the host")
    #expect(r.h.tmux.calls("kill-session").isEmpty, "never on this Mac")
    await r.h.send(connection, .kill(session: atlas), id: "again")
    #expect(transport.take().first.map { errorCode($0.event) } == .noSuchSession)
  }

  @Test func aHostSessionNotListedYetIsFoundThereAndOneThatEndedIsNoSuchSession() async throws {
    let r = try RemoteFixture()
    defer { r.remove() }
    await r.h.start()
    let (transport, connection) = await r.h.client()
    // Started on the host since its last list: this Mac's tmux has no such session, so the hosts are listed again and
    // it is found there.
    try r.seed(["hm-acme-atlas|1700000000|0|0|acme|Atlas"])
    await r.h.send(connection, .attach(session: atlas, size: TerminalSize(columns: 80, rows: 24)!), id: "a")
    #expect(transport.take() == [BrokerEventFrame(id: "a", .attached(stream: 1, session: atlas))])
    #expect(r.h.tmux.calls("has-session").count == 1, "this Mac first")
    // Ended on the host since its last list: refused as here, and nothing spawned.
    try r.seed(["hm-acme-bea|1700000000|0|0|acme|Bea"])
    await r.h.send(connection, .attach(session: atlas, size: TerminalSize(columns: 80, rows: 24)!), id: "b")
    #expect(transport.take() == [BrokerEventFrame(id: "b", .error(code: .noSuchSession, message: "no session hm-acme-atlas", stream: nil))])
    #expect(r.h.spawner.terminals.count == 1)
    await r.h.send(connection, .attachCommand(session: atlas), id: "c")
    #expect(errorCode(transport.take().first?.event) == .noSuchSession)
  }

  @Test func anOfflineHostsSessionIsNotAttachedAndSaysWhy() async throws {
    let r = try RemoteFixture()
    defer { r.remove() }
    try r.seed(["hm-acme-atlas|1700000000|0|0|acme|Atlas"])
    await r.h.start()
    let (transport, connection) = await r.h.client()
    await r.h.send(connection, .sessionsList)
    _ = transport.take()
    r.hosts.hosts = [BrokerRemoteHost(id: fakeHost.id, label: fakeHost.label, ready: false, runtimeFolder: runtimeFolder)]
    let scripts = r.hosts.scripts.count
    let offline = BrokerEvent.error(code: .internal, message: "hm-acme-atlas runs on Build Mac, which is offline; it keeps running there",
                                    stream: nil)
    await r.h.send(connection, .attach(session: atlas, size: TerminalSize(columns: 80, rows: 24)!), id: "a")
    await r.h.send(connection, .attachCommand(session: atlas), id: "c")
    #expect(transport.take() == [BrokerEventFrame(id: "a", offline), BrokerEventFrame(id: "c", offline)])
    #expect(r.h.spawner.terminals.isEmpty)
    #expect(r.hosts.scripts.count == scripts, "nothing ran over ssh")
  }

  @Test func openInTerminalGetsTheSSHLineForAHostsSessionAndTmuxAttachForThisMacs() async throws {
    let r = try RemoteFixture()
    defer { r.remove() }
    try r.seed(["hm-acme-atlas|1700000000|0|0|acme|Atlas"])
    r.h.tmux.add("hm-acme-bea")
    await r.h.start()
    let (transport, connection) = await r.h.client()
    await r.h.send(connection, .sessionsList)
    _ = transport.take()
    await r.h.send(connection, .attachCommand(session: atlas), id: "c")
    let tmux = TmuxCommand(executable: r.tmuxPath, configPath: "\(r.home)/\(runtimeFolder)/tmux.conf")
    let spec = r.ssh.transport().terminalSpec(fakeHost, command: RemoteRuntime.remote(tmux.attachShellLine(atlas)))
    let line = "exec " + ([spec.executable.path] + spec.arguments).map(TerminalScript.shellQuoted).joined(separator: " ")
    #expect(transport.take() == [BrokerEventFrame(id: "c", .attachCommand(session: atlas, command: line))])
    #expect(TerminalLaunch(title: "hm-acme-atlas", cwd: nil, command: line) != nil, "fits a .command file")
    #expect(r.h.spawner.terminals.isEmpty, "no stream here: the window runs it")
    // The .command's login shell runs the line, which reaches the host's attach-session through the fake ssh.
    let ran = await SSHProcessRunner().run(LaunchSpec(executable: URL(fileURLWithPath: "/bin/sh"), arguments: ["-c", line],
                                                      environment: r.ssh.transport().environment), stdin: Data("pwd\n".utf8), timeout: 20)
    #expect(ran.stdout.hasPrefix("attached hm-acme-atlas TERM="))
    #expect(ran.stdout.hasSuffix("\ntyped pwd\n"))
    // This Mac's session: tmux attach, as Hivemind.app builds it from the welcome.
    await r.h.send(connection, .attachCommand(session: SessionName("hm-acme-bea")!), id: "here")
    #expect(transport.take() == [BrokerEventFrame(id: "here", .attachCommand(
      session: SessionName("hm-acme-bea")!, command: TmuxCommand(executable: "/opt/homebrew/bin/tmux", configPath: BrokerHarness.config)
        .attachShellLine(SessionName("hm-acme-bea")!)))])
  }

  @Test func anOfflineHostRefusesItsLaunchAndIsNotListed() async throws {
    let r = try RemoteFixture(ready: false)
    defer { r.remove() }
    try r.seed(["hm-acme-bea|1700000000|0|0|acme|Bea"])
    await r.h.start()
    let (transport, connection) = await r.h.client()
    await r.h.send(connection, .launch([try r.launch()]))
    #expect(transport.events().first == .launched(names: [nil], created: [], errors: [
      BrokerLaunchFailure(index: 0, code: .internal, message: "launches[0].host: Build Mac is offline")]))
    await r.h.send(connection, .sessionsList)
    #expect(transport.events().first == .sessions([]))
    #expect(r.hosts.scripts.isEmpty, "nothing ran over ssh")
    // An unknown host is refused the same way.
    await r.h.send(connection, .launch([try r.launch(host: "20000000-0000-4000-8000-0000000000ff")]))
    #expect(transport.events().first == .launched(names: [nil], created: [], errors: [
      BrokerLaunchFailure(index: 0, code: .internal, message: "launches[0].host: no such host")]))
  }

  @Test func withNoHostConfiguredEveryLaunchIsThisMacsExactlyAsBefore() async throws {
    let r = try RemoteFixture(hosts: 0)
    defer { r.remove() }
    let plain = BrokerHarness()
    var answers: [[BrokerEventFrame]] = []
    for h in [r.h, plain] {
      await h.start()
      let (transport, connection) = await h.client()
      await h.send(connection, .launch([brokerLaunch("Atlas"), brokerLaunch(nil)]), id: "go")
      await h.send(connection, .sessionsList, id: "list")
      await h.send(connection, .attach(session: atlas, size: TerminalSize(columns: 80, rows: 24)!), id: "attach")
      await h.send(connection, .attachCommand(session: atlas), id: "line")
      await h.send(connection, .kill(session: atlas), id: "kill")
      answers.append(transport.take().filter { $0.id != nil })
    }
    #expect(answers[0] == answers[1])
    #expect(answers[0].count == 5)
    // This Mac's terminals, exactly as before hosts: tmux attach in the stream's PTY and in the Terminal.app line.
    let local = TmuxCommand(executable: "/opt/homebrew/bin/tmux", configPath: BrokerHarness.config)
    #expect(answers[0].contains(BrokerEventFrame(id: "attach", .attached(stream: 1, session: atlas))))
    #expect(answers[0].contains(BrokerEventFrame(id: "line", .attachCommand(session: atlas, command: local.attachShellLine(atlas)))))
    #expect(r.h.spawner.terminals.map(\.spec) == plain.spawner.terminals.map(\.spec))
    #expect(r.h.spawner.terminals.first?.spec.executable == "/opt/homebrew/bin/tmux")
    #expect(r.h.tmux.calls == plain.tmux.calls)
    #expect(r.h.logs == plain.logs)
    #expect(r.hosts.scripts.isEmpty)
  }

  @Test func aCodexThreadOpenOnTheHostIsNotResumedThere() async throws {
    let r = try RemoteFixture()
    defer { r.remove() }
    let folder = r.home + "/.codex/thread-writer-locks"
    try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
    let fd = open(folder + "/\(thread).lock", O_RDWR | O_CREAT, 0o600)
    try #require(fd >= 0)
    defer { close(fd) }
    try #require(flock(fd, LOCK_EX) == 0)
    let account = LaunchAccount(id: "codex-main", driver: .codex, label: "Codex", homePath: "", shadowPath: "")
    await r.h.start()
    let (transport, connection) = await r.h.client()
    await r.h.send(connection, .launch([try r.launch(command: "codex resume \(thread)", account: account)]))
    #expect(transport.events().first == .launched(names: [nil], created: [], errors: [BrokerLaunchFailure(index: 0, code: .internal,
      message: "launches[0].command: Codex thread `\(thread)` is already open in another process on Build Mac. Close it there, or start a new session.")]))
    #expect(r.launchFiles().isEmpty, "a refused launch leaves no file behind")
    try #require(flock(fd, LOCK_UN) == 0)
    await r.h.send(connection, .launch([try r.launch(command: "codex resume \(thread)", account: account)]))
    #expect(transport.events().first == .launched(names: [atlas], created: [atlas], errors: []))
  }

  @Test func anOpenClaudeSessionOnTheHostIsNotResumedThere() async throws {
    let r = try RemoteFixture()
    defer { r.remove() }
    let session = "11111111-2222-4333-8444-555555555555"
    let sessions = r.home + "/.claude/sessions"
    try FileManager.default.createDirectory(atPath: sessions, withIntermediateDirectories: true)
    let started = try #require(ClaudeLiveSessions.systemProcessStart(getpid()))
    let record: [String: Any] = ["pid": Int(getpid()), "sessionId": session, "procStart": started, "pidDomain": "darwin", "cwd": r.project]
    try JSONSerialization.data(withJSONObject: record).write(to: URL(fileURLWithPath: sessions + "/\(getpid()).json"))
    let account = LaunchAccount(id: "claude-main", driver: .claude, label: "Claude", homePath: "", shadowPath: "")
    await r.h.start()
    let (transport, connection) = await r.h.client()
    await r.h.send(connection, .launch([try r.launch(command: "claude --resume \(session)", account: account)]))
    #expect(transport.events().first == .launched(names: [nil], created: [], errors: [BrokerLaunchFailure(index: 0, code: .internal,
      message: "launches[0].command: Claude session `\(session)` is already open in another process on Build Mac (account `Claude`).")]))
    // A project setting that overrides the login is read on the host too.
    try FileManager.default.removeItem(atPath: sessions + "/\(getpid()).json")
    try FileManager.default.createDirectory(atPath: r.project + "/.claude", withIntermediateDirectories: true)
    try Data(#"{"env":{"anthropic_api_key":"x"}}"#.utf8).write(to: URL(fileURLWithPath: r.project + "/.claude/settings.local.json"))
    await r.h.send(connection, .launch([try r.launch(command: "claude --resume \(session)", account: account)]))
    #expect(transport.events().first == .launched(names: [nil], created: [], errors: [BrokerLaunchFailure(index: 0, code: .badMessage,
      message: "launches[0].account: `\(r.project)/.claude/settings.local.json` sets `anthropic_api_key`, which overrides the account `Claude`. Remove it from that file.")]))
  }

  @Test func aShadowAccountIsLinkedOnTheHostByTheSameSteps() async throws {
    let r = try RemoteFixture()
    defer { r.remove() }
    let shared = r.home + "/.codex", shadow = r.home + "/.codex-work"
    for folder in [shared + "/sessions", shadow] { try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true) }
    try Data("model = \"gpt\"\n".utf8).write(to: URL(fileURLWithPath: shared + "/config.toml"))
    r.h.shadowHomes = FileShadowHomes()
    let account = LaunchAccount(id: "codex-work", driver: .codex, label: "Codex work", homePath: "", shadowPath: "~/.codex-work")
    await r.h.start()
    let (transport, connection) = await r.h.client()
    await r.h.send(connection, .launch([try r.launch(account: account)]))
    #expect(transport.events().first == .launched(names: [nil], created: [], errors: [BrokerLaunchFailure(index: 0, code: .internal,
      message: "launches[0].account: `\(shadow)` has no login yet. Run `mkdir -p '\(shadow)' && CODEX_HOME='\(shadow)' CODEX_SQLITE_HOME='\(shared)' codex -c cli_auth_credentials_store=file login` to log in.")]))
    #expect((try? FileManager.default.destinationOfSymbolicLink(atPath: shadow + "/sessions")) == nil, "a refused shadow is not linked")

    try Data("{}".utf8).write(to: URL(fileURLWithPath: shadow + "/auth.json"))
    await r.h.send(connection, .launch([try r.launch(account: account)]))
    #expect(transport.events().first == .launched(names: [atlas], created: [atlas], errors: []))
    for name in ["sessions", "config.toml", "thread-writer-locks"] {
      #expect((try? FileManager.default.destinationOfSymbolicLink(atPath: shadow + "/" + name)) == shared + "/" + name, "\(name)")
    }
    #expect(mode(shared + "/thread-writer-locks") == 0o700, "made in the home first, as here")
    let file = try #require(r.launchFiles().first)
    #expect(r.read(file) == "CODEX_HOME=\(shadow)\nCODEX_SQLITE_HOME=\(shared)\n", "the account's paths are the host's")
  }

  @Test func aClaudeLaunchOnAHostGetsTheStatusLineTapThere() async throws {
    let r = try RemoteFixture()
    defer { r.remove() }
    r.h.claudeTap = ClaudeStatusTap(folder: r.ssh.root.appendingPathComponent("this mac accounts"))
    let account = LaunchAccount(id: "claude-work", driver: .claude, label: "Claude work", homePath: "~/.claude-work", shadowPath: "")
    await r.h.start()
    let (transport, connection) = await r.h.client()
    await r.h.send(connection, .launch([try r.launch(command: "claude", account: account)]))
    #expect(transport.events().first == .launched(names: [atlas], created: [atlas], errors: []))
    let tap = ClaudeStatusTap(folder: URL(fileURLWithPath: r.support + "/accounts"))
    let settings = r.support + "/accounts/claude-work/settings.json"
    #expect(r.read(settings).map { Data($0.utf8) } == tap.settings(for: account, home: r.home))
    #expect(r.read(tap.script.path) == ClaudeStatusTap.scriptText)
    #expect(mode(settings) == 0o600 && mode(tap.script.path) == 0o600 && mode(r.support + "/accounts/claude-work") == 0o700)
    let file = try #require(r.launchFiles().first)
    #expect(r.read(file) == "CLAUDE_CONFIG_DIR=\(r.home)/.claude-work\nHIVEMIND_CLAUDE_SETTINGS=\(settings)\n")
    #expect(!FileManager.default.fileExists(atPath: r.ssh.root.appendingPathComponent("this mac accounts").path), "nothing here")
  }
  @Test func aKillOfASessionOnAHostThatWentOfflineIsNotTakenAsDone() async throws {
    let r = try RemoteFixture()
    defer { r.remove() }
    let journal = r.ssh.root.appendingPathComponent("journal")
    await r.h.start()
    let adapter = InProcessLauncherBroker(current: { r.h.broker })
    let service = LauncherService(server: { nil }, http: NoHTTP(), broker: adapter, journal: FileLauncherJournal(folder: journal))
    #expect(try await adapter.launch(try r.launch()) == atlas)
    // The connection drops between the launch and the hard-pause's kill: the session runs on, unlisted.
    let online = r.hosts.hosts
    r.hosts.hosts = online.map { BrokerRemoteHost(id: $0.id, label: $0.label, ready: false, runtimeFolder: $0.runtimeFolder) }
    let kill = LauncherCommand(id: "44444444-4444-4444-8444-444444444444", kind: .kill, session: atlas.rawValue)
    #expect(try await service.execute(kill) == .failed("broker kill failed"))
    #expect(r.read(r.state + "/sessions")?.hasPrefix("hm-acme-atlas|") == true, "still running on the host")
    // Back online, a new kill ends it there.
    r.hosts.hosts = online
    let again = LauncherCommand(id: "55555555-5555-4555-8555-555555555555", kind: .kill, session: atlas.rawValue)
    #expect(try await service.execute(again) == .killed)
    #expect(r.read(r.state + "/sessions") == "")
    #expect(r.h.tmux.calls("kill-session").isEmpty, "never on this Mac")
    await r.h.broker.settle()
  }

  @Test func aHungHostHoldsUpNeitherThisMacsListNorItsLaunchesAndKills() async throws {
    let h = BrokerHarness()
    let hosts = HungHosts()
    h.remoteHosts = hosts
    h.broker.start()
    await until { h.broker.sessions != nil && hosts.pending.count == 1 }
    #expect(h.broker.sessions == [], "this Mac's list is out while the host's list hangs")
    #expect(hosts.pending.count == 1)
    let transport = FakeTransport()
    let connection = try #require(h.broker.accept(transport))
    var asked = 0
    func ask(_ request: BrokerRequest) async -> BrokerEvent? {
      asked += 1
      let id = "q\(asked)"
      connection.received(try! BrokerRequestFrame(id: id, request).line())
      await until { transport.frames.contains { $0.id == id } }
      return transport.frames.first { $0.id == id }?.event
    }
    _ = await ask(.hello(version: 1, token: h.token.value, client: "test"))
    _ = await ask(.sessionsSubscribe)
    // The poll lists this Mac again and again; the host is asked once at a time.
    for _ in 0..<3 {
      let lists = h.tmux.calls("list-sessions").count
      h.scheduler.advance(BrokerLimits.sessionsPollInterval)
      await until { h.tmux.calls("list-sessions").count > lists && h.scheduler.pending.count == 1 }
      #expect(h.tmux.calls("list-sessions").count > lists)
    }
    #expect(hosts.pending.count == 1)
    // A list that fails waits the interval before the next one, like one that succeeds.
    hosts.release(SSHResult(status: 255, stderr: "Connection timed out\n"))
    await h.broker.settle()
    h.scheduler.advance(BrokerLimits.sessionsPollInterval)
    await h.broker.settle()
    #expect(hosts.calls == 1)
    h.scheduler.advance(BrokerLimits.remoteSessionsPollInterval)
    await until { hosts.calls == 2 }
    #expect(hosts.pending.count == 1)
    // The host was asked once, so a launch and a kill on this Mac wait for no list of it, and ask it nothing.
    #expect(await ask(.launch([brokerLaunch("Atlas")])) == .launched(names: [atlas], created: [atlas], errors: []))
    #expect(await ask(.kill(session: atlas)) == .killed(session: atlas))
    #expect(hosts.calls == 2)
    hosts.release(SSHResult(status: 255, stderr: "Connection timed out\n"))
    await h.broker.settle()
  }
}

/// One ready host whose every command waits until the test releases it, as a host that stopped answering does.
@MainActor
private final class HungHosts: BrokerRemoteHosts {
  var pending: [CheckedContinuation<SSHResult, Never>] = []
  var calls = 0
  var brokerHosts: [BrokerRemoteHost] {
    [BrokerRemoteHost(id: fakeHost.id, label: fakeHost.label, ready: true, runtimeFolder: runtimeFolder)]
  }

  func run(onHost id: String, script: String, stdin: Data, timeout: TimeInterval) async -> SSHResult {
    calls += 1
    return await withCheckedContinuation { pending.append($0) }
  }

  func terminalSpec(onHost id: String, command: String) -> LaunchSpec? { nil }

  func release(_ result: SSHResult) {
    for continuation in pending { continuation.resume(returning: result) }
    pending.removeAll()
  }
}

/// Yields until `condition` holds, for work the test cannot settle because a hung host's task never ends.
@MainActor
private func until(_ condition: () -> Bool) async {
  for _ in 0..<10_000 where !condition() { await Task.yield() }
}

/// A server that never answers: no catalog reaches anything in these tests.
private struct NoHTTP: LauncherHTTP {
  func send(_ request: URLRequest) async throws -> (status: Int, body: Data) { throw URLError(.cannotConnectToHost) }
}

private func errorCode(_ event: BrokerEvent?) -> BrokerErrorCode? {
  if case .error(let code, _, _) = event { return code }
  return nil
}

@MainActor
struct RemoteHostScriptTests {
  @Test func aProbeReadsTheHomeTmuxAndSessionsPastWhatTheShellPrints() {
    let output = "Welcome!\nhivemind-home /Users/someone\nhivemind-tmux /opt/homebrew/bin/tmux\nhivemind-list 0\n"
      + "hm-acme-atlas|1700000000|1|0|acme|Atlas\nnot ours\n"
    let probe = RemoteHostScripts.parseProbe(output, host: fakeHost.id)
    #expect(probe == RemoteHostProbe(home: "/Users/someone", tmux: "/opt/homebrew/bin/tmux", sessions: .success([BrokerSession(
      name: atlas, project: "acme", agent: "Atlas", alive: true, attached: 1, createdAt: 1_700_000_000_000, host: fakeHost.id)])))
    #expect(RemoteHostScripts.parseProbe("hivemind-home /u\nhivemind-tmux \n", host: fakeHost.id)?.tmux == nil)
    #expect(RemoteHostScripts.parseProbe("hivemind-home /u\nhivemind-tmux /t\nhivemind-list 1\nno server running on /tmp/x\n",
                                         host: fakeHost.id)?.sessions == .success([]))
    #expect(RemoteHostScripts.parseProbe("nothing", host: fakeHost.id) == nil)
  }

  @Test func theHostsCommandIsOneShellScriptOverTheMasterWithStdin() async {
    let runner = FakeSSHRunner()
    let installer = FakeInstaller()
    let root = (try? temporaryHome()) ?? FileManager.default.temporaryDirectory
    defer { try? FileManager.default.removeItem(at: root) }
    let transport = SSHTransport(environment: [:], controlFolder: root.appendingPathComponent("ssh"))
    let service = HostsService(store: RemoteHostStore(file: root.appendingPathComponent("hosts.json")), server: { nil },
                               dependencies: .init(transport: transport, launcher: FakeLauncher(), runner: runner, scheduler: FakeScheduler(),
                                                   installer: installer, http: NoHTTP()))
    #expect(service.brokerHosts.isEmpty, "no host, nothing for the broker")
    try? service.add(fakeHost)
    #expect(service.brokerHosts == [BrokerRemoteHost(id: fakeHost.id, label: "Build Mac", ready: false, runtimeFolder: installer.runtimeFolder)])
    _ = await service.run(onHost: fakeHost.id, script: "echo hi", stdin: Data("secret\n".utf8), timeout: 5)
    #expect(runner.calls.last == transport.commandSpec(fakeHost, command: RemoteRuntime.remote("echo hi")))
    #expect(runner.stdins.last == Data("secret\n".utf8))
    let unknown = await service.run(onHost: "20000000-0000-4000-8000-0000000000ff", script: "echo hi", stdin: Data(), timeout: 5)
    #expect(unknown.status == SSHResult.launchFailed)
    // A terminal on the host goes over the same master, with a PTY there and every byte passed on.
    #expect(service.terminalSpec(onHost: fakeHost.id, command: "tmux") == transport.terminalSpec(fakeHost, command: "tmux"))
    #expect(transport.terminalSpec(fakeHost, command: "tmux").arguments == [
      "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-S", transport.controlPath(for: fakeHost).path,
      "-o", "ControlMaster=no", "-o", "LogLevel=ERROR", "-e", "none", "-tt", "user@mini.local", "tmux"])
    #expect(service.terminalSpec(onHost: "20000000-0000-4000-8000-0000000000ff", command: "tmux") == nil)
  }
}
