import Foundation
import Testing
@testable import HivemindKit

// The gateway's HTTP/1.1: strict heads, unambiguous framing, chunked bodies.

private func data(_ text: String) -> Data { Data(text.utf8) }

struct HTTPHeadParserTests {
  @Test func parsesARequestHead() throws {
    let text = "GET /api/ui/snapshot?x=1 HTTP/1.1\r\nHost: 192.168.1.20:7443\r\nCookie:  a=b \r\nX-Empty:\r\n\r\nrest"
    let (head, length) = try #require(try HTTPHeadParser.request(in: data(text)))
    #expect(head.method == "GET")
    #expect(head.target == "/api/ui/snapshot?x=1")
    #expect(head.path == "/api/ui/snapshot")
    #expect(head.version == .http11)
    #expect(head.headers["host"] == "192.168.1.20:7443")
    #expect(head.headers["COOKIE"] == "a=b")
    #expect(head.headers["X-Empty"] == "")
    #expect(length == text.utf8.count - 4)
    #expect(head.keepsAlive)
  }

  @Test func waitsForTheWholeHead() throws {
    #expect(try HTTPHeadParser.request(in: data("GET / HTTP/1.1\r\nHost: a:1\r\n")) == nil)
    #expect(try HTTPHeadParser.request(in: data("GET / HTTP/1.1\r\nHost: a:1\r\n\r")) == nil)
    #expect(try HTTPHeadParser.request(in: Data()) == nil)
  }

  @Test func skipsEmptyLinesBeforeTheRequestLine() throws {
    let (head, length) = try #require(try HTTPHeadParser.request(in: data("\r\n\r\nGET / HTTP/1.1\r\n\r\n")))
    #expect(head.target == "/")
    #expect(length == 22)
  }

  @Test func worksOnASlice() throws {
    let whole = data("xxGET / HTTP/1.1\r\nA: b\r\n\r\n")
    let (head, length) = try #require(try HTTPHeadParser.request(in: whole.dropFirst(2)))
    #expect(head.headers["A"] == "b")
    #expect(length == whole.count - 2)
  }

  @Test(arguments: [
    "GET / HTTP/1.1\nHost: a\n\n",                 // bare LF
    "GET / HTTP/1.1\r\nHost: a\rX\r\n\r\n",       // bare CR
    "GET  / HTTP/1.1\r\n\r\n",                     // two spaces
    "GET / HTTP/2.0\r\n\r\n",                      // version
    "GET / http/1.1\r\n\r\n",
    "G(T / HTTP/1.1\r\n\r\n",                      // method not a token
    "GET /a b HTTP/1.1\r\n\r\n",                   // space in target
    "GET / HTTP/1.1\r\n Folded: x\r\n\r\n",        // obs-fold
    "GET / HTTP/1.1\r\nHost : a\r\n\r\n",          // space before colon
    "GET / HTTP/1.1\r\nNoColon\r\n\r\n",
    "GET / HTTP/1.1\r\n: empty\r\n\r\n",
    "GET / HTTP/1.1\r\nX: a\u{01}b\r\n\r\n",       // control character
  ])
  func refusesMalformedHeads(_ text: String) {
    #expect(throws: GatewayError.self) { try HTTPHeadParser.request(in: data(text)) }
  }

  @Test func boundsTheHead() {
    let long = "GET / HTTP/1.1\r\nX: " + String(repeating: "a", count: 40_000)
    #expect(throws: GatewayError(.tooLarge, "the request head is too large")) { try HTTPHeadParser.request(in: data(long)) }
    let many = "GET / HTTP/1.1\r\n" + (0..<101).map { "X\($0): y\r\n" }.joined() + "\r\n"
    #expect(throws: GatewayError(.tooLarge, "too many header fields")) { try HTTPHeadParser.request(in: data(many)) }
  }

  @Test func keepsHeaderBytesAsTheyWere() throws {
    var raw = data("GET / HTTP/1.1\r\nX-Name: caf")
    raw.append(0xE9)
    raw.append(data("\r\n\r\n"))
    let (head, _) = try #require(try HTTPHeadParser.request(in: raw))
    #expect(head.serialized == raw)
  }

