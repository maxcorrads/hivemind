import Foundation
@testable import HivemindKit

// Nothing in these tests spawns a process, binds a port or touches the real
// home folder: every seam is one of these fakes.

@MainActor
final class FakeProcess: SupervisedProcess {
  let pid: Int32
  let onOutput: @MainActor @Sendable (OutputChannel, String) -> Void
  let onExit: @MainActor @Sendable (ProcessExit) -> Void
  var terminated = 0
  var killed = 0
  /// Exit immediately on SIGTERM, like node without a SIGTERM handler.
  var exitsOnTerminate = true

  init(pid: Int32, onOutput: @escaping @MainActor @Sendable (OutputChannel, String) -> Void,
       onExit: @escaping @MainActor @Sendable (ProcessExit) -> Void) {
    self.pid = pid
    self.onOutput = onOutput
    self.onExit = onExit
  }

  func terminate() {
    terminated += 1
    if exitsOnTerminate { onExit(ProcessExit(reason: .signaled, status: 15)) }
  }

  func kill() {
    killed += 1
    onExit(ProcessExit(reason: .signaled, status: 9))
  }

  func say(_ line: String, on channel: OutputChannel = .stderr) { onOutput(channel, line) }
  func crash(status: Int32 = 1) { onExit(ProcessExit(reason: .exited, status: status)) }
}

struct LaunchFailure: Error, LocalizedError {
  var errorDescription: String? { "no such file" }
}

@MainActor
final class FakeLauncher: ProcessLaunching {
  var launched: [FakeProcess] = []
  var specs: [LaunchSpec] = []
  var fail = false
  var nextPid: Int32 = 100

  var current: FakeProcess? { launched.last }

  func launch(
    _ spec: LaunchSpec,
    onOutput: @escaping @MainActor @Sendable (OutputChannel, String) -> Void,
    onExit: @escaping @MainActor @Sendable (ProcessExit) -> Void
  ) throws -> any SupervisedProcess {
    if fail { throw LaunchFailure() }
    specs.append(spec)
    let process = FakeProcess(pid: nextPid, onOutput: onOutput, onExit: onExit)
    nextPid += 1
    launched.append(process)
    return process
  }
}

/// A manual clock: `advance` runs whatever came due, in order.
@MainActor
final class FakeScheduler: Scheduling {
  final class Job: Cancellable {
    let due: Date
    let work: @MainActor @Sendable () -> Void
    var cancelled = false
    init(due: Date, work: @escaping @MainActor @Sendable () -> Void) { self.due = due; self.work = work }
    func cancel() { cancelled = true }
  }

  var clock = Date(timeIntervalSince1970: 1_000_000)
  var jobs: [Job] = []

  var pending: [Job] { jobs.filter { !$0.cancelled } }

  func now() -> Date { clock }

  func schedule(after delay: TimeInterval, _ work: @escaping @MainActor @Sendable () -> Void) -> any Cancellable {
    let job = Job(due: clock.addingTimeInterval(delay), work: work)
    jobs.append(job)
    return job
  }

  func advance(_ seconds: TimeInterval) {
    let target = clock.addingTimeInterval(seconds)
    while let next = jobs.filter({ !$0.cancelled && $0.due <= target }).min(by: { $0.due < $1.due }) {
      jobs.removeAll { $0 === next }
      clock = next.due
      next.work()
    }
    clock = target
  }
}

struct FakeHTTP: HTTPGetting {
  var result: Result<(Int, Data), any Error>

  func get(_ url: URL, timeout: TimeInterval) async throws -> (status: Int, body: Data) {
    let (status, body) = try result.get()
    return (status, body)
  }
}

struct FakeProbe: PortProbing {
  var listening: Set<Int> = []
  func isListening(_ port: ServerPort) -> Bool { listening.contains(port.value) }
}

/// A fresh folder under the system temp dir, standing in for $HOME.
func temporaryHome() throws -> URL {
  let url = FileManager.default.temporaryDirectory.appendingPathComponent("hivemindkit-\(UUID().uuidString)", isDirectory: true)
  try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
  return url
}
