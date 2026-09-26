import Foundation

/// What to run. Kept a value so tests can assert on it without launching.
public struct LaunchSpec: Equatable, Sendable {
  public var executable: URL
  public var arguments: [String]
  public var environment: [String: String]
  public var workingDirectory: URL?

  public init(executable: URL, arguments: [String], environment: [String: String], workingDirectory: URL? = nil) {
    self.executable = executable
    self.arguments = arguments
    self.environment = environment
    self.workingDirectory = workingDirectory
  }
}

public enum OutputChannel: Sendable, Equatable { case stdout, stderr }

public struct ProcessExit: Equatable, Sendable, CustomStringConvertible {
  public enum Reason: Sendable, Equatable { case exited, signaled }
  public var reason: Reason
  /// Exit status, or the signal number when `reason == .signaled`.
  public var status: Int32

  public init(reason: Reason, status: Int32) {
    self.reason = reason
    self.status = status
  }

  public var description: String {
    reason == .exited ? "exited with status \(status)" : "killed by signal \(status)"
  }
}

/// A running child. terminate() is SIGTERM, kill() is SIGKILL.
@MainActor
public protocol SupervisedProcess: AnyObject {
  var pid: Int32 { get }
  func terminate()
  func kill()
}

/// Starts children. The real one wraps Foundation.Process; tests use a fake
/// that never spawns anything. Output arrives line by line, and every line a
/// child printed is delivered before its exit.
@MainActor
public protocol ProcessLaunching {
  func launch(
    _ spec: LaunchSpec,
    onOutput: @escaping @MainActor @Sendable (OutputChannel, String) -> Void,
    onExit: @escaping @MainActor @Sendable (ProcessExit) -> Void
  ) throws -> any SupervisedProcess
}

public protocol Cancellable: AnyObject {
  func cancel()
}

/// Time, injectable so backoff and kill timeouts are tested without waiting.
@MainActor
public protocol Scheduling {
  func now() -> Date
  @discardableResult
  func schedule(after delay: TimeInterval, _ work: @escaping @MainActor @Sendable () -> Void) -> any Cancellable
}

/// The main-queue scheduler the apps use.
public struct MainQueueScheduler: Scheduling {
  public init() {}

  public func now() -> Date { Date() }

  public func schedule(after delay: TimeInterval, _ work: @escaping @MainActor @Sendable () -> Void) -> any Cancellable {
    let item = DispatchWorkItem { MainActor.assumeIsolated { work() } }
    DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: item)
    return WorkItemCancellable(item: item)
  }

  private final class WorkItemCancellable: Cancellable {
    let item: DispatchWorkItem
    init(item: DispatchWorkItem) { self.item = item }
    func cancel() { item.cancel() }
  }
}

/// Splits a byte stream into lines. Invalid UTF-8 is replaced rather than
/// dropped, and a line longer than `maxLineBytes` is cut so a runaway child
/// cannot grow the buffer without bound.
public struct LineSplitter: Sendable {
  public let maxLineBytes: Int
  private var pending = Data()

  public init(maxLineBytes: Int = 16 * 1024) { self.maxLineBytes = maxLineBytes }

  public mutating func append(_ data: Data) -> [String] {
    pending.append(data)
    var lines: [String] = []
    while let newline = pending.firstIndex(of: 0x0A) {
      lines.append(Self.decode(pending[pending.startIndex..<newline]))
      pending.removeSubrange(pending.startIndex...newline)
    }
    while pending.count > maxLineBytes {
      let cut = pending.index(pending.startIndex, offsetBy: maxLineBytes)
      lines.append(Self.decode(pending[pending.startIndex..<cut]))
      pending.removeSubrange(pending.startIndex..<cut)
    }
    return lines
  }

  /// The unterminated tail, at end of stream.
  public mutating func finish() -> [String] {
    defer { pending.removeAll() }
    return pending.isEmpty ? [] : [Self.decode(pending)]
  }

  private static func decode(_ bytes: Data) -> String {
    var line = String(decoding: bytes, as: UTF8.self)
    if line.hasSuffix("\r") { line.removeLast() }
    return line
  }
}