  @Test func parsesAResponseHead() throws {
    let (head, _) = try #require(try HTTPHeadParser.response(in: data("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")))
    #expect(head.status == 404)
    #expect(head.reason == "Not Found")
    let (bare, _) = try #require(try HTTPHeadParser.response(in: data("HTTP/1.1 204\r\n\r\n")))
    #expect(bare.status == 204)
    #expect(bare.reason == "")
    #expect(throws: GatewayError.self) { try HTTPHeadParser.response(in: data("HTTP/1.1 20 OK\r\n\r\n")) }
    #expect(throws: GatewayError.self) { try HTTPHeadParser.response(in: data("HTTP/1.1 200OK\r\n\r\n")) }
    #expect(throws: GatewayError.self) { try HTTPHeadParser.response(in: data("HTTP/1.1 999 X\r\n\r\n")) }
  }

  @Test func connectionTokens() {
    #expect(!HTTPRequestHead(method: "GET", target: "/", headers: ["Connection": "keep-alive, Close"]).keepsAlive)
    #expect(!HTTPRequestHead(method: "GET", target: "/", version: .http10).keepsAlive)
    let headers: HTTPHeaders = ["Connection": "Upgrade", "connection": " keep-alive ,"]
    #expect(headers.tokens("Connection") == ["upgrade", "keep-alive"])
  }
}

struct HTTPFramingTests {
  func request(_ fields: HTTPHeaders, version: HTTPVersion = .http11) -> HTTPRequestHead {
    HTTPRequestHead(method: "POST", target: "/", version: version, headers: fields)
  }

  @Test func requestFraming() throws {
    #expect(try request([:]).bodyFraming() == .none)
    #expect(try request(["Content-Length": "0"]).bodyFraming() == .none)
    #expect(try request(["Content-Length": "12"]).bodyFraming() == .length(12))
    #expect(try request(["Transfer-Encoding": "Chunked"]).bodyFraming() == .chunked)
  }

  @Test(arguments: [
    ["Content-Length": "5", "Transfer-Encoding": "chunked"],
    ["Transfer-Encoding": "gzip, chunked"],
    ["Transfer-Encoding": "chunked", "transfer-encoding": "chunked"],
    ["Content-Length": "5", "content-length": "5"],
    ["Content-Length": "5, 5"],
    ["Content-Length": "+5"],
    ["Content-Length": "0x10"],
    ["Content-Length": ""],
    ["Content-Length": "9999999999999999999"],
  ] as [HTTPHeaders])
  func refusesAmbiguousRequestFraming(_ fields: HTTPHeaders) {
    #expect(throws: GatewayError.self) { try request(fields).bodyFraming() }
  }

  @Test func chunkedNeedsHTTP11() {
    #expect(throws: GatewayError.self) { try request(["Transfer-Encoding": "chunked"], version: .http10).bodyFraming() }
  }

  @Test func responseFraming() throws {
    func response(_ status: Int, _ fields: HTTPHeaders) -> HTTPResponseHead { HTTPResponseHead(status: status, headers: fields) }
    #expect(try response(200, ["Content-Length": "3"]).bodyFraming(requestMethod: "GET") == .length(3))
    #expect(try response(200, ["Content-Length": "3"]).bodyFraming(requestMethod: "HEAD") == .none)
    #expect(try response(304, ["Content-Length": "3"]).bodyFraming(requestMethod: "GET") == .none)
    #expect(try response(204, [:]).bodyFraming(requestMethod: "GET") == .none)
    #expect(try response(200, ["Transfer-Encoding": "chunked"]).bodyFraming(requestMethod: "GET") == .chunked)
    #expect(try response(200, [:]).bodyFraming(requestMethod: "GET") == .untilClose)
    #expect(throws: GatewayError.self) {
      try response(200, ["Transfer-Encoding": "chunked", "Content-Length": "3"]).bodyFraming(requestMethod: "GET")
    }
    #expect(throws: GatewayError.self) { try response(200, ["Transfer-Encoding": "gzip"]).bodyFraming(requestMethod: "GET") }
  }
}

struct HTTPBodyTests {
  /// Feeds `input` one byte at a time: framing must not depend on how TCP
  /// cut the bytes.
  func decodeBytewise(_ framing: HTTPBodyFraming, _ input: String, limit: Int64 = 1 << 20) throws -> (body: Data, rest: Data, complete: Bool) {
    var decoder = HTTPBodyDecoder(framing: framing, limit: limit)
    var body = Data()
    var rest = Data()
    for byte in Data(input.utf8) {
      if decoder.isComplete {
        rest.append(byte)
        continue
      }
      var one = Data([byte])
      for piece in try decoder.decode(&one) { body.append(piece) }
      rest.append(one)
    }
    return (body, rest, decoder.isComplete)
  }

