import Foundation
import Testing
@testable import HivemindKit

// The server side of RFC 6455 that /_hivemind/broker needs.

/// A masked client frame, as a device sends it.
func clientFrame(_ opcode: WebSocketOpcode, _ payload: Data, fin: Bool = true, mask: [UInt8] = [0x37, 0xfa, 0x21, 0x3d]) -> Data {
  var frame = WebSocketFrame.encode(opcode, payload, mask: mask)
  if !fin { frame[0] &= 0x7F }
  return frame
}

struct WebSocketHandshakeTests {
  @Test func acceptKeyFromTheRFC() {
    #expect(WebSocketHandshake.accept(forKey: "dGhlIHNhbXBsZSBub25jZQ==") == "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")
  }

  @Test func sha1Vectors() {
    let vectors: [(String, String)] = [
      ("", "da39a3ee5e6b4b0d3255bfef95601890afd80709"),
      ("abc", "a9993e364706816aba3e25717850c26c9cd0d89d"),
      ("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq", "84983e441c3bd26ebaae4aa1f95129e5e54670f1"),
      (String(repeating: "a", count: 1000), "291e9a6c66994949b57ba5e650361e98fc36b1ba"),
    ]
    for (input, expected) in vectors {
      #expect(Hex.encode(SHA1.hash(Array(input.utf8))) == expected, "\(input.prefix(10))")
      #expect(Hex.encode(SHA1.portable(Array(input.utf8))) == expected, "\(input.prefix(10))")
    }
  }

  func upgrade(_ fields: HTTPHeaders, method: String = "GET") -> HTTPRequestHead {
    HTTPRequestHead(method: method, target: "/_hivemind/broker", headers: fields)
  }

  static let good: HTTPHeaders = [
    "Connection": "keep-alive, Upgrade", "Upgrade": "websocket",
    "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
  ]

  @Test func validHandshake() throws {
    #expect(try WebSocketHandshake.key(of: upgrade(Self.good)) == "dGhlIHNhbXBsZSBub25jZQ==")
    let response = WebSocketHandshake.response(forKey: "dGhlIHNhbXBsZSBub25jZQ==")
    #expect(response.status == 101)
    #expect(response.headers["Sec-WebSocket-Accept"] == "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")
    #expect(String(decoding: response.serialized, as: UTF8.self).hasPrefix("HTTP/1.1 101 Switching Protocols\r\n"))
  }

  @Test func refusesBadHandshakes() {
    var noUpgrade = Self.good
    noUpgrade.remove("Upgrade")
    var oldVersion = Self.good
    oldVersion.set("Sec-WebSocket-Version", "8")
    var shortKey = Self.good
    shortKey.set("Sec-WebSocket-Key", "c2hvcnQ=")
    var twoKeys = Self.good
    twoKeys.add("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")
    var noConnection = Self.good
    noConnection.set("Connection", "keep-alive")
    for head in [upgrade(noUpgrade), upgrade(oldVersion), upgrade(shortKey), upgrade(twoKeys), upgrade(noConnection), upgrade(Self.good, method: "POST")] {
      #expect(throws: GatewayError.self) { try WebSocketHandshake.key(of: head) }
    }
  }
}

struct WebSocketReaderTests {
  @Test func maskedFrameFromTheRFC() throws {
    var reader = WebSocketReader(maxMessageBytes: 100)
    let frame = Data([0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58])
    #expect(try reader.append(frame) == [.text(Data("Hello".utf8))])
  }

  @Test func framesSplitAnywhere() throws {
    var reader = WebSocketReader(maxMessageBytes: 1 << 20)
    let big = Data(repeating: 0x61, count: 70_000)
    let wire = clientFrame(.text, Data("a".utf8)) + clientFrame(.text, big) + clientFrame(.text, Data(repeating: 0x62, count: 300))
    var events: [WebSocketEvent] = []
    for start in stride(from: 0, to: wire.count, by: 999) {
      events += try reader.append(wire[start..<min(start + 999, wire.count)])
    }
    #expect(events == [.text(Data("a".utf8)), .text(big), .text(Data(repeating: 0x62, count: 300))])
  }

  @Test func assemblesFragmentsAroundControlFrames() throws {
    var reader = WebSocketReader(maxMessageBytes: 100)
    let wire = clientFrame(.text, Data("hel".utf8), fin: false)
      + clientFrame(.ping, Data("p".utf8))
      + clientFrame(.continuation, Data("lo".utf8))
    #expect(try reader.append(wire) == [.ping(Data("p".utf8)), .text(Data("hello".utf8))])
  }

  @Test func closeEndsReading() throws {
    var reader = WebSocketReader(maxMessageBytes: 100)
    let wire = clientFrame(.close, Data([0x03, 0xE8])) + clientFrame(.text, Data("x".utf8))
    #expect(try reader.append(wire) == [.close(1000)])
    #expect(try reader.append(clientFrame(.text, Data("y".utf8))) == [])
  }

  @Test func protocolErrors() {
    func check(_ wire: Data, _ code: WebSocketCloseCode, limit: Int = 100) {
      var reader = WebSocketReader(maxMessageBytes: limit)
      #expect(throws: WebSocketProtocolError.self) { try reader.append(wire) }
      do { _ = try reader.append(wire) } catch { #expect(error.code == code) }
    }
    check(WebSocketFrame.encode(.text, Data("x".utf8)), .protocolError)             // unmasked
    var reserved = clientFrame(.text, Data("x".utf8)); reserved[0] |= 0x40
    check(reserved, .protocolError)
    var unknown = clientFrame(.text, Data("x".utf8)); unknown[0] = 0x83
    check(unknown, .protocolError)
    check(clientFrame(.continuation, Data("x".utf8)), .protocolError)               // nothing to continue
    check(clientFrame(.text, Data("a".utf8), fin: false) + clientFrame(.text, Data("b".utf8)), .protocolError)
    check(clientFrame(.ping, Data("p".utf8), fin: false), .protocolError)
    check(clientFrame(.text, Data(repeating: 0x61, count: 101)), .tooBig)
    check(clientFrame(.text, Data(repeating: 0x61, count: 60), fin: false) + clientFrame(.continuation, Data(repeating: 0x61, count: 60)), .tooBig)
    check(clientFrame(.text, Data([0xC3, 0x28])), .invalidPayload)
    check(clientFrame(.close, Data([0x03])), .protocolError)
  }

  @Test func binaryIsReported() throws {
    var reader = WebSocketReader(maxMessageBytes: 100)
    #expect(try reader.append(clientFrame(.binary, Data([1, 2]))) == [.binary(Data([1, 2]))])
  }

  @Test func serverFrames() {
    #expect(WebSocketFrame.encode(.text, Data("Hello".utf8)) == Data([0x81, 0x05]) + Data("Hello".utf8))
    let medium = WebSocketFrame.encode(.text, Data(repeating: 0, count: 256))
    #expect(Array(medium.prefix(4)) == [0x81, 126, 0x01, 0x00])
    let large = WebSocketFrame.encode(.binary, Data(repeating: 0, count: 65_536))
    #expect(Array(large.prefix(10)) == [0x82, 127, 0, 0, 0, 0, 0, 1, 0, 0])
    #expect(WebSocketFrame.close(.normal) == Data([0x88, 0x02, 0x03, 0xE8]))
  }
}
