import Foundation
import HivemindKit

/// Runs one short tmux command with Foundation.Process, off the main thread.
/// argv only: no shell is involved. A call that has not finished after
/// `timeout` is terminated, so a wedged tmux server cannot hold a request
/// (or the session poll) forever.
struct TmuxProcessRunner: TmuxRunning {
  nonisolated static let timeout: TimeInterval = 10
  /// list-sessions of every Hivemind session is a few KiB; anything past
  /// this is cut.
  nonisolated static let maxOutputBytes = 1 << 20

  func run(executable: String, arguments: [String], environment: [String: String]) async -> TmuxResult {
    await withCheckedContinuation { continuation in
      DispatchQueue.global(qos: .userInitiated).async {
        continuation.resume(returning: Self.runBlocking(executable: executable, arguments: arguments, environment: environment))
      }
    }
  }

  nonisolated private static func runBlocking(executable: String, arguments: [String], environment: [String: String]) -> TmuxResult {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    process.environment = environment
    // The folder a new session would start in without the script's cd; the
    // app's own is "/".
    process.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
    process.standardInput = FileHandle.nullDevice
    let out = Pipe()
    let err = Pipe()
    process.standardOutput = out
    process.standardError = err
    do {
      try process.run()
    } catch {
      return TmuxResult(status: TmuxResult.launchFailed, stderr: "cannot run \(executable): \(error.localizedDescription)")
    }

    let collected = Collected()
    let group = DispatchGroup()
    for (pipe, isError) in [(out, false), (err, true)] {
      group.enter()
      DispatchQueue.global(qos: .userInitiated).async {
        // tmux's server daemonizes onto /dev/null, so both pipes reach EOF
        // when this tmux client exits.
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        collected.set(data.prefix(maxOutputBytes), isError: isError)
        group.leave()
      }
    }
    let deadline = DispatchWorkItem { if process.isRunning { process.terminate() } }
    DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: deadline)
    process.waitUntilExit()
    deadline.cancel()
    if group.wait(timeout: .now() + 2) == .timedOut {
      try? out.fileHandleForReading.close()
      try? err.fileHandleForReading.close()
    }
    let (stdout, stderr) = collected.values
    let status = process.terminationReason == .uncaughtSignal ? 128 + process.terminationStatus : process.terminationStatus
    return TmuxResult(
      status: status,
      stdout: String(decoding: stdout, as: UTF8.self),
      stderr: String(decoding: stderr, as: UTF8.self))
  }

  private final class Collected: @unchecked Sendable {
    private let lock = NSLock()
    private var stdout = Data()
    private var stderr = Data()

    func set(_ data: Data, isError: Bool) {
      lock.lock()
      defer { lock.unlock() }
      if isError { stderr = data } else { stdout = data }
    }

    var values: (Data, Data) {
      lock.lock()
      defer { lock.unlock() }
      return (stdout, stderr)
    }
  }
}
