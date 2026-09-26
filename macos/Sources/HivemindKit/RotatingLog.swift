import Foundation

/// server.log with size-based rotation: server.log → server.log.1 → … →
/// server.log.<keep>, the oldest dropped. Checked on every append, so the
/// newest file never grows much past `maxBytes`. Not thread-safe: the server
/// app appends from the main actor only.
public final class RotatingLog {
  public let file: URL
  public let maxBytes: Int
  public let keep: Int
  private var handle: FileHandle?
  private var size = 0
  private let clock: () -> Date

  // ISO8601DateFormatter is documented thread-safe; it just is not marked Sendable.
  nonisolated(unsafe) private static let timestamp: ISO8601DateFormatter = {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter
  }()

  public init(file: URL, maxBytes: Int = 5 * 1024 * 1024, keep: Int = 3, clock: @escaping () -> Date = Date.init) {
    self.file = file
    self.maxBytes = maxBytes
    self.keep = max(1, keep)
    self.clock = clock
  }

  deinit { try? handle?.close() }

  /// One line, prefixed with a timestamp and the stream it came from.
  public func append(_ line: String, channel: OutputChannel? = nil) {
    let tag = channel.map { $0 == .stderr ? " [err]" : " [out]" } ?? ""
    write("\(Self.timestamp.string(from: clock()))\(tag) \(line)\n")
  }

  private func write(_ text: String) {
    let data = Data(text.utf8)
    if size + data.count > maxBytes, size > 0 { rotate() }
    guard let handle = openHandle() else { return }
    do {
      try handle.write(contentsOf: data)
      size += data.count
    } catch {
      try? handle.close()
      self.handle = nil
    }
  }

  private func openHandle() -> FileHandle? {
    if let handle { return handle }
    let fm = FileManager.default
    try? fm.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    if !fm.fileExists(atPath: file.path) {
      fm.createFile(atPath: file.path, contents: nil, attributes: [.posixPermissions: 0o600])
    }
    guard let opened = try? FileHandle(forWritingTo: file) else { return nil }
    size = Int((try? opened.seekToEnd()) ?? 0)
    handle = opened
    // An existing file already over the limit rotates before its first new line.
    if size >= maxBytes {
      rotate()
      return openHandle()
    }
    return opened
  }

  private func rotate() {
    try? handle?.close()
    handle = nil
    size = 0
    let fm = FileManager.default
    try? fm.removeItem(at: rotated(keep))
    for index in stride(from: keep - 1, through: 1, by: -1) where fm.fileExists(atPath: rotated(index).path) {
      try? fm.moveItem(at: rotated(index), to: rotated(index + 1))
    }
    try? fm.moveItem(at: file, to: rotated(1))
  }

  public func rotated(_ index: Int) -> URL {
    file.deletingLastPathComponent().appendingPathComponent("\(file.lastPathComponent).\(index)")
  }
}