/// Foundation.Process behind SupervisedProcess. All pipe reads and the exit
/// go through one serial queue and then the main queue, which is what keeps
/// the "all output before exit" promise.
public struct FoundationProcessLauncher: ProcessLaunching {
  public init() {}

  public func launch(
    _ spec: LaunchSpec,
    onOutput: @escaping @MainActor @Sendable (OutputChannel, String) -> Void,
    onExit: @escaping @MainActor @Sendable (ProcessExit) -> Void
  ) throws -> any SupervisedProcess {
    let process = Process()
    process.executableURL = spec.executable
    process.arguments = spec.arguments
    process.environment = spec.environment
    process.currentDirectoryURL = spec.workingDirectory
    process.standardInput = FileHandle.nullDevice
    let out = Pipe(), err = Pipe()
    process.standardOutput = out
    process.standardError = err

    let reader = PipeReader(onOutput: onOutput)
    reader.attach(out.fileHandleForReading, as: .stdout)
    reader.attach(err.fileHandleForReading, as: .stderr)
    process.terminationHandler = { finished in
      let exit = ProcessExit(
        reason: finished.terminationReason == .uncaughtSignal ? .signaled : .exited,
        status: finished.terminationStatus)
      reader.finish { MainActor.assumeIsolated { onExit(exit) } }
    }
    try process.run()
    return FoundationProcess(process: process)
  }
}

@MainActor
final class FoundationProcess: SupervisedProcess {
  private let process: Process
  let pid: Int32

  init(process: Process) {
    self.process = process
    pid = process.processIdentifier
  }

  func terminate() { if process.isRunning { process.terminate() } }
  func kill() { if process.isRunning { Darwin.kill(pid, SIGKILL) } }
}

private final class PipeReader: @unchecked Sendable {
  // Everything below is touched only on `queue`.
  private let queue = DispatchQueue(label: "hivemind.process-output")
  private var splitters: [OutputChannel: LineSplitter] = [:]
  private var handles: [OutputChannel: FileHandle] = [:]
  private let onOutput: @MainActor @Sendable (OutputChannel, String) -> Void

  init(onOutput: @escaping @MainActor @Sendable (OutputChannel, String) -> Void) { self.onOutput = onOutput }

  func attach(_ handle: FileHandle, as channel: OutputChannel) {
    queue.sync {
      splitters[channel] = LineSplitter()
      handles[channel] = handle
    }
    handle.readabilityHandler = { [weak self] handle in
      let data = handle.availableData
      // Empty means EOF; left installed, the handler would spin on it.
      if data.isEmpty { handle.readabilityHandler = nil }
      self?.queue.sync { self?.consume(data, from: channel) }
    }
  }

  /// Drains what is left on both pipes, then runs `done` on the main queue.
  /// Reads without blocking: a grandchild that inherited the pipe (a worker
  /// the server spawned) may hold it open long after the server exited.
  func finish(_ done: @escaping @Sendable () -> Void) {
    queue.async { [self] in
      for (channel, handle) in handles {
        handle.readabilityHandler = nil
        consume(Self.readAvailable(handle.fileDescriptor), from: channel)
        emit(splitters[channel]?.finish() ?? [], from: channel)
      }
      handles.removeAll()
      DispatchQueue.main.async(execute: done)
    }
  }

  private static func readAvailable(_ fd: Int32) -> Data {
    _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
    var data = Data()
    var buffer = [UInt8](repeating: 0, count: 64 * 1024)
    while data.count < 1 << 20 {
      let count = buffer.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, $0.count) }
      if count <= 0 { break }
      data.append(contentsOf: buffer[0..<count])
    }
    return data
  }

  private func consume(_ data: Data, from channel: OutputChannel) {
    guard !data.isEmpty, var splitter = splitters[channel] else { return }
    let lines = splitter.append(data)
    splitters[channel] = splitter
    emit(lines, from: channel)
  }

  private func emit(_ lines: [String], from channel: OutputChannel) {
    guard !lines.isEmpty else { return }
    let onOutput = self.onOutput
    DispatchQueue.main.async { MainActor.assumeIsolated { for line in lines { onOutput(channel, line) } } }
  }
}
