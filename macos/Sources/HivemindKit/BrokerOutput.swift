import Foundation

/// One connection's terminal output on its way out: PTY bytes gathered per
/// stream until the next batch (`BrokerLimits.outputBatchInterval`), then
/// cut into `output` messages of at most `BrokerLimits.maxOutputBytes`.
///
/// It also keeps the connection's flow-control account. `buffered` is what
/// is gathered plus what the transport has not written yet; above
/// `pauseAbove` the broker stops reading this connection's PTYs, and below
/// `resumeBelow` it reads them again. Pure bookkeeping: it reads nothing and
/// writes nothing.
public struct BrokerOutputBuffer: Sendable {
  public let chunkBytes: Int
  public let pauseAbove: Int
  public let resumeBelow: Int

  /// Streams with gathered bytes, in the order their first byte came.
  private var order: [BrokerStreamID] = []
  private var pending: [BrokerStreamID: Data] = [:]
  public private(set) var pendingBytes = 0
  /// Bytes handed to the transport and not yet reported written.
  public private(set) var unsentBytes = 0
  /// Whether the PTYs should be left unread.
  public private(set) var paused = false

  public init(
    chunkBytes: Int = BrokerLimits.maxOutputBytes,
    pauseAbove: Int = BrokerLimits.maxOutboundBytes,
    resumeBelow: Int = BrokerLimits.resumeOutboundBytes
  ) {
    self.chunkBytes = max(1, chunkBytes)
    self.pauseAbove = pauseAbove
    self.resumeBelow = min(resumeBelow, pauseAbove)
  }

  public var buffered: Int { pendingBytes + unsentBytes }
  public var isEmpty: Bool { pendingBytes == 0 }

  public mutating func append(_ data: Data, to stream: BrokerStreamID) {
    guard !data.isEmpty else { return }
    if pending[stream] == nil { order.append(stream) }
    pending[stream, default: Data()].append(data)
    pendingBytes += data.count
  }

  /// Everything gathered, as chunks in arrival order per stream.
  public mutating func takeAll() -> [(stream: BrokerStreamID, data: Data)] {
    let streams = order
    return streams.flatMap { take($0) }
  }

  /// One stream's gathered bytes, as chunks: what is sent before its `exit`.
  public mutating func take(_ stream: BrokerStreamID) -> [(stream: BrokerStreamID, data: Data)] {
    guard let data = pending.removeValue(forKey: stream) else { return [] }
    order.removeAll { $0 == stream }
    pendingBytes -= data.count
    return Self.chunks(of: data, size: chunkBytes).map { (stream, $0) }
  }

  /// Drops a stream's gathered bytes (it was detached).
  public mutating func discard(_ stream: BrokerStreamID) {
    guard let data = pending.removeValue(forKey: stream) else { return }
    order.removeAll { $0 == stream }
    pendingBytes -= data.count
  }

  /// A line of `count` bytes went to the transport.
  public mutating func queued(_ count: Int) { unsentBytes += max(0, count) }

  /// The transport wrote `count` bytes.
  public mutating func wrote(_ count: Int) { unsentBytes = max(0, unsentBytes - max(0, count)) }

  /// Re-evaluates the pause. Returns the new state when it changed.
  public mutating func updatePause() -> Bool? {
    if !paused, buffered > pauseAbove {
      paused = true
      return true
    }
    if paused, buffered < resumeBelow {
      paused = false
      return false
    }
    return nil
  }

  static func chunks(of data: Data, size: Int) -> [Data] {
    guard data.count > size else { return data.isEmpty ? [] : [data] }
    return stride(from: data.startIndex, to: data.endIndex, by: size).map {
      Data(data[$0..<min($0 + size, data.endIndex)])
    }
  }
}
