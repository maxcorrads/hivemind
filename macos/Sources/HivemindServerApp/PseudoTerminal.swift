import Darwin
import Foundation
import HivemindKit

/// Opens a PTY per stream with forkpty and runs `tmux attach-session` on its
/// slave side, as the session leader with the PTY as its controlling
/// terminal, so TIOCSWINSZ reaches it as SIGWINCH.
struct PseudoTerminalSpawner: BrokerTerminalSpawning {
  func spawn(
    _ spec: BrokerTerminalSpec,
    onOutput: @escaping @MainActor @Sendable (Data) -> Void,
    onExit: @escaping @MainActor @Sendable (Int?) -> Void
  ) throws -> any BrokerTerminal {
    try PseudoTerminal(spec: spec, onOutput: onOutput, onExit: onExit)
  }
}

struct PseudoTerminalError: Error, LocalizedError {
  let message: String
  var errorDescription: String? { message }
}

@MainActor
final class PseudoTerminal: BrokerTerminal {
  private let io: PseudoTerminalIO
  private let onOutput: @MainActor @Sendable (Data) -> Void
  private let onExit: @MainActor @Sendable (Int?) -> Void
  /// After terminate() neither callback runs again.
  private var terminated = false

  init(
    spec: BrokerTerminalSpec,
    onOutput: @escaping @MainActor @Sendable (Data) -> Void,
    onExit: @escaping @MainActor @Sendable (Int?) -> Void
  ) throws {
    self.onOutput = onOutput
    self.onExit = onExit
    let (fd, pid) = try Self.fork(spec)
    io = PseudoTerminalIO(fd: fd, pid: pid)
    io.start(
      output: { [weak self] data in
        guard let self, !self.terminated else { return }
        self.onOutput(data)
      },
      exit: { [weak self] status in
        guard let self, !self.terminated else { return }
        self.terminated = true
        self.onExit(status)
      })
  }

  func write(_ data: Data) -> Bool { io.write(data) }

  func resize(_ size: TerminalSize) { io.resize(size) }

  func setReading(_ reading: Bool) { io.setReading(reading) }

  func terminate() {
    guard !terminated else { return }
    terminated = true
    io.hangUp()
  }

  // MARK: fork

  /// Everything the child needs is built before fork: between fork and exec
  /// the child may only make async-signal-safe calls, so it touches no
  /// Swift allocation, lock or object.
  private static func fork(_ spec: BrokerTerminalSpec) throws -> (Int32, pid_t) {
    let argv = CStrings([spec.executable] + spec.arguments)
    let envp = CStrings(spec.environment.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" })
    defer {
      argv.free()
      envp.free()
    }
    var size = winsize(ws_row: UInt16(spec.size.rows), ws_col: UInt16(spec.size.columns), ws_xpixel: 0, ws_ypixel: 0)
    // Descriptors the child must not inherit: sockets, other PTYs, pipes.
    let lastDescriptor = min(getdtablesize(), 65_536)
    var defaultAction = sigaction()
    defaultAction.__sigaction_u.__sa_handler = SIG_DFL
    var noSignals = sigset_t()
    sigemptyset(&noSignals)
    let path = argv.pointer[0]!
    let arguments = argv.pointer
    let environment = envp.pointer

    var master: Int32 = -1
    let pid = forkpty(&master, nil, nil, &size)
    if pid < 0 {
      throw PseudoTerminalError(message: "forkpty failed: \(String(cString: strerror(errno)))")
    }
    if pid == 0 {
      // The child: forkpty made it a session leader with the PTY slave as
      // its controlling terminal and its stdin, stdout and stderr.
      var fd: Int32 = 3
      while fd < lastDescriptor {
        close(fd)
        fd += 1
      }
      // The app ignores SIGPIPE; tmux should start from the defaults.
      sigaction(SIGPIPE, &defaultAction, nil)
      sigprocmask(SIG_SETMASK, &noSignals, nil)
      execve(path, arguments, environment)
      _exit(127)
    }
    _ = fcntl(master, F_SETFD, FD_CLOEXEC)
    _ = fcntl(master, F_SETFL, fcntl(master, F_GETFL) | O_NONBLOCK)
    return (master, pid)
  }
}

/// A NULL-terminated array of C strings, for execve.
private struct CStrings {
  let pointer: UnsafeMutablePointer<UnsafeMutablePointer<CChar>?>
  let count: Int

