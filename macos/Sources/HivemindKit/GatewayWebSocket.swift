import Foundation
#if canImport(CryptoKit)
import CryptoKit
#endif

// The WebSocket pieces the gateway needs (RFC 6455). The Node server's /ws
// is only spliced, byte for byte, after its own 101; but /_hivemind/broker
// ends at the gateway, which speaks the server side itself: the handshake,
// reading masked client frames and writing unmasked ones.

public enum WebSocketHandshake {
  static let guid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

  /// Whether `head` asks for any upgrade at all.
  public static func isUpgrade(_ head: HTTPRequestHead) -> Bool { head.headers.contains("Upgrade") }

  /// The Sec-WebSocket-Key of a valid client handshake: GET over HTTP/1.1,
  /// `Connection: upgrade`, `Upgrade: websocket`, version 13 and a key of
  /// 16 base64 bytes, each header exactly once.
  public static func key(of head: HTTPRequestHead) throws(GatewayError) -> String {
    let headers = head.headers
    guard head.method == "GET", head.version == .http11 else { throw bad("a WebSocket upgrade must be GET over HTTP/1.1") }
    guard headers.tokens("Connection").contains("upgrade"), headers.tokens("Upgrade") == ["websocket"] else {
      throw bad("not a WebSocket upgrade")
    }
    guard headers.values("Sec-WebSocket-Version") == ["13"] else { throw bad("Sec-WebSocket-Version must be 13") }
    let keys = headers.values("Sec-WebSocket-Key")
    guard keys.count == 1, keys[0].utf8.count == 24, let decoded = Data(base64Encoded: keys[0]), decoded.count == 16 else {
      throw bad("a malformed Sec-WebSocket-Key")
    }
    return keys[0]
  }

  /// Sec-WebSocket-Accept for `key`: base64(SHA-1(key + GUID)).
  public static func accept(forKey key: String) -> String {
    SHA1.hash(Array((key + guid).utf8)).base64EncodedString()
  }

  /// The 101 that completes the handshake.
  public static func response(forKey key: String) -> HTTPResponseHead {
    HTTPResponseHead(status: 101, headers: [
      "Upgrade": "websocket",
      "Connection": "Upgrade",
      "Sec-WebSocket-Accept": accept(forKey: key),
    ])
  }

  private static func bad(_ message: String) -> GatewayError { GatewayError(.badRequest, message) }
}

public enum WebSocketOpcode: UInt8, Sendable {
  case continuation = 0x0
  case text = 0x1
  case binary = 0x2
  case close = 0x8
  case ping = 0x9
  case pong = 0xA

  var isControl: Bool { rawValue & 0x8 != 0 }
}

/// Close codes the gateway sends (RFC 6455 §7.4.1).
public enum WebSocketCloseCode: UInt16, Sendable {
  case normal = 1000
  case goingAway = 1001
  case protocolError = 1002
  case unsupportedData = 1003
  case invalidPayload = 1007
  case policyViolation = 1008
  case tooBig = 1009
  case internalError = 1011
}

public enum WebSocketFrame {
  /// A server frame: FIN set, never masked (RFC 6455 §5.1).
  public static func encode(_ opcode: WebSocketOpcode, _ payload: Data = Data(), mask: [UInt8]? = nil) -> Data {
    var out = Data([0x80 | opcode.rawValue])
    let maskBit: UInt8 = mask == nil ? 0 : 0x80
    switch payload.count {
    case 0...125:
      out.append(maskBit | UInt8(payload.count))
    case 126...0xFFFF:
      out.append(maskBit | 126)
      out.append(UInt8(payload.count >> 8))
      out.append(UInt8(truncatingIfNeeded: payload.count))
    default:
      out.append(maskBit | 127)
      for shift in stride(from: 56, through: 0, by: -8) { out.append(UInt8(truncatingIfNeeded: UInt64(payload.count) >> UInt64(shift))) }
    }
    if let mask {
      out.append(contentsOf: mask)
      out.append(contentsOf: payload.enumerated().map { $0.element ^ mask[$0.offset % 4] })
    } else {
      out.append(payload)
    }
    return out
  }

