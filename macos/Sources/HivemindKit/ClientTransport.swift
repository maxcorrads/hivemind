import Foundation

// How a BrokerClient reaches the broker: a byte stream and nothing more. The
// protocol code (BrokerProtocol.swift) never knows which transport carries
// it. Now that is the local Unix socket (UnixSocketBrokerConnector); an iOS
// client will bring a remote one. Tests use a fake, so nothing in them opens
// a socket.

/// What a transport tells its client, always on the main actor and in order:
/// `onOpen` once, then `onData` any number of times, then `onClose` once
/// (without `onOpen` when connecting failed). Nothing arrives after the
/// client itself called `close()`.
public struct BrokerTransportHandlers: Sendable {
  public var onOpen: @MainActor @Sendable () -> Void
  public var onData: @MainActor @Sendable (Data) -> Void
  /// A reason for the log, or nil for an orderly end of stream.
  public var onClose: @MainActor @Sendable (String?) -> Void

  public init(
    onOpen: @escaping @MainActor @Sendable () -> Void,
    onData: @escaping @MainActor @Sendable (Data) -> Void,
    onClose: @escaping @MainActor @Sendable (String?) -> Void
  ) {
    self.onOpen = onOpen
    self.onData = onData
    self.onClose = onClose
  }
}

/// One connection to the broker.
@MainActor
public protocol BrokerTransportConnection: AnyObject {
  /// Begins connecting. Separate from creation so the client holds the
  /// connection before any handler can run.
  func start()
  /// Queues bytes to write, in order.
  func send(_ data: Data)
  /// Stops (false) or resumes (true) reading from the broker. While the
  /// client does not read, the broker's own backpressure stops reading the
  /// PTYs (docs/terminal-broker.md#flow-control-to-the-page).
  func setReading(_ reading: Bool)
  /// Closes the connection; no handler runs after this.
  func close()
}

@MainActor
public protocol BrokerConnecting {
  func connection(handlers: BrokerTransportHandlers) -> any BrokerTransportConnection
}

/// broker.token, which the broker rewrites each time it starts: read before
/// every connection. Nil when there is none (the broker has never run) or it
/// does not hold a token.
public enum BrokerTokenFile {
  static let maxBytes = 256

  public static func read(_ url: URL) -> BrokerToken? {
    let fd = open(url.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
    guard fd >= 0 else { return nil }
    defer { close(fd) }
    var buffer = [UInt8](repeating: 0, count: maxBytes + 1)
    let count = buffer.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, $0.count) }
    guard count > 0, count <= maxBytes else { return nil }
    return BrokerToken(String(decoding: buffer[0..<count], as: UTF8.self))
  }
}

/// The broker's local transport: a stream Unix socket at
/// HivemindPaths.brokerSocket.
public struct UnixSocketBrokerConnector: BrokerConnecting {
  public let path: String

  public init(path: String) {
    self.path = path
  }

  public func connection(handlers: BrokerTransportHandlers) -> any BrokerTransportConnection {
    UnixSocketBrokerConnection(path: path, handlers: handlers)
  }
}

@MainActor
final class UnixSocketBrokerConnection: BrokerTransportConnection {
  private let core: UnixSocketCore

  init(path: String, handlers: BrokerTransportHandlers) {
    core = UnixSocketCore(path: path, handlers: handlers)
  }

  func start() { core.start() }
  func send(_ data: Data) { core.send(data) }
  func setReading(_ reading: Bool) { core.setReading(reading) }
  func close() { core.close() }
}

/// POSIX socket work on a private serial queue; every field is touched only
/// there. Non-blocking after connect, with dispatch sources for reading and
/// for writing what did not fit. Reading stops while the client asks it to
/// (setReading) and while too much of what was read still waits for the
/// main actor, so neither this queue nor the main queue buffers without
/// bound.
final class UnixSocketCore: @unchecked Sendable {
  /// Bytes queued for the broker before the connection is given up: the
  /// broker reads its clients all the time, so this is only ever reached
  /// when it is stuck.
  static let maxOutboundBytes = 8 << 20
  static let readSize = 64 * 1024
  /// Bytes read and not yet handed to the client on the main actor, past
  /// which reading stops until the main actor catches up.
  static let maxUndelivered = 1 << 20

  private let path: String
  private let handlers: BrokerTransportHandlers
  private let queue = DispatchQueue(label: "hivemind.broker-client")
  private var fd: Int32 = -1
  private var readSource: (any DispatchSourceRead)?
  private var writeSource: (any DispatchSourceWrite)?
  private var writing = false
  private var outbound = Data()
  private var finished = false
  /// What the client asked for with setReading.
  private var readingWanted = true
  private var readSuspended = false
  private var undelivered = 0

  init(path: String, handlers: BrokerTransportHandlers) {
    self.path = path
    self.handlers = handlers
  }

  func start() { queue.async { self.open() } }

  func send(_ data: Data) {
    queue.async {
      guard !self.finished else { return }
      self.outbound.append(data)
      guard self.outbound.count <= Self.maxOutboundBytes else { return self.finish("Hivemind Server is not reading") }
      self.flush()
    }
  }