  init(_ strings: [String]) {
    count = strings.count
    pointer = .allocate(capacity: strings.count + 1)
    for (index, string) in strings.enumerated() { pointer[index] = strdup(string) }
    pointer[strings.count] = nil
  }

  func free() {
    for index in 0..<count { Darwin.free(pointer[index]) }
    pointer.deallocate()
  }
}

/// The PTY master's I/O, all on one serial queue: reads (paused for the
/// broker's backpressure, and while too much output waits for the main
/// queue: PTYReadGate), queued writes, the window size, and reaping the child.
/// The exit is delivered after every read before it, once the child is
/// reaped; the master is closed only then.
private final class PseudoTerminalIO: @unchecked Sendable {
  // Everything below is touched only on `queue`, except the constants.
  private let queue = DispatchQueue(label: "hivemind.broker.pty")
  private let fd: Int32
  private let pid: pid_t
  private var readSource: DispatchSourceRead?
  private var writeSource: DispatchSourceWrite?
  private var processSource: DispatchSourceProcess?
  private var readSuspended = false
  /// Whether reading should run: the broker's wish, and output read but not
  /// yet delivered on the main queue kept under PTYReadGate.highWater.
  private var readGate = PTYReadGate()
  private var writeSuspended = true
  private var pendingInput = Data()
  private var reaped = false
  private var finished = false
  private var liveSources = 0
  private var output: (@Sendable (Data) -> Void)?
  private var exit: (@Sendable (Int?) -> Void)?

  /// Input the child has not read yet past which more is refused.
  static let maxPendingInput = 1 << 20
  /// Bytes read at once, and at most drained after the child exited.
  static let readSize = 64 * 1024
  static let maxDrain = 4 << 20
  /// How long a hung-up child has before SIGKILL.
  static let killDelay: TimeInterval = 2

  init(fd: Int32, pid: pid_t) {
    self.fd = fd
    self.pid = pid
  }

  func start(output: @escaping @MainActor @Sendable (Data) -> Void, exit: @escaping @MainActor @Sendable (Int?) -> Void) {
    queue.sync {
      // Each chunk is counted until the main queue has taken it.
      self.output = { [weak self] data in
        let count = data.count
        DispatchQueue.main.async {
          MainActor.assumeIsolated { output(data) }
          self?.queue.async { [weak self] in self?.delivered(count) }
        }
      }
      self.exit = { status in DispatchQueue.main.async { MainActor.assumeIsolated { exit(status) } } }

      let read = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
      read.setEventHandler { [unowned self] in self.readAvailable(limit: Self.readSize) }
      read.setCancelHandler { [self] in self.sourceCancelled() }
      readSource = read
      liveSources += 1
      read.activate()

      let write = DispatchSource.makeWriteSource(fileDescriptor: fd, queue: queue)
      write.setEventHandler { [unowned self] in self.writePending() }
      write.setCancelHandler { [self] in self.sourceCancelled() }
      writeSource = write
      liveSources += 1
      // Created suspended: resumed only while input is waiting.
      write.activate()
      write.suspend()

      let process = DispatchSource.makeProcessSource(identifier: pid, eventMask: .exit, queue: queue)
      process.setEventHandler { [self] in self.reap() }
      processSource = process
      process.activate()
      // The child may have exited before the source watched it.
      reap()
    }
  }

  func write(_ data: Data) -> Bool {
    queue.sync {
      guard !finished else { return false }
      guard pendingInput.count + data.count <= Self.maxPendingInput else { return false }
      pendingInput.append(data)
      writePending()
      return true
    }
  }

