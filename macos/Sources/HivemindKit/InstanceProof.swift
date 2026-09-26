import CryptoKit
import Foundation

// Proof of instance (docs/macos.md#verifying-the-server). Hivemind Server.app
// starts every server with a fresh random secret, passed to node only in
// HIVEMIND_INSTANCE_SECRET and recorded in the 0600 discovery file. Before
// Hivemind.app gives a page its native bridge, it sends a fresh nonce to
// GET /api/health/instance and checks the answer, an HMAC only that server
// can compute (src/server/instance-proof.ts). Something that took the port
// while Hivemind was not bound answers /api/health just as well, but cannot
// answer this.

/// 32 bytes as 64 lowercase hex characters, the form both secrets and nonces take.
enum Hex32 {
  static let byteCount = 32

  static func isValid(_ text: String) -> Bool {
    text.utf8.count == byteCount * 2 && text.utf8.allSatisfy(isLowercaseHexDigit)
  }

  static func encode(_ bytes: some Sequence<UInt8>) -> String {
    let digits = Array("0123456789abcdef".utf8)
    var out: [UInt8] = []
    for byte in bytes {
      out.append(digits[Int(byte >> 4)])
      out.append(digits[Int(byte & 0x0f)])
    }
    return String(decoding: out, as: UTF8.self)
  }

  static func decode(_ text: String) -> Data? {
    guard isValid(text) else { return nil }
    let utf8 = Array(text.utf8)
    var data = Data(capacity: byteCount)
    for index in stride(from: 0, to: utf8.count, by: 2) {
      data.append(value(utf8[index]) << 4 | value(utf8[index + 1]))
    }
    return data
  }

  static func random() -> String {
    var generator = SystemRandomNumberGenerator()
    return encode((0..<byteCount).map { _ in UInt8.random(in: .min ... .max, using: &generator) })
  }

  private static func isLowercaseHexDigit(_ c: UInt8) -> Bool {
    (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(c) || (UInt8(ascii: "a")...UInt8(ascii: "f")).contains(c)
  }

  private static func value(_ c: UInt8) -> UInt8 {
    c <= UInt8(ascii: "9") ? c - UInt8(ascii: "0") : c - UInt8(ascii: "a") + 10
  }
}

/// A server's per-start secret: 256 random bits as 64 lowercase hex
/// characters. It is never printed (description is redacted) and travels
/// only in the child's environment and the 0600 discovery file.
public struct InstanceSecret: Hashable, Sendable, Codable, CustomStringConvertible {
  public let hex: String

  public init?(hex: String) {
    guard Hex32.isValid(hex) else { return nil }
    self.hex = hex
  }

  /// SystemRandomNumberGenerator is the OS CSPRNG (arc4random_buf).
  public static func generate() -> InstanceSecret { InstanceSecret(hex: Hex32.random())! }

  var key: SymmetricKey { SymmetricKey(data: Hex32.decode(hex)!) }

  public init(from decoder: Decoder) throws {
    let text = try decoder.singleValueContainer().decode(String.self)
    guard let secret = InstanceSecret(hex: text) else {
      throw DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: "Not an instance secret"))
    }
    self = secret
  }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(hex)
  }

  public var description: String { "InstanceSecret(…)" }
}

/// A challenge: 32 fresh random bytes per verification, so an old answer
/// is worth nothing.
public struct InstanceNonce: Equatable, Sendable {
  public let hex: String

  public init?(hex: String) {
    guard Hex32.isValid(hex) else { return nil }
    self.hex = hex
  }

  public static func generate() -> InstanceNonce { InstanceNonce(hex: Hex32.random())! }
}

public enum InstanceProof {
  /// The variable the secret reaches node in; the server deletes it from its
  /// environment as soon as it has read it.
  public static let environmentKey = "HIVEMIND_INSTANCE_SECRET"
  /// Domain separation, versioned; INSTANCE_PROOF_CONTEXT on the server.
  public static let context = "hivemind-instance-v1"

  /// "hivemind-instance-v1\n<nonce>\n<port>": the port the server really
  /// listens on, so an answer relayed from another port does not match.
  public static func message(nonce: InstanceNonce, port: ServerPort) -> Data {
    Data("\(context)\n\(nonce.hex)\n\(port.value)".utf8)
  }

  /// hex(HMAC-SHA256(secret, message)), as the server computes it.
  public static func proof(secret: InstanceSecret, nonce: InstanceNonce, port: ServerPort) -> String {
    Hex32.encode(HMAC<SHA256>.authenticationCode(for: message(nonce: nonce, port: port), using: secret.key))
  }

  /// Whether `presented` is the proof, compared in constant time
  /// (CryptoKit's isValidAuthenticationCode). Anything but 64 lowercase hex
  /// characters is refused before any comparison.
  public static func verify(_ presented: String, secret: InstanceSecret, nonce: InstanceNonce, port: ServerPort) -> Bool {
    guard let code = Hex32.decode(presented) else { return false }
    return HMAC<SHA256>.isValidAuthenticationCode(code, authenticating: message(nonce: nonce, port: port), using: secret.key)
  }
}

extension ServerEndpoint {
  /// GET here answers {proof} for a server Hivemind Server.app started.
  public func instanceURL(nonce: InstanceNonce) -> URL {
    URL(string: "api/health/instance?nonce=\(nonce.hex)", relativeTo: baseURL)!.absoluteURL
  }
}

/// Why a server did not pass the challenge.
public enum InstanceVerificationFailure: Equatable, Sendable {
  /// The discovery file names no secret (written by an older Hivemind Server).
  case noSecret
  /// 404: the server has no secret, so Hivemind Server.app did not start it.
  case notOffered
  /// It answered, but not with the proof for this nonce.
  case wrongProof
  /// Another status, or a body that is not {proof}.
  case badAnswer(status: Int)
  case unreachable(String)
}

public enum InstanceVerification: Equatable, Sendable {
  case verified
  case failed(InstanceVerificationFailure)
}

/// Runs the challenge against one endpoint. The network is behind
/// HTTPGetting, so tests never open a socket.
public struct InstanceVerifier: Sendable {
  private let http: any HTTPGetting
  private let nonce: @Sendable () -> InstanceNonce
  public let timeout: TimeInterval

  public init(
    http: any HTTPGetting = URLSessionGetter(), timeout: TimeInterval = 2,
    nonce: @escaping @Sendable () -> InstanceNonce = InstanceNonce.generate
  ) {
    self.http = http
    self.timeout = timeout
    self.nonce = nonce
  }

  public func verify(_ endpoint: ServerEndpoint, secret: InstanceSecret?) async -> InstanceVerification {
    guard let secret else { return .failed(.noSecret) }
    let nonce = nonce()
    do {
      let (status, body) = try await http.get(endpoint.instanceURL(nonce: nonce), timeout: timeout)
      return Self.interpret(status: status, body: body, secret: secret, nonce: nonce, port: endpoint.port)
    } catch {
      return .failed(.unreachable(error.localizedDescription))
    }
  }

  static func interpret(status: Int, body: Data, secret: InstanceSecret, nonce: InstanceNonce, port: ServerPort) -> InstanceVerification {
    struct Answer: Decodable { let proof: String }
    if status == 404 { return .failed(.notOffered) }
    guard status == 200, let answer = try? JSONDecoder().decode(Answer.self, from: body) else {
      return .failed(.badAnswer(status: status))
    }
    return InstanceProof.verify(answer.proof, secret: secret, nonce: nonce, port: port) ? .verified : .failed(.wrongProof)
  }
}