  func close() { queue.async { self.finish(nil, notify: false) } }

  func setReading(_ reading: Bool) {
    queue.async {
      self.readingWanted = reading
      self.updateReading()
    }
  }

  private func open() {
    guard !finished else { return }
    guard BrokerPaths.fitsSocketAddress(URL(fileURLWithPath: path)) else {
      return finish("The broker socket path is too long: \(path)")
    }
    let socketFD = socket(AF_UNIX, SOCK_STREAM, 0)
    guard socketFD >= 0 else { return finish(Self.lastError("socket")) }
    fd = socketFD
    _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
    var one: Int32 = 1
    _ = setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))

    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    let bytes = Array(path.utf8)
    withUnsafeMutableBytes(of: &address.sun_path) { raw in
      raw.copyBytes(from: bytes)
      raw[bytes.count] = 0
    }
    // A Unix socket connects at once (or fails at once), so a blocking
    // connect here, off the main thread, is fine.
    let connected = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
        Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
      }
    }
    guard connected == 0 else { return finish(Self.lastError("connect")) }
    let flags = fcntl(fd, F_GETFL)
    guard flags >= 0, fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0 else { return finish(Self.lastError("fcntl")) }

    let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
    // The sources hold the core until finish() cancels them.
    source.setEventHandler { self.readAvailable() }
    readSource = source
    source.resume()
    updateReading()
    let handlers = handlers
    DispatchQueue.main.async { MainActor.assumeIsolated { handlers.onOpen() } }
    flush()
  }

  /// Suspends or resumes the read source to match what the client wants
  /// and how much the main actor has yet to take.
  private func updateReading() {
    guard !finished, let readSource else { return }
    let suspend = !readingWanted || undelivered > Self.maxUndelivered
    if suspend, !readSuspended {
      readSuspended = true
      readSource.suspend()
    } else if !suspend, readSuspended {
      readSuspended = false
      readSource.resume()
    }
  }

  private func readAvailable() {
    guard !finished else { return }
    var buffer = [UInt8](repeating: 0, count: Self.readSize)
    let count = buffer.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, $0.count) }
    if count > 0 {
      let data = Data(buffer[0..<count])
      let handlers = handlers
      undelivered += count
      updateReading()
      DispatchQueue.main.async {
        MainActor.assumeIsolated { handlers.onData(data) }
        self.queue.async {
          self.undelivered -= count
          self.updateReading()
        }
      }
    } else if count == 0 {
      finish(nil)
    } else if errno != EAGAIN, errno != EINTR {
      finish(Self.lastError("read"))
    }
  }

  private func flush() {
    guard !finished, fd >= 0, readSource != nil else { return }
    while !outbound.isEmpty {
      let written = outbound.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, $0.count) }
      if written > 0 {
        outbound.removeFirst(written)
      } else if written < 0, errno == EINTR {
        continue
      } else if written < 0, errno == EAGAIN {
        return waitForWritable()
      } else {
        return finish(Self.lastError("write"))
      }
    }
    if writing, let writeSource {
      writeSource.suspend()
      writing = false
    }
  }

  private func waitForWritable() {
    if writeSource == nil {
      let source = DispatchSource.makeWriteSource(fileDescriptor: fd, queue: queue)
      source.setEventHandler { self.flush() }
      writeSource = source
    }
    if !writing {
      writing = true
      writeSource?.resume()
    }
  }

  /// Ends the connection once: cancels both sources, closes the socket when
  /// the last one is done with it, and tells the client unless it asked.
  private func finish(_ reason: String?, notify: Bool = true) {
    guard !finished else { return }
    finished = true
    outbound = Data()
    let socketFD = fd
    fd = -1
    let sources: [any DispatchSourceProtocol] = [readSource, writeSource].compactMap { $0 }
    let suspendedRead = readSuspended ? readSource : nil
    readSource = nil
    readSuspended = false
    if sources.isEmpty {
      if socketFD >= 0 { Darwin.close(socketFD) }
    } else {
      // Cancel handlers run on `queue`, one at a time.
      let remaining = CancelCount(sources.count)
      for source in sources {
        source.setCancelHandler {
          if remaining.decrement() == 0, socketFD >= 0 { Darwin.close(socketFD) }
        }
        source.cancel()
      }
      // A suspended source never runs its cancel handler (and must not be
      // released suspended).
      if let writeSource, !writing { writeSource.resume() }
      suspendedRead?.resume()
    }
    writeSource = nil
    writing = false
    guard notify else { return }
    let handlers = handlers
    DispatchQueue.main.async { MainActor.assumeIsolated { handlers.onClose(reason) } }
  }

  private static func lastError(_ call: String) -> String {
    "\(call): \(String(cString: strerror(errno)))"
  }
}

private final class CancelCount: @unchecked Sendable {
  private var value: Int
  init(_ value: Int) { self.value = value }
  func decrement() -> Int {
    value -= 1
    return value
  }
}