  func resize(_ size: TerminalSize) {
    queue.async { [self] in
      guard !finished else { return }
      var window = winsize(ws_row: UInt16(size.rows), ws_col: UInt16(size.columns), ws_xpixel: 0, ws_ypixel: 0)
      _ = ioctl(fd, TIOCSWINSZ, &window)
    }
  }

  func setReading(_ reading: Bool) {
    queue.async { [self] in
      _ = readGate.setWanted(reading)
      syncReading()
    }
  }

  /// SIGHUP now (a tmux client detaches on it), SIGKILL if it lingers. The
  /// callbacks are already silenced by the caller.
  func hangUp() {
    queue.sync {
      output = nil
      exit = nil
      guard !reaped else { return }
      // Not reaped yet, so the pid is still this child's.
      Darwin.kill(pid, SIGHUP)
      queue.asyncAfter(deadline: .now() + Self.killDelay) { [self] in
        if !reaped { Darwin.kill(pid, SIGKILL) }
      }
    }
  }

  // MARK: On the queue

  private func delivered(_ count: Int) {
    _ = readGate.delivered(count)
    syncReading()
  }

  /// Suspends or resumes the read source to match `readGate`.
  private func syncReading() {
    guard !finished, let readSource else { return }
    if readGate.reading, readSuspended {
      readSuspended = false
      readSource.resume()
    } else if !readGate.reading, !readSuspended {
      readSuspended = true
      readSource.suspend()
    }
  }

  private func readAvailable(limit: Int) {
    var buffer = [UInt8](repeating: 0, count: Self.readSize)
    var total = 0
    while total < limit {
      let count = buffer.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, $0.count) }
      if count > 0 {
        total += count
        if let output {
          output(Data(buffer[0..<count]))
          _ = readGate.read(count)
        }
        if limit == Self.readSize {
          syncReading()
          return
        }
        continue
      }
      if count < 0, errno == EINTR { continue }
      // EAGAIN: nothing more now. 0 or EIO: the slave side is closed; the
      // exit comes from the process source.
      if count == 0 || (count < 0 && errno != EAGAIN) { stopReading() }
      return
    }
  }

  private func stopReading() {
    guard let readSource else { return }
    self.readSource = nil
    if readSuspended {
      readSuspended = false
      readSource.resume()
    }
    readSource.cancel()
  }

  private func writePending() {
    while !pendingInput.isEmpty {
      let count = pendingInput.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, $0.count) }
      if count > 0 {
        pendingInput.removeFirst(count)
        continue
      }
      if count < 0, errno == EINTR { continue }
      if count < 0, errno == EAGAIN {
        if writeSuspended, let writeSource {
          writeSuspended = false
          writeSource.resume()
        }
        return
      }
      // The child is gone; what it did not read is dropped.
      pendingInput.removeAll()
      break
    }
    if !writeSuspended, let writeSource {
      writeSuspended = true
      writeSource.suspend()
    }
  }

  private func reap() {
    guard !reaped else { return }
    var status: Int32 = 0
    let result = waitpid(pid, &status, WNOHANG)
    guard result == pid || (result < 0 && errno == ECHILD) else { return }
    reaped = true
    processSource?.cancel()
    processSource = nil
    // What the child printed last is read before its exit is reported.
    if readSource != nil { readAvailable(limit: Self.maxDrain) }
    stopReading()
    if let writeSource {
      self.writeSource = nil
      if writeSuspended {
        writeSuspended = false
        writeSource.resume()
      }
      writeSource.cancel()
    }
    pendingInput.removeAll()
    finished = true
    // WIFEXITED / WEXITSTATUS, which Swift does not import.
    let exited = result == pid && (status & 0x7f) == 0
    exit?(exited ? Int((status >> 8) & 0xff) : nil)
    exit = nil
    output = nil
  }

  /// The master is closed once no dispatch source uses it.
  private func sourceCancelled() {
    liveSources -= 1
    if liveSources == 0 { close(fd) }
  }
}
