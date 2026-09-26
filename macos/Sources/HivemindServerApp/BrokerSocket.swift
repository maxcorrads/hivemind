import Darwin
import Foundation
import HivemindKit

// The broker's local transport: a Unix domain socket at
// HivemindPaths.brokerSocket, 0600 inside the 0700 app-support folder,
// accepting only peers running as this user. Each accepted socket becomes a
// SocketTransport, a byte pipe to one BrokerConnection.

struct BrokerSocketError: Error, LocalizedError {
  let message: String
  var errorDescription: String? { message }

  static func posix(_ what: String) -> BrokerSocketError {
    BrokerSocketError(message: "\(what): \(String(cString: strerror(errno)))")
  }
}

@MainActor
final class BrokerSocketListener {
  let path: String
  private let onAccept: @MainActor @Sendable (Int32) -> Void
  private var fd: Int32 = -1
  private var source: DispatchSourceRead?
  /// The socket file bind made, so stop() never removes another's.
  private var boundFile: (device: dev_t, inode: ino_t)?

  static let backlog: Int32 = 16

  init(path: String, onAccept: @escaping @MainActor @Sendable (Int32) -> Void) {
    self.path = path
    self.onAccept = onAccept
  }

  func start() throws {
    guard fd < 0 else { return }
    try removeStaleSocket()
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { throw BrokerSocketError.posix("socket") }
    var ok = false
    defer { if !ok { close(fd) } }
    _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
    _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
    guard var address = Self.address(path) else {
      throw BrokerSocketError(message: "The socket path is too long: \(path)")
    }
    let bound = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    }
    guard bound == 0 else { throw BrokerSocketError.posix("Cannot bind \(path)") }
    // bind made the file with the umask's mode; the folder is 0700 anyway.
    guard chmod(path, 0o600) == 0 else {
      unlink(path)
      throw BrokerSocketError.posix("Cannot make \(path) private")
    }
    var info = stat()
    if lstat(path, &info) == 0 { boundFile = (info.st_dev, info.st_ino) }
    guard listen(fd, Self.backlog) == 0 else {
      unlink(path)
      throw BrokerSocketError.posix("Cannot listen on \(path)")
    }
    ok = true
    self.fd = fd

    let onAccept = self.onAccept
    let source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: .main)
    source.setEventHandler { [weak source] in
      while true {
        let client = accept(fd, nil, nil)
        if client < 0 {
          if errno == EINTR { continue }
          // Out of descriptors, the pending connection keeps the socket readable: pause instead of spinning on
          // the main queue. The delayed resume holds the source, so a stop() meanwhile cancels it safely.
          if errno == EMFILE || errno == ENFILE, let source {
            source.suspend()
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { source.resume() }
          }
          return
        }
        MainActor.assumeIsolated { onAccept(client) }
      }
    }
    source.setCancelHandler { close(fd) }
    self.source = source
    source.activate()
  }

  /// Stops accepting and removes the socket file. Connections already
  /// accepted are the broker's to close.
  func stop() {
    guard let source else { return }
    self.source = nil
    fd = -1
    source.cancel()
    var info = stat()
    if let boundFile, lstat(path, &info) == 0, info.st_dev == boundFile.device, info.st_ino == boundFile.inode {
      unlink(path)
    }
    boundFile = nil
  }

  /// A socket file left by a broker that did not stop cleanly is removed;
  /// one a running broker still answers on is not.
  private func removeStaleSocket() throws {
    var info = stat()
    guard lstat(path, &info) == 0 else { return }
    guard (info.st_mode & S_IFMT) == S_IFSOCK else {
      throw BrokerSocketError(message: "\(path) exists and is not a socket")
    }
    if Self.answers(path) {
      throw BrokerSocketError(message: "Another Hivemind Server is already serving terminals")
    }
    guard unlink(path) == 0 else { throw BrokerSocketError.posix("Cannot remove the old \(path)") }
  }

  /// Whether something accepts connections on the socket at `path`. A Unix
  /// socket connect answers at once: refused when nobody listens.
  private static func answers(_ path: String) -> Bool {
    guard var address = address(path) else { return false }
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { return false }
    defer { close(fd) }
    let connected = withUnsafePointer(to: &address) {
      $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    }
    return connected == 0
  }

  static func address(_ path: String) -> sockaddr_un? {
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8)
    let capacity = MemoryLayout.size(ofValue: address.sun_path)
    guard !bytes.isEmpty, bytes.count < capacity else { return nil }
    withUnsafeMutableBytes(of: &address.sun_path) { raw in
      raw.copyBytes(from: bytes)
      raw[bytes.count] = 0
    }
    address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    return address
  }
}

/// One accepted socket as a BrokerTransport. Reads and writes happen on the
/// socket's own queue; what was read is handed to the connection on the main
/// actor. Reading pauses while too much of it waits there, so a client that
/// floods the socket is held back by the kernel instead of by memory.
@MainActor
final class SocketTransport: BrokerTransport {
  private let io: SocketIO

  /// Nil (and the socket closed) for a peer that is not this user.
  init?(fd: Int32) {
    var uid: uid_t = 0
    var gid: gid_t = 0
    guard getpeereid(fd, &uid, &gid) == 0, uid == getuid() else {
      Darwin.close(fd)
      return nil
    }
    var on: Int32 = 1
    _ = setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
    _ = fcntl(fd, F_SETFD, FD_CLOEXEC)
    _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
    io = SocketIO(fd: fd)
  }