  /// A close frame with `code` and a short reason.
  public static func close(_ code: WebSocketCloseCode, _ reason: String = "") -> Data {
    var payload = Data([UInt8(code.rawValue >> 8), UInt8(truncatingIfNeeded: code.rawValue)])
    payload.append(Data(reason.utf8.prefix(123)))
    return encode(.close, payload)
  }
}

/// What a client sent, message by message.
public enum WebSocketEvent: Equatable, Sendable {
  case text(Data)
  case binary(Data)
  case ping(Data)
  case pong
  /// The peer's close, with its code when it gave one.
  case close(UInt16?)
}

public struct WebSocketProtocolError: Error, Equatable, Sendable {
  public let code: WebSocketCloseCode
  public let message: String

  public init(_ code: WebSocketCloseCode, _ message: String) {
    self.code = code
    self.message = message
  }
}

/// Reads the frames a client sends (they must be masked) and assembles
/// fragmented messages, up to `maxMessageBytes` each. Control frames may
/// come between fragments, as the RFC allows.
public struct WebSocketReader: Sendable {
  public let maxMessageBytes: Int
  private var buffer = Data()
  private var fragments: (opcode: WebSocketOpcode, data: Data)?
  private var closed = false

  public init(maxMessageBytes: Int) {
    self.maxMessageBytes = maxMessageBytes
  }

  /// Bytes buffered and not yet part of a whole frame.
  public var bufferedCount: Int { buffer.count + (fragments?.data.count ?? 0) }

  public mutating func append(_ bytes: Data) throws(WebSocketProtocolError) -> [WebSocketEvent] {
    guard !closed else { return [] }
    buffer.append(bytes)
    var events: [WebSocketEvent] = []
    while let event = try nextFrame() {
      if let event { events.append(event) }
      if case .close = events.last { closed = true; buffer.removeAll(); break }
    }
    return events
  }

  /// nil when no whole frame is buffered; .some(nil) for a frame that is
  /// only part of a message.
  private mutating func nextFrame() throws(WebSocketProtocolError) -> WebSocketEvent?? {
    let bytes = buffer
    guard bytes.count >= 2 else { return nil }
    let b0 = bytes[bytes.startIndex], b1 = bytes[bytes.startIndex + 1]
    let fin = b0 & 0x80 != 0
    guard b0 & 0x70 == 0 else { throw WebSocketProtocolError(.protocolError, "reserved bits set") }
    guard let opcode = WebSocketOpcode(rawValue: b0 & 0x0F) else { throw WebSocketProtocolError(.protocolError, "an unknown opcode") }
    guard b1 & 0x80 != 0 else { throw WebSocketProtocolError(.protocolError, "a client frame must be masked") }
    var length = UInt64(b1 & 0x7F)
    var offset = 2
    if length == 126 {
      guard bytes.count >= 4 else { return nil }
      length = UInt64(bytes[bytes.startIndex + 2]) << 8 | UInt64(bytes[bytes.startIndex + 3])
      guard length >= 126 else { throw WebSocketProtocolError(.protocolError, "a non-minimal length") }
      offset = 4
    } else if length == 127 {
      guard bytes.count >= 10 else { return nil }
      length = (0..<8).reduce(UInt64(0)) { $0 << 8 | UInt64(bytes[bytes.startIndex + 2 + $1]) }
      guard length > 0xFFFF, length >> 63 == 0 else { throw WebSocketProtocolError(.protocolError, "a malformed length") }
      offset = 10
    }
    if opcode.isControl {
      guard fin, length <= 125 else { throw WebSocketProtocolError(.protocolError, "a malformed control frame") }
    }
    let pending = UInt64(fragments?.data.count ?? 0)
    guard length + (opcode.isControl ? 0 : pending) <= UInt64(maxMessageBytes) else {
      throw WebSocketProtocolError(.tooBig, "a message must be at most \(maxMessageBytes) bytes")
    }
    let total = offset + 4 + Int(length)
    guard bytes.count >= total else { return nil }
    let mask = Array(bytes[(bytes.startIndex + offset)..<(bytes.startIndex + offset + 4)])
    let start = bytes.startIndex + offset + 4
    var payload = [UInt8](bytes[start..<(start + Int(length))])
    for i in payload.indices { payload[i] ^= mask[i & 3] }
    buffer.removeFirst(total)

    let data = Data(payload)
    switch opcode {
    case .ping: return .some(.ping(data))
    case .pong: return .some(.pong)
    case .close:
      guard payload.count != 1 else { throw WebSocketProtocolError(.protocolError, "a malformed close frame") }
      let code = payload.count >= 2 ? UInt16(payload[payload.startIndex]) << 8 | UInt16(payload[payload.startIndex + 1]) : nil
      return .some(.close(code))
    case .continuation:
      guard var current = fragments else { throw WebSocketProtocolError(.protocolError, "a continuation without a message") }
      current.data.append(data)
      if fin {
        fragments = nil
        return .some(try Self.message(current.opcode, current.data))
      }
      fragments = current
      return .some(nil)
    case .text, .binary:
      guard fragments == nil else { throw WebSocketProtocolError(.protocolError, "a new message inside a fragmented one") }
      if fin { return .some(try Self.message(opcode, data)) }
      fragments = (opcode, data)
      return .some(nil)
    }
  }