  @Test func lengthBody() throws {
    let result = try decodeBytewise(.length(5), "helloGET")
    #expect(result.body == Data("hello".utf8))
    #expect(result.rest == Data("GET".utf8))
    #expect(result.complete)

    var decoder = HTTPBodyDecoder(framing: .length(5), limit: 10)
    var input = Data("helloGET".utf8)
    #expect(try decoder.decode(&input) == [Data("hello".utf8)])
    #expect(input == Data("GET".utf8))
  }

  @Test func chunkedBody() throws {
    let wire = "5;ext=1\r\nhello\r\n1\r\n \r\n6\r\nworld!\r\n0\r\nTrailer: x\r\n\r\nNEXT"
    let result = try decodeBytewise(.chunked, wire)
    #expect(String(decoding: result.body, as: UTF8.self) == "hello world!")
    #expect(result.rest == Data("NEXT".utf8))
    #expect(result.complete)

    var whole = HTTPBodyDecoder(framing: .chunked, limit: 100)
    var input = Data(wire.utf8)
    #expect(try whole.decode(&input).reduce(Data(), +) == Data("hello world!".utf8))
    #expect(input == Data("NEXT".utf8))
    #expect(whole.received == 12)
  }

  @Test(arguments: [
    "5\r\nhelloX\r\n0\r\n\r\n",   // chunk longer than its size
    "5\nhello\r\n",               // bare LF
    "g\r\n",                      // not hex
    "-1\r\n",
    "\r\n",                       // empty size
    "1234567890abcdef0\r\n",     // too many digits
  ])
  func refusesMalformedChunks(_ wire: String) {
    #expect(throws: GatewayError.self) { try decodeBytewise(.chunked, wire) }
  }

  @Test func enforcesTheLimit() {
    #expect(throws: GatewayError(.tooLarge, "the body is too large")) { try decodeBytewise(.length(11), "hello world", limit: 10) }
    #expect(throws: GatewayError(.tooLarge, "the body is too large")) { try decodeBytewise(.chunked, "b\r\nhello world\r\n", limit: 10) }
    #expect(throws: GatewayError(.tooLarge, "the body is too large")) { try decodeBytewise(.untilClose, "hello world", limit: 10) }
    // A long chunk line is refused before it is buffered whole.
    #expect(throws: GatewayError.self) { try decodeBytewise(.chunked, "1;" + String(repeating: "x", count: 5000)) }
  }

  @Test func closeDelimited() throws {
    var decoder = HTTPBodyDecoder(framing: .untilClose, limit: 100)
    var input = Data("abc".utf8)
    #expect(try decoder.decode(&input) == [Data("abc".utf8)])
    #expect(!decoder.isComplete)
    #expect(decoder.finishAtClose() == true)
    var length = HTTPBodyDecoder(framing: .length(4), limit: 100)
    #expect(length.finishAtClose() == false)
  }

  @Test func encodes() {
    #expect(HTTPBodyEncoder.encode(Data("hello world!".utf8), framing: .chunked) == Data("c\r\nhello world!\r\n".utf8))
    #expect(HTTPBodyEncoder.encode(Data(), framing: .chunked) == Data())
    #expect(HTTPBodyEncoder.encode(Data("x".utf8), framing: .length(1)) == Data("x".utf8))
    #expect(HTTPBodyEncoder.end(framing: .chunked) == Data("0\r\n\r\n".utf8))
    #expect(HTTPBodyEncoder.end(framing: .length(1)) == Data())
  }

  @Test func roundTripsThroughTheEncoder() throws {
    let payload = Data((0..<10_000).map { UInt8(truncatingIfNeeded: $0 &* 31) })
    var wire = Data()
    for start in stride(from: 0, to: payload.count, by: 777) {
      wire.append(HTTPBodyEncoder.encode(payload[start..<min(start + 777, payload.count)], framing: .chunked))
    }
    wire.append(HTTPBodyEncoder.end(framing: .chunked))
    var decoder = HTTPBodyDecoder(framing: .chunked, limit: 1 << 20)
    #expect(try decoder.decode(&wire).reduce(Data(), +) == payload)
    #expect(decoder.isComplete)
    #expect(wire.isEmpty)
  }
}
