import Foundation

// The small, strict HTTP/1.1 the remote gateway speaks
// (docs/remote-access.md#proxy): request and response heads, their framing,
// and chunked bodies. The gateway sits between a device and the Node server,
// so anything the two could read differently (two Content-Lengths, a
// Transfer-Encoding next to a Content-Length, a bare LF, a folded header) is
// refused rather than guessed at: that disagreement is what request
// smuggling lives on. Bodies are decoded here and framed again on the other
// side, so the Node server only ever sees framing the gateway wrote.

/// One header field as it arrived. Values are kept as ISO-8859-1 text, which
/// maps every byte to one character and back, so a header survives the
/// gateway byte for byte.
public struct HTTPField: Equatable, Sendable {
  public let name: String
  public let value: String

  public init(_ name: String, _ value: String) {
    self.name = name
    self.value = value
  }
}

/// Header fields in order, with case-insensitive names.
public struct HTTPHeaders: Equatable, Sendable, ExpressibleByDictionaryLiteral {
  public private(set) var fields: [HTTPField]

  public init(_ fields: [HTTPField] = []) { self.fields = fields }

  public init(dictionaryLiteral elements: (String, String)...) {
    fields = elements.map { HTTPField($0.0, $0.1) }
  }

  /// The first value of `name`.
  public subscript(_ name: String) -> String? {
    fields.first { $0.name.caseInsensitiveEquals(name) }?.value
  }

  public func values(_ name: String) -> [String] {
    fields.filter { $0.name.caseInsensitiveEquals(name) }.map(\.value)
  }

  public func count(of name: String) -> Int { values(name).count }

  public func contains(_ name: String) -> Bool { self[name] != nil }

  /// The comma-separated list elements of every `name` field, trimmed and
  /// lowercased (Connection, Upgrade, Transfer-Encoding).
  public func tokens(_ name: String) -> [String] {
    values(name).flatMap { $0.split(separator: ",") }
      .map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
      .filter { !$0.isEmpty }
  }

  public mutating func add(_ name: String, _ value: String) { fields.append(HTTPField(name, value)) }

  /// Replaces every `name` field with one.
  public mutating func set(_ name: String, _ value: String) {
    remove(name)
    add(name, value)
  }

  public mutating func remove(_ name: String) { fields.removeAll { $0.name.caseInsensitiveEquals(name) } }

  public mutating func removeAll(where shouldRemove: (HTTPField) -> Bool) { fields.removeAll(where: shouldRemove) }

  func serialize(into out: inout Data) {
    for field in fields {
      out.append(latin1: field.name)
      out.append(latin1: ": ")
      out.append(latin1: field.value)
      out.append(latin1: "\r\n")
    }
    out.append(latin1: "\r\n")
  }
}

public enum HTTPVersion: String, Equatable, Sendable {
  case http10 = "HTTP/1.0"
  case http11 = "HTTP/1.1"
}

public struct HTTPRequestHead: Equatable, Sendable {
  public var method: String
  /// The request target as sent: origin-form ("/path?query") for everything
  /// the gateway serves.
  public var target: String
  public var version: HTTPVersion
  public var headers: HTTPHeaders

  public init(method: String, target: String, version: HTTPVersion = .http11, headers: HTTPHeaders = HTTPHeaders()) {
    self.method = method
    self.target = target
    self.version = version
    self.headers = headers
  }

  /// The target's path, without the query.
  public var path: String {
    String(target[..<(target.firstIndex(of: "?") ?? target.endIndex)])
  }

  /// Whether the connection may carry another request after this one's
  /// response: HTTP/1.1 unless it says close, HTTP/1.0 only never (the
  /// gateway does not do 1.0 keep-alive).
  public var keepsAlive: Bool {
    version == .http11 && !headers.tokens("Connection").contains("close")
  }

  public var serialized: Data {
    var out = Data()
    out.append(latin1: "\(method) \(target) \(version.rawValue)\r\n")
    headers.serialize(into: &out)
    return out
  }
}

public struct HTTPResponseHead: Equatable, Sendable {
  public var version: HTTPVersion
  public var status: Int
  public var reason: String
  public var headers: HTTPHeaders

