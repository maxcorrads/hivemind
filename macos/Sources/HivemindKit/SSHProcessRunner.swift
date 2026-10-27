import Foundation

// Foundation.Process does not exist on iOS, which has no hosts.
#if os(macOS)
/// SSHRunning with Foundation.Process, off the main thread: argv only, no local shell. With an input command, that one
/// runs too and a pipe joins its stdout to the command's stdin (`tar … | ssh …`). A run that has not ended after its
/// timeout is terminated, the input with it.
public struct SSHProcessRunner: SSHRunning {
  /// A check prints two lines and an install nothing; anything past this is cut.
  nonisolated static let maxOutputBytes = 1 << 20

  public init() {}

  public func run(_ spec: LaunchSpec, input: LaunchSpec?, timeout: TimeInterval) async -> SSHResult {
    await withCheckedContinuation { continuation in
      DispatchQueue.global(qos: .utility).async {
        continuation.resume(returning: Self.runBlocking(spec, input: input, timeout: timeout))
      }
    }
  }

  nonisolated private static func process(_ spec: LaunchSpec) -> Process {
    let process = Process()
    process.executableURL = spec.executable
    process.arguments = spec.arguments
    process.environment = spec.environment
    process.currentDirectoryURL = spec.workingDirectory ?? FileManager.default.homeDirectoryForCurrentUser
    return process
  }

  nonisolated private static func runBlocking(_ spec: LaunchSpec, input: LaunchSpec?, timeout: TimeInterval) -> SSHResult {
    let command = process(spec)
    let out = Pipe(), err = Pipe()
    command.standardOutput = out
    command.standardError = err
    var feeder: Process?
    let stream = Pipe()
    if let input {
      let source = process(input)
      source.standardOutput = stream
      source.standardError = FileHandle.nullDevice
      command.standardInput = stream
      feeder = source
    } else {
      command.standardInput = FileHandle.nullDevice
    }
    do {
      try command.run()
    } catch {
      return SSHResult(status: SSHResult.launchFailed, stderr: "cannot run \(spec.executable.path): \(error.localizedDescription)")
    }
    // The command first: an input started with no reader could block on a full pipe forever.
    if let feeder {
      do { try feeder.run() } catch {
        try? stream.fileHandleForWriting.close()
        command.terminate()
        command.waitUntilExit()
        return SSHResult(status: SSHResult.launchFailed, stderr: "cannot run \(feeder.executableURL?.path ?? "the input"): \(error.localizedDescription)")
      }
    }

    let collected = Collected()
    let group = DispatchGroup()
    for (pipe, isError) in [(out, false), (err, true)] {
      group.enter()
      DispatchQueue.global(qos: .utility).async {
        var data = Data()
        let handle = pipe.fileHandleForReading
        while true {
          let chunk = handle.availableData
          if chunk.isEmpty { break }
          if data.count < maxOutputBytes { data.append(chunk.prefix(maxOutputBytes - data.count)) }
        }
        collected.set(data, isError: isError)
        group.leave()
      }
    }
    let expired = Expired()
    let deadline = DispatchWorkItem {
      expired.set()
      if command.isRunning { command.terminate() }
      if let feeder, feeder.isRunning { feeder.terminate() }
    }
    DispatchQueue.global().asyncAfter(deadline: .now() + timeout, execute: deadline)
    command.waitUntilExit()
    feeder?.waitUntilExit()
    deadline.cancel()
    // A process the command left behind may hold its pipes open; its output is not waited for.
    if group.wait(timeout: .now() + 2) == .timedOut {
      try? out.fileHandleForReading.close()
      try? err.fileHandleForReading.close()
    }
    let (stdout, stderr) = collected.values
    var result = SSHResult(
      status: command.terminationReason == .uncaughtSignal ? 128 + command.terminationStatus : command.terminationStatus,
      stdout: String(decoding: stdout, as: UTF8.self), stderr: String(decoding: stderr, as: UTF8.self))
    if expired.value {
      result.status = SSHResult.launchFailed
      result.stderr += "\nTimed out after \(Int(timeout)) s"
    } else if let feeder, feeder.terminationStatus != 0 || feeder.terminationReason == .uncaughtSignal, result.succeeded {
      result.status = SSHResult.launchFailed
      result.stderr += "\nThe archive could not be written (\(feeder.executableURL?.lastPathComponent ?? "input") exited with status \(feeder.terminationStatus))"
    }
    return result
  }

  private final class Collected: @unchecked Sendable {
    private let lock = NSLock()
    private var stdout = Data()
    private var stderr = Data()

    func set(_ data: Data, isError: Bool) {
      lock.withLock { if isError { stderr = data } else { stdout = data } }
    }

    var values: (Data, Data) { lock.withLock { (stdout, stderr) } }
  }

  private final class Expired: @unchecked Sendable {
    private let lock = NSLock()
    private var expired = false
    func set() { lock.withLock { expired = true } }
    var value: Bool { lock.withLock { expired } }
  }
}
#endif