  /// Starts reading into `connection`.
  func start(_ connection: BrokerConnection) {
    io.start(
      received: { [weak connection] data in connection?.received(data) },
      wrote: { [weak connection] count in connection?.wrote(count) },
      closed: { [weak connection] in connection?.closed() })
  }

  func send(_ data: Data) { io.send(data) }

  func close() { io.closeAfterFlush() }
}

private final class SocketIO: @unchecked Sendable {
  // Everything below is touched only on `queue`, except the constants.
  private let queue = DispatchQueue(label: "hivemind.broker.socket")
  private let fd: Int32
  private var readSource: DispatchSourceRead?
  private var writeSource: DispatchSourceWrite?
  private var readSuspended = false
  private var writeSuspended = true
  private var outgoing = Data()
  /// Bytes read and not yet taken by the connection on the main actor.
  private var undelivered = 0
  private var closing = false
  private var isClosed = false
  private var started = false
  private var liveSources = 0
  private var received: (@MainActor @Sendable (Data) -> Void)?
  private var wrote: (@MainActor @Sendable (Int) -> Void)?
  private var closed: (@MainActor @Sendable () -> Void)?

  static let readSize = 64 * 1024
  static let maxUndelivered = 4 << 20
  /// How long a close waits for queued bytes to be written.
  static let closeGrace: TimeInterval = 2

  init(fd: Int32) {
    self.fd = fd
  }

  func start(
    received: @escaping @MainActor @Sendable (Data) -> Void,
    wrote: @escaping @MainActor @Sendable (Int) -> Void,
    closed: @escaping @MainActor @Sendable () -> Void
  ) {
    queue.async { [self] in
      guard !isClosed else { return }
      started = true
      self.received = received
      self.wrote = wrote
      self.closed = closed

      let read = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
      read.setEventHandler { [unowned self] in self.readAvailable() }
      read.setCancelHandler { [self] in self.sourceCancelled() }
      readSource = read
      liveSources += 1
      read.activate()

      let write = DispatchSource.makeWriteSource(fileDescriptor: fd, queue: queue)
      write.setEventHandler { [unowned self] in self.writePending() }
      write.setCancelHandler { [self] in self.sourceCancelled() }
      writeSource = write
      liveSources += 1
      write.activate()
      write.suspend()
      if !outgoing.isEmpty { writePending() }
    }
  }

  func send(_ data: Data) {
    queue.async { [self] in
      guard !isClosed, !closing else { return }
      outgoing.append(data)
      if started { writePending() }
    }
  }

  func closeAfterFlush() {
    queue.async { [self] in
      guard !isClosed, !closing else { return }
      closing = true
      if outgoing.isEmpty || !started {
        shutDown()
      } else {
        queue.asyncAfter(deadline: .now() + Self.closeGrace) { [self] in shutDown() }
      }
    }
  }

  // MARK: On the queue

  private func readAvailable() {
    var buffer = [UInt8](repeating: 0, count: Self.readSize)
    let count = buffer.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, $0.count) }
    if count > 0 {
      guard !closing else { return }
      let data = Data(buffer[0..<count])
      undelivered += count
      if undelivered > Self.maxUndelivered { suspendReading() }
      let received = self.received
      DispatchQueue.main.async { [self] in
        MainActor.assumeIsolated { received?(data) }
        queue.async { [self] in
          undelivered -= count
          if undelivered <= Self.maxUndelivered / 2 { resumeReading() }
        }
      }
      return
    }
    if count < 0, errno == EAGAIN || errno == EINTR { return }
    // 0: the peer closed; anything else: the socket failed.
    shutDown()
  }

  private func suspendReading() {
    guard !readSuspended, let readSource else { return }
    readSuspended = true
    readSource.suspend()
  }

  private func resumeReading() {
    guard readSuspended, let readSource else { return }
    readSuspended = false
    readSource.resume()
  }

  private func writePending() {
    var written = 0
    while !outgoing.isEmpty {
      let count = outgoing.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, $0.count) }
      if count > 0 {
        outgoing.removeFirst(count)
        written += count
        continue
      }
      if count < 0, errno == EINTR { continue }
      if count < 0, errno == EAGAIN {
        if writeSuspended, let writeSource {
          writeSuspended = false
          writeSource.resume()
        }
        break
      }
      shutDown()
      return
    }
    if written > 0, let wrote {
      DispatchQueue.main.async { MainActor.assumeIsolated { wrote(written) } }
    }
    if outgoing.isEmpty {
      if !writeSuspended, let writeSource {
        writeSuspended = true
        writeSource.suspend()
      }
      if closing { shutDown() }
    }
  }

  private func shutDown() {
    guard !isClosed else { return }
    isClosed = true
    outgoing.removeAll()
    if let readSource {
      self.readSource = nil
      if readSuspended { readSource.resume() }
      readSource.cancel()
    }
    if let writeSource {
      self.writeSource = nil
      if writeSuspended { writeSource.resume() }
      writeSource.cancel()
    }
    if liveSources == 0 { close(fd) }
    if let closed {
      DispatchQueue.main.async { MainActor.assumeIsolated { closed() } }
    }
    received = nil
    wrote = nil
    closed = nil
  }

  /// The socket is closed once no dispatch source uses it.
  private func sourceCancelled() {
    liveSources -= 1
    if liveSources == 0 { close(fd) }
  }
}