  public init(status: Int, reason: String? = nil, version: HTTPVersion = .http11, headers: HTTPHeaders = HTTPHeaders()) {
    self.version = version
    self.status = status
    self.reason = reason ?? HTTPResponseHead.reason(for: status)
    self.headers = headers
  }

  public var isInformational: Bool { (100...199).contains(status) }

  public var serialized: Data {
    var out = Data()
    out.append(latin1: "\(version.rawValue) \(status) \(reason)\r\n")
    headers.serialize(into: &out)
    return out
  }

  static func reason(for status: Int) -> String {
    switch status {
    case 100: "Continue"
    case 101: "Switching Protocols"
    case 200: "OK"
    case 204: "No Content"
    case 400: "Bad Request"
    case 401: "Unauthorized"
    case 403: "Forbidden"
    case 404: "Not Found"
    case 408: "Request Timeout"
    case 409: "Conflict"
    case 413: "Content Too Large"
    case 417: "Expectation Failed"
    case 423: "Locked"
    case 429: "Too Many Requests"
    case 431: "Request Header Fields Too Large"
    case 500: "Internal Server Error"
    case 502: "Bad Gateway"
    default: "Status"
    }
  }
}

// MARK: - Parsing heads

public enum HTTPHeadParser {
  /// A request head at the start of `buffer`, and how many bytes it took;
  /// nil while it is incomplete. Empty lines before the request line are
  /// skipped (RFC 9112 §2.2). Throws `too-large` once more than `limit`
  /// bytes arrived without a complete head, and `bad-request` for anything
  /// malformed.
  public static func request(
    in buffer: Data, limit: Int = GatewayLimits.maxRequestHeadBytes, maxHeaders: Int = GatewayLimits.maxHeaderCount
  ) throws(GatewayError) -> (head: HTTPRequestHead, length: Int)? {
    guard let (lines, length) = try headLines(in: buffer, limit: limit, skipLeadingEmpty: true) else { return nil }
    let parts = lines[0].split(separator: UInt8(ascii: " "), omittingEmptySubsequences: false)
    guard parts.count == 3 else { throw bad("a malformed request line") }
    let method = parts[0], target = parts[1], version = parts[2]
    guard (1...32).contains(method.count), method.allSatisfy(isTokenByte) else { throw bad("a malformed method") }
    guard (1...8192).contains(target.count), target.allSatisfy({ (0x21...0x7e).contains($0) }) else {
      throw bad("a malformed request target")
    }
    guard let httpVersion = HTTPVersion(rawValue: String(decoding: version, as: UTF8.self)) else {
      throw bad("an unsupported HTTP version")
    }
    let headers = try fields(lines.dropFirst(), maxHeaders: maxHeaders)
    return (HTTPRequestHead(method: String(decoding: method, as: UTF8.self), target: String(decoding: target, as: UTF8.self),
                            version: httpVersion, headers: headers), length)
  }

  /// A response head from the Node server, the same way.
  public static func response(
    in buffer: Data, limit: Int = 64 * 1024, maxHeaders: Int = 200
  ) throws(GatewayError) -> (head: HTTPResponseHead, length: Int)? {
    guard let (lines, length) = try headLines(in: buffer, limit: limit, skipLeadingEmpty: false) else { return nil }
    let line = lines[0]
    guard line.count >= 12, let version = HTTPVersion(rawValue: String(decoding: line.prefix(8), as: UTF8.self)),
          line[line.startIndex + 8] == UInt8(ascii: " ")
    else { throw bad("a malformed status line") }
    let digits = line.dropFirst(9).prefix(3)
    guard digits.count == 3, digits.allSatisfy({ (UInt8(ascii: "0")...UInt8(ascii: "9")).contains($0) }),
          let status = Int(String(decoding: digits, as: UTF8.self)), (100...599).contains(status)
    else { throw bad("a malformed status code") }
    let rest = line.dropFirst(12)
    guard rest.isEmpty || rest.first == UInt8(ascii: " ") else { throw bad("a malformed status line") }
    let reasonBytes = rest.dropFirst()
    guard reasonBytes.allSatisfy(isFieldValueByte) else { throw bad("a malformed reason phrase") }
    let headers = try fields(lines.dropFirst(), maxHeaders: maxHeaders)
    return (HTTPResponseHead(status: status, reason: String(decoding: reasonBytes, as: UTF8.self), version: version,
                             headers: headers), length)
  }