  private static func message(_ opcode: WebSocketOpcode, _ data: Data) throws(WebSocketProtocolError) -> WebSocketEvent {
    guard opcode == .text else { return .binary(data) }
    guard String(data: data, encoding: .utf8) != nil else { throw WebSocketProtocolError(.invalidPayload, "a text message that is not UTF-8") }
    return .text(data)
  }
}

// MARK: - SHA-1

/// SHA-1, only for Sec-WebSocket-Accept, where the RFC fixes it: it is not
/// a security boundary there. CryptoKit's Insecure.SHA1 when present; the
/// portable version is always compiled and tested against the same vectors,
/// like SHA256Hash.
public enum SHA1 {
  public static func hash(_ message: [UInt8]) -> Data {
    #if canImport(CryptoKit)
    Data(Insecure.SHA1.hash(data: Data(message)))
    #else
    portable(message)
    #endif
  }

  static func portable(_ message: [UInt8]) -> Data {
    var h: [UInt32] = [0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476, 0xC3D2E1F0]
    var padded = message
    padded.append(0x80)
    while padded.count % 64 != 56 { padded.append(0) }
    let bitLength = UInt64(message.count) &* 8
    for shift in stride(from: 56, through: 0, by: -8) { padded.append(UInt8(truncatingIfNeeded: bitLength >> UInt64(shift))) }
    var w = [UInt32](repeating: 0, count: 80)
    for chunk in stride(from: 0, to: padded.count, by: 64) {
      for i in 0..<16 {
        let j = chunk + i * 4
        w[i] = UInt32(padded[j]) << 24 | UInt32(padded[j + 1]) << 16 | UInt32(padded[j + 2]) << 8 | UInt32(padded[j + 3])
      }
      for i in 16..<80 { w[i] = rotl(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1) }
      var (a, b, c, d, e) = (h[0], h[1], h[2], h[3], h[4])
      for i in 0..<80 {
        let (f, k): (UInt32, UInt32) = switch i {
        case 0..<20: ((b & c) | (~b & d), 0x5A827999)
        case 20..<40: (b ^ c ^ d, 0x6ED9EBA1)
        case 40..<60: ((b & c) | (b & d) | (c & d), 0x8F1BBCDC)
        default: (b ^ c ^ d, 0xCA62C1D6)
        }
        let temp = rotl(a, 5) &+ f &+ e &+ k &+ w[i]
        (e, d, c, b, a) = (d, c, rotl(b, 30), a, temp)
      }
      h[0] &+= a; h[1] &+= b; h[2] &+= c; h[3] &+= d; h[4] &+= e
    }
    return Data(h.flatMap { v in [UInt8(v >> 24), UInt8(truncatingIfNeeded: v >> 16), UInt8(truncatingIfNeeded: v >> 8), UInt8(truncatingIfNeeded: v)] })
  }

  private static func rotl(_ x: UInt32, _ n: UInt32) -> UInt32 { x << n | x >> (32 - n) }
}
