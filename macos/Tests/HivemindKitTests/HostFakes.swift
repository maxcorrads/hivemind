import Foundation
@testable import HivemindKit

// Remote hosts in the tests (docs/remote-hosts.md): nothing here reaches a real host. The state machine runs on a
// FakeLauncher, a FakeScheduler and FakeSSHRunner; the end-to-end tests run a fake `ssh` (FakeSSH) that runs the
// remote command with `sh -c` under a temp remote HOME, and a fake Hivemind Server bundle (FakeBundle).

let fakeHost = RemoteHost(id: "20000000-0000-4000-8000-000000000001", label: "Build Mac", ssh: "user@mini.local",
                          forwards: ["-R 1080", "-L 5432:db.internal:5432"])

/// Answers each command by what it is: `-O exit`, `-O check`, or a remote command, and records every one.
@MainActor final class FakeSSHRunner: SSHRunning {
  var calls: [LaunchSpec] = []
  var inputs: [LaunchSpec?] = []
  /// How many checks fail before one succeeds.
  var failingChecks = 0
  var check = SSHResult(status: 0, stderr: "Master running (pid=1)\n")
  var exit = SSHResult(status: 255, stderr: "Control socket connect(/x): No such file or directory\n")
  var command = SSHResult(status: 0)

  func run(_ spec: LaunchSpec, input: LaunchSpec?, timeout: TimeInterval) async -> SSHResult {
    calls.append(spec)
    inputs.append(input)
    if spec.arguments.contains("-O") {
      guard spec.arguments.contains("check") else { return exit }
      if failingChecks > 0 {
        failingChecks -= 1
        return SSHResult(status: 255, stderr: "Control socket connect(/x): No such file or directory\n")
      }
      return check
    }
    return command
  }

  /// What each call was: `exit`, `check` or `command`.
  var kinds: [String] {
    calls.map { spec in spec.arguments.contains("-O") ? (spec.arguments.contains("check") ? "check" : "exit") : "command" }
  }
}

/// The runtime check, answered at once: ready, or a fixed failure.
@MainActor final class FakeInstaller: RemoteRuntimeInstalling {
  var outcome: Result<Void, BrokerFiles.Failure> = .success(())
  var installs = false
  var ensured: [String] = []

  func ensure(on host: RemoteHost, installing: @escaping @MainActor () -> Void) async -> Result<Void, BrokerFiles.Failure> {
    ensured.append(host.id)
    if installs { installing() }
    return outcome
  }
}

/// A fake `ssh` in a temp folder, with a remote HOME next to it. It logs every argv (one line, arguments joined by
/// spaces, new lines as spaces), then:
/// - `-O check` succeeds while the "master" whose pid is in the control file runs, and `-O exit` ends it;
/// - `-N` (the master) writes its pid to the control file and waits for SIGTERM, which removes it;
/// - anything else runs the remote command with `/bin/sh -c` in the remote HOME, as the host's login shell would.
/// FAKE_SSH_FAIL, when set, is printed to stderr instead and ssh exits 255, as a refused login does.
struct FakeSSH {
  let root: URL
  var executable: URL { root.appendingPathComponent("bin/ssh") }
  var remoteHome: URL { root.appendingPathComponent("remote home", isDirectory: true) }
  var log: URL { root.appendingPathComponent("ssh.log") }
  var sockets: URL { root.appendingPathComponent("sockets", isDirectory: true) }