  /// The head's lines without their CRLFs, once "\r\n\r\n" arrived. A bare
  /// LF or CR anywhere in the head is refused.
  private static func headLines(in buffer: Data, limit: Int, skipLeadingEmpty: Bool) throws(GatewayError) -> ([Data], Int)? {
    var start = buffer.startIndex
    if skipLeadingEmpty {
      while buffer.index(start, offsetBy: 2, limitedBy: buffer.endIndex) != nil, buffer[start] == 13, buffer[start + 1] == 10 {
        start += 2
      }
    }
    var lines: [Data] = []
    var lineStart = start
    var index = start
    while index < buffer.endIndex {
      if index - buffer.startIndex >= limit { throw GatewayError(.tooLarge, "the request head is too large") }
      let byte = buffer[index]
      if byte == 10 { throw bad("a bare LF") }
      if byte == 13 {
        guard index + 1 < buffer.endIndex else { break }
        guard buffer[index + 1] == 10 else { throw bad("a bare CR") }
        if index == lineStart {
          guard !lines.isEmpty else { throw bad("an empty head") }
          return (lines, index + 2 - buffer.startIndex)
        }
        lines.append(buffer[lineStart..<index])
        index += 2
        lineStart = index
        continue
      }
      index += 1
    }
    if buffer.count > limit { throw GatewayError(.tooLarge, "the request head is too large") }
    return nil
  }

  private static func fields(_ lines: ArraySlice<Data>, maxHeaders: Int) throws(GatewayError) -> HTTPHeaders {
    guard lines.count <= maxHeaders else { throw GatewayError(.tooLarge, "too many header fields") }
    var headers = HTTPHeaders()
    for line in lines {
      // A line starting with whitespace is obsolete line folding (RFC 9112 §5.2).
      guard let colon = line.firstIndex(of: UInt8(ascii: ":")), colon > line.startIndex else { throw bad("a malformed header field") }
      let name = line[line.startIndex..<colon]
      guard name.allSatisfy(isTokenByte) else { throw bad("a malformed header name") }
      var value = line[(colon + 1)...]
      while let first = value.first, first == 32 || first == 9 { value = value.dropFirst() }
      while let last = value.last, last == 32 || last == 9 { value = value.dropLast() }
      guard value.allSatisfy(isFieldValueByte) else { throw bad("a malformed header value") }
      headers.add(String(decoding: name, as: UTF8.self), String(data: Data(value), encoding: .isoLatin1) ?? "")
    }
    return headers
  }

  static func isTokenByte(_ byte: UInt8) -> Bool {
    switch byte {
    case UInt8(ascii: "a")...UInt8(ascii: "z"), UInt8(ascii: "A")...UInt8(ascii: "Z"), UInt8(ascii: "0")...UInt8(ascii: "9"): true
    default: "!#$%&'*+-.^_`|~".utf8.contains(byte)
    }
  }

  /// VCHAR, SP, HTAB and obs-text; never CR, LF, NUL or another control.
  static func isFieldValueByte(_ byte: UInt8) -> Bool {
    byte == 9 || (0x20...0x7e).contains(byte) || byte >= 0x80
  }

  private static func bad(_ what: String) -> GatewayError { GatewayError(.badRequest, "HTTP: \(what)") }
}

// MARK: - Framing

/// How a message's body is delimited.
public enum HTTPBodyFraming: Equatable, Sendable {
  case none
  case length(Int64)
  case chunked
  /// A response that ends when the server closes (no length, not chunked).
  case untilClose
}

extension HTTPRequestHead {
  /// The body framing, refusing every ambiguous combination: both
  /// Transfer-Encoding and Content-Length, a coding other than exactly
  /// "chunked", more than one Content-Length, or one that is not plain digits.
  public func bodyFraming() throws(GatewayError) -> HTTPBodyFraming {
    let encodings = headers.tokens("Transfer-Encoding")
    let lengths = headers.values("Content-Length")
    if headers.contains("Transfer-Encoding") {
      guard lengths.isEmpty else { throw GatewayError(.badRequest, "HTTP: both Transfer-Encoding and Content-Length") }
      guard version == .http11, encodings == ["chunked"] else { throw GatewayError(.badRequest, "HTTP: an unsupported Transfer-Encoding") }
      return .chunked
    }
    guard !lengths.isEmpty else { return .none }
    guard lengths.count == 1, let length = HTTPBodyFraming.contentLength(lengths[0]) else {
      throw GatewayError(.badRequest, "HTTP: a malformed Content-Length")
    }
    return length == 0 ? .none : .length(length)
  }
}

extension HTTPResponseHead {
  /// The body framing of a response to a `requestMethod` request
  /// (RFC 9112 §6.3). Throws for the same ambiguities as a request.
  public func bodyFraming(requestMethod: String) throws(GatewayError) -> HTTPBodyFraming {
    if requestMethod == "HEAD" || isInformational || status == 204 || status == 304 { return .none }
    let lengths = headers.values("Content-Length")
    if headers.contains("Transfer-Encoding") {
      guard lengths.isEmpty else { throw GatewayError(.serverUnavailable, "HTTP: both Transfer-Encoding and Content-Length") }
      guard headers.tokens("Transfer-Encoding") == ["chunked"] else {
        throw GatewayError(.serverUnavailable, "HTTP: an unsupported Transfer-Encoding")
      }
      return .chunked
    }
    guard !lengths.isEmpty else { return .untilClose }
    guard lengths.count == 1, let length = HTTPBodyFraming.contentLength(lengths[0]) else {
      throw GatewayError(.serverUnavailable, "HTTP: a malformed Content-Length")
    }
    return length == 0 ? .none : .length(length)
  }
}

extension HTTPBodyFraming {
  /// Plain decimal, at most 18 digits (no sign, no list, no spaces inside).
  static func contentLength(_ text: String) -> Int64? {
    guard (1...18).contains(text.utf8.count), text.utf8.allSatisfy({ (UInt8(ascii: "0")...UInt8(ascii: "9")).contains($0) }) else {
      return nil
    }
    return Int64(text)
  }
}

// MARK: - Bodies

/// Reads one body in its framing, incrementally, and hands back its payload.
/// Chunk extensions and trailers are read and dropped: the other side gets
/// the payload framed again by the gateway.
public struct HTTPBodyDecoder: Sendable {
  public let framing: HTTPBodyFraming
  public let limit: Int64
  /// Payload bytes so far.
  public private(set) var received: Int64 = 0
  public private(set) var isComplete: Bool

  private enum Chunked: Sendable {
    case size
    case data(Int64)
    case dataEnd
    case trailers(Int)
  }

  private var chunked = Chunked.size
  private var line = Data()

  static let maxChunkLineBytes = 4096
  static let maxTrailerBytes = 8 * 1024

  public init(framing: HTTPBodyFraming, limit: Int64) {
    self.framing = framing
    self.limit = limit
    isComplete = framing == .none
  }

  /// The payload in the front of `input`, removing what it consumed. Bytes
  /// after the end of the body stay in `input` (the next request).
  public mutating func decode(_ input: inout Data) throws(GatewayError) -> [Data] {
    guard !isComplete, !input.isEmpty else { return [] }
    switch framing {
    case .none:
      return []
    case .length(let total):
      guard total <= limit else { throw GatewayError(.tooLarge, "the body is too large") }
      let take = Int(min(Int64(input.count), total - received))
      let piece = Data(input.prefix(take))
      input.removeFirst(take)
      received += Int64(take)
      if received == total { isComplete = true }
      return piece.isEmpty ? [] : [piece]
    case .untilClose:
      received += Int64(input.count)
      guard received <= limit else { throw GatewayError(.tooLarge, "the body is too large") }
      defer { input.removeAll() }
      return [input]
    case .chunked:
      return try decodeChunked(&input)
    }
  }