  static let script = #"""
    #!/bin/sh
    { printf '%s' "$*" | tr '\n' ' '; echo; } >> "$FAKE_SSH_LOG"
    control= op= master=0
    while [ $# -gt 0 ]; do
      case "$1" in
        -N) master=1; shift ;;
        -T) shift ;;
        -S) control=$2; shift 2 ;;
        -O) op=$2; shift 2 ;;
        -o|-R|-L|-D) shift 2 ;;
        -*) echo "fake ssh: unexpected option $1" >&2; exit 255 ;;
        *) break ;;
      esac
    done
    shift
    if [ -n "${FAKE_SSH_FAIL:-}" ]; then echo "$FAKE_SSH_FAIL" >&2; exit 255; fi
    case "$op" in
      check)
        if [ -f "$control" ] && kill -0 "$(cat "$control")" 2>/dev/null; then echo "Master running" >&2; exit 0; fi
        echo "Control socket connect($control): No such file or directory" >&2; exit 255 ;;
      exit)
        if [ -f "$control" ]; then kill "$(cat "$control")" 2>/dev/null; rm -f "$control"; echo "Exit request sent." >&2; exit 0; fi
        echo "Control socket connect($control): No such file or directory" >&2; exit 255 ;;
    esac
    if [ "$master" = 1 ]; then
      echo $$ > "$control"
      trap 'rm -f "$control"; exit 0' TERM INT
      while :; do sleep 1 & wait $!; done
    fi
    cd "$FAKE_REMOTE_HOME" && HOME="$FAKE_REMOTE_HOME" exec /bin/sh -c "$1"
    """#

  init() throws {
    root = try temporaryHome().resolvingSymlinksInPath()
    try FileManager.default.createDirectory(at: executable.deletingLastPathComponent(), withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: remoteHome, withIntermediateDirectories: true)
    try Data(Self.script.utf8).write(to: executable)
    try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
  }

  func transport(fail: String? = nil) -> SSHTransport {
    var environment = ["PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "FAKE_SSH_LOG": log.path, "FAKE_REMOTE_HOME": remoteHome.path]
    environment["FAKE_SSH_FAIL"] = fail
    return SSHTransport(executable: executable, environment: environment, controlFolder: sockets)
  }

  /// Every argv the fake ssh got, in order.
  func calls() -> [String] {
    ((try? String(contentsOf: log, encoding: .utf8)) ?? "").split(separator: "\n").map(String.init)
  }

  /// The installs the fake ssh ran (remote commands that read a tar stream).
  func installs() -> Int { calls().filter { $0.contains("tar -xf -") }.count }

  func remove() { try? FileManager.default.removeItem(at: root) }
}

/// A Hivemind Server.app's Contents as build.sh lays it out, small: a `node` that prints its version, and a server
/// package with its bin, a package.json and a node_modules folder.
struct FakeBundle {
  let contents: URL
  var server: BundledServer { BundledServer(contents: contents) }

  init(in root: URL, version: String = "9.9.9", cli: String = "console.log('hivemind')\n") throws {
    contents = root.appendingPathComponent("Hivemind Server.app/Contents", isDirectory: true)
    let manager = FileManager.default
    let package = contents.appendingPathComponent("Resources/server", isDirectory: true)
    try manager.createDirectory(at: contents.appendingPathComponent("Helpers"), withIntermediateDirectories: true)
    try manager.createDirectory(at: package.appendingPathComponent("bin"), withIntermediateDirectories: true)
    try manager.createDirectory(at: package.appendingPathComponent("node_modules/zod"), withIntermediateDirectories: true)
    try Data("#!/bin/sh\necho v24.0.0\n".utf8).write(to: contents.appendingPathComponent("Helpers/node"))
    try manager.setAttributes([.posixPermissions: 0o755], ofItemAtPath: contents.appendingPathComponent("Helpers/node").path)
    try Data(#"{"name":"hivemind","version":"\#(version)"}"#.utf8).write(to: package.appendingPathComponent("package.json"))
    try Data(cli.utf8).write(to: package.appendingPathComponent("bin/hivemind.mjs"))
    try Data("{}".utf8).write(to: package.appendingPathComponent("node_modules/zod/package.json"))
  }
}

/// What `uname -s` and `uname -m` print here, so the end-to-end runtime runs on this Mac's platform.
func localPlatform() -> String {
  var info = utsname()
  uname(&info)
  func field<T>(_ value: T) -> String {
    withUnsafeBytes(of: value) { String(decoding: $0.prefix(while: { $0 != 0 }), as: UTF8.self) }
  }
  return "\(field(info.sysname)) \(field(info.machine))"
}

/// Polls `condition` on the main actor every 50 ms for up to `seconds`.
@MainActor func eventually(_ seconds: Double = 20, _ condition: @MainActor () -> Bool) async -> Bool {
  let deadline = Date().addingTimeInterval(seconds)
  while Date() < deadline {
    if condition() { return true }
    try? await Task.sleep(for: .milliseconds(50))
  }
  return condition()
}