  /// The peer closed: fine for a close-delimited body, an error for a body
  /// that was not complete yet.
  public mutating func finishAtClose() -> Bool {
    if framing == .untilClose { isComplete = true }
    return isComplete
  }

  private mutating func decodeChunked(_ input: inout Data) throws(GatewayError) -> [Data] {
    var pieces: [Data] = []
    var index = input.startIndex
    defer { input.removeFirst(index - input.startIndex) }
    while index < input.endIndex, !isComplete {
      switch chunked {
      case .size:
        guard let text = try readLine(input, &index) else { return pieces }
        let sizeText = text.split(separator: ";", maxSplits: 1, omittingEmptySubsequences: false)[0]
          .trimmingCharacters(in: CharacterSet(charactersIn: " \t"))
        guard (1...15).contains(sizeText.utf8.count), sizeText.utf8.allSatisfy(Hex.isDigit),
              let size = Int64(sizeText, radix: 16)
        else { throw GatewayError(.badRequest, "HTTP: a malformed chunk size") }
        if size == 0 {
          chunked = .trailers(0)
        } else {
          guard received + size <= limit else { throw GatewayError(.tooLarge, "the body is too large") }
          chunked = .data(size)
        }
      case .data(let remaining):
        let take = Int(min(Int64(input.endIndex - index), remaining))
        pieces.append(Data(input[index..<(index + take)]))
        index += take
        received += Int64(take)
        chunked = remaining - Int64(take) == 0 ? .dataEnd : .data(remaining - Int64(take))
      case .dataEnd:
        guard let text = try readLine(input, &index) else { return pieces }
        guard text.isEmpty else { throw GatewayError(.badRequest, "HTTP: a chunk longer than its size") }
        chunked = .size
      case .trailers(let bytes):
        let before = index
        guard let text = try readLine(input, &index) else { return pieces }
        if text.isEmpty {
          isComplete = true
        } else {
          let total = bytes + (index - before)
          guard total <= Self.maxTrailerBytes else { throw GatewayError(.tooLarge, "HTTP: trailers too large") }
          chunked = .trailers(total)
        }
      }
    }
    return pieces
  }

  /// One CRLF-terminated line (without it), across calls; nil until complete.
  private mutating func readLine(_ input: Data, _ index: inout Data.Index) throws(GatewayError) -> String? {
    while index < input.endIndex {
      let byte = input[index]
      index += 1
      if byte == 10 {
        guard line.last == 13 else { throw GatewayError(.badRequest, "HTTP: a bare LF in chunked framing") }
        line.removeLast()
        defer { line.removeAll(keepingCapacity: true) }
        guard !line.contains(13), line.allSatisfy(HTTPHeadParser.isFieldValueByte) else {
          throw GatewayError(.badRequest, "HTTP: a malformed chunk line")
        }
        return String(data: line, encoding: .isoLatin1) ?? ""
      }
      line.append(byte)
      guard line.count <= Self.maxChunkLineBytes else { throw GatewayError(.tooLarge, "HTTP: a chunk line too long") }
    }
    return nil
  }
}

/// Writes a body in the framing the gateway chose for the other side.
public enum HTTPBodyEncoder {
  /// `piece` as the gateway sends it in `framing`: as is for a length or a
  /// close-delimited body, as one chunk for chunked.
  public static func encode(_ piece: Data, framing: HTTPBodyFraming) -> Data {
    guard framing == .chunked else { return piece }
    guard !piece.isEmpty else { return Data() }
    var out = Data()
    out.append(latin1: String(piece.count, radix: 16) + "\r\n")
    out.append(piece)
    out.append(latin1: "\r\n")
    return out
  }

  /// What ends a body: the last chunk for chunked, nothing otherwise.
  public static func end(framing: HTTPBodyFraming) -> Data {
    framing == .chunked ? Data("0\r\n\r\n".utf8) : Data()
  }
}

extension Data {
  mutating func append(latin1 text: String) {
    append(text.data(using: .isoLatin1) ?? Data(text.utf8))
  }
}

extension String {
  func caseInsensitiveEquals(_ other: String) -> Bool {
    utf8.count == other.utf8.count && lowercased() == other.lowercased()
  }
}
