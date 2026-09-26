import Foundation
#if canImport(CryptoKit)
import CryptoKit
#endif
#if canImport(Security)
import Security
#endif
import Testing
@testable import HivemindKit

// The gateway's state machines and small pieces, stepped through time by hand.

private let t0 = Date(timeIntervalSince1970: 1_000_000)

struct GatewayRateLimiterTests {
  @Test func slidingWindow() {
    var limiter = GatewayRateLimiter(limit: 3, window: 60)
    for i in 0..<3 { #expect(limiter.allow("a", now: t0.addingTimeInterval(Double(i))) == true) }
    #expect(limiter.allow("a", now: t0.addingTimeInterval(10)) == false)
    #expect(limiter.allow("b", now: t0.addingTimeInterval(10)) == true)
    // Refused attempts do not count: the first one ages out at 60 s.
    #expect(limiter.allow("a", now: t0.addingTimeInterval(59.9)) == false)
    #expect(limiter.allow("a", now: t0.addingTimeInterval(60)) == true)
    #expect(limiter.allow("a", now: t0.addingTimeInterval(60.5)) == false)
  }

  @Test func boundsTheKeys() {
    var limiter = GatewayRateLimiter(limit: 1, window: 60, maxKeys: 4)
    for i in 0..<10 { _ = limiter.allow("k\(i)", now: t0.addingTimeInterval(Double(i))) }
    #expect(limiter.trackedKeys <= 4)
    // The most recent ones are still limited.
    #expect(limiter.allow("k9", now: t0.addingTimeInterval(11)) == false)
  }
}

struct GatewayPairingTests {
  let code = PairingCode.generate()

  @Test func acceptsTheShownCodeOnce() {
    var pairing = GatewayPairing()
    #expect(pairing.attempt(code, now: t0) == .refused(.pairingClosed))
    pairing.open(now: t0, code: code)
    #expect(pairing.attempt(code, now: t0.addingTimeInterval(299)) == .accepted)
    pairing.completed(deviceName: "Anna's iPhone")
    #expect(pairing.window?.state == .paired(deviceName: "Anna's iPhone"))
    #expect(pairing.attempt(code, now: t0.addingTimeInterval(299)) == .refused(.invalidCode))
  }

  @Test func expires() {
    var pairing = GatewayPairing()
    pairing.open(now: t0, code: code)
    #expect(pairing.attempt(code, now: t0.addingTimeInterval(300)) == .refused(.invalidCode))
    #expect(pairing.window?.isExpired(at: t0.addingTimeInterval(300)) == true)
    #expect(pairing.window?.remaining(at: t0.addingTimeInterval(240)) == 60)
  }

  @Test func locksAfterWrongCodes() {
    var pairing = GatewayPairing()
    pairing.open(now: t0, code: code)
    for _ in 1..<GatewayLimits.maxPairingFailures {
      #expect(pairing.attempt(.generate(), now: t0) == .refused(.invalidCode))
    }
    #expect(pairing.attempt(.generate(), now: t0) == .refused(.pairingLocked))
    // Dead even for the right code, until a new one is shown.
    #expect(pairing.attempt(code, now: t0) == .refused(.pairingLocked))
    let fresh = PairingCode.generate()
    pairing.open(now: t0, code: fresh)
    #expect(pairing.attempt(fresh, now: t0) == .accepted)
  }

  @Test func closingDropsTheCode() {
    var pairing = GatewayPairing()
    pairing.open(now: t0, code: code)
    pairing.close()
    #expect(pairing.attempt(code, now: t0) == .refused(.pairingClosed))
  }
}

struct GatewaySessionStoreTests {
  let device = UUID()

  @Test func liveUntilExpiry() {
    var store = GatewaySessionStore()
    let (token, expiresAt) = store.create(for: device, now: t0)
    #expect(expiresAt == t0.addingTimeInterval(GatewayLimits.sessionLifetime))
    #expect(store.device(for: token, now: t0.addingTimeInterval(3599)) == device)
    #expect(store.device(for: token, now: expiresAt) == nil)
    #expect(store.device(for: .generate(), now: t0) == nil)
    // Only hashes are kept.
    #expect(store.sessions.map(\.tokenHash) == [token.hash])
  }

  @Test func keepsTheNewestPerDevice() {
    var store = GatewaySessionStore()
    var tokens: [DeviceSessionToken] = []
    for i in 0...GatewayLimits.maxSessionsPerDevice {
      tokens.append(store.create(for: device, now: t0.addingTimeInterval(Double(i))).token)
    }
    let other = store.create(for: UUID(), now: t0).token
    #expect(store.device(for: tokens[0], now: t0.addingTimeInterval(10)) == nil)
    for token in tokens.dropFirst() { #expect(store.device(for: token, now: t0.addingTimeInterval(10)) == device) }
    #expect(store.device(for: other, now: t0.addingTimeInterval(10)) != nil)
  }

  @Test func revocationEndsEverySession() {
    var store = GatewaySessionStore()
    let a = store.create(for: device, now: t0).token
    let b = store.create(for: device, now: t0).token
    let other = UUID()
    let c = store.create(for: other, now: t0).token
    store.revoke(deviceId: device)
    #expect(store.device(for: a, now: t0) == nil)
    #expect(store.device(for: b, now: t0) == nil)
    #expect(store.device(for: c, now: t0) == other)
  }
}

struct GatewaySettingsTests {
  final class Memory: SettingsStorage {
    var values: [String: Any] = [:]
    func object(forKey key: String) -> Any? { values[key] }
    func string(forKey key: String) -> String? { values[key] as? String }
    func set(_ value: Any?, forKey key: String) { values[key] = value }
    func removeObject(forKey key: String) { values[key] = nil }
  }

  @Test func offByDefault() {
    let memory = Memory()
    let store = GatewaySettingsStore(defaults: memory)
    #expect(store.load() == GatewaySettings(enabled: false, port: ServerPort(7443)!))
    store.save(GatewaySettings(enabled: true, port: ServerPort(8443)!))
    #expect(store.load() == GatewaySettings(enabled: true, port: ServerPort(8443)!))
    store.save(GatewaySettings())
    #expect(memory.values.isEmpty)
    memory.values[GatewaySettingsStore.portKey] = NSNumber(value: 0)
    #expect(store.load().port.value == 7443)
  }

  @Test func listenPlan() {
    let en0 = InterfaceAddress(interface: "en0", address: IPAddress("192.168.1.20")!)
    let ts = InterfaceAddress(interface: "utun4", address: IPAddress("100.101.102.103")!)
    let pub = InterfaceAddress(interface: "en1", address: IPAddress("8.8.8.8")!)
    let plan = GatewayListenPlan(current: [], interfaces: [pub, ts, en0])
    #expect(plan.open == [en0, ts])
    #expect(plan.close == [])
    let next = GatewayListenPlan(current: [en0, ts], interfaces: [en0, pub])
    #expect(next.open == [])
    #expect(next.close == [ts])
    #expect(GatewayListenPlan(current: [en0], interfaces: [en0]).isEmpty)
  }

  @Test func statusTitles() {
    let addresses = [IPAddress("192.168.1.20")!, IPAddress("fd7a::1")!, IPAddress("100.64.0.1")!]
    #expect(GatewayStatus(state: .off, deviceCount: 0).title == "Remote Access: Off")
    #expect(GatewayStatus(state: .on(addresses: addresses, port: 7443), deviceCount: 1).title
      == "Remote Access: 192.168.1.20:7443, [fd7a::1]:7443 +1")
    #expect(GatewayStatus(state: .noNetwork(port: 7443), deviceCount: 2).devicesTitle == "2 paired devices")
    #expect(GatewayStatus(state: .failed("x"), deviceCount: 1).devicesTitle == "1 paired device")
  }
}

struct GatewayDeviceStoreTests {
  final class Memory: GatewayDeviceStorage {
    var data: Data?
    var failSaves = false
    struct Failure: Error {}
    func load() throws -> Data? { data }
    func save(_ data: Data) throws {
      if failSaves { throw Failure() }
      self.data = data
    }
  }

  func record(_ name: String) -> DeviceRecord {
    DeviceRecord(name: name, platform: .ios, tokenHash: DeviceToken.generate().hash, createdAt: t0)
  }

  @MainActor @Test func persistsEveryChange() throws {
    let memory = Memory()
    let store = try GatewayDeviceStore(storage: memory)
    let device = record("Anna's iPhone")
    #expect(try store.add(device))
    #expect(try GatewayDeviceStore(storage: memory).devices == [device])
    #expect(try store.rename(id: device.id, to: "  Work iPhone "))
    #expect(try DeviceRegistry.decode(memory.data!).devices.first?.name == "Work iPhone")
    try store.remove(id: device.id)
    #expect(try DeviceRegistry.decode(memory.data!).devices.isEmpty)
  }

  @MainActor @Test func aFailedWriteNeverAddsButStillRevokes() throws {
    let memory = Memory()
    let store = try GatewayDeviceStore(storage: memory)
    let device = record("iPad")
    #expect(try store.add(device))
    memory.failSaves = true
    #expect(throws: Memory.Failure.self) { try store.add(record("other")) }
    #expect(store.devices == [device])
    #expect(throws: Memory.Failure.self) { try store.remove(id: device.id) }
    #expect(store.devices.isEmpty)
  }

  @MainActor @Test func refusesADamagedFile() {
    let memory = Memory()
    memory.data = Data("{nope".utf8)
    #expect(throws: (any Error).self) { try GatewayDeviceStore(storage: memory) }
  }

  @Test func fileIsPrivate() throws {
    let home = try temporaryHome()
    defer { try? FileManager.default.removeItem(at: home) }
    let file = GatewayDeviceFile(paths: HivemindPaths(home: home))
    #expect(try file.load() == nil)
    try file.save(Data("{}".utf8))
    #expect(try file.load() == Data("{}".utf8))
    let attributes = try FileManager.default.attributesOfItem(atPath: HivemindPaths(home: home).gatewayDevices.path)
    #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
  }
}

struct GatewayCertificateTests {
  @Test func derBasics() {
    #expect(DER.integer(0) == Data([0x02, 0x01, 0x00]))
    #expect(DER.integer(2) == Data([0x02, 0x01, 0x02]))
    #expect(DER.unsignedInteger(Data([0x00, 0x80])) == Data([0x02, 0x02, 0x00, 0x80]))
    #expect(DER.objectIdentifier("1.2.840.10045.2.1") == Data([0x06, 0x07, 0x2A, 0x86, 0x48, 0xCE, 0x3D, 0x02, 0x01]))
    #expect(DER.tlv(0x04, Data(repeating: 0, count: 200)).prefix(3) == Data([0x04, 0x81, 200]))
    #expect(DER.tlv(0x04, Data(repeating: 0, count: 300)).prefix(4) == Data([0x04, 0x82, 0x01, 0x2C]))
    #expect(DER.time(Date(timeIntervalSince1970: 0)) == DER.tlv(0x17, Data("700101000000Z".utf8)))
    #expect(DER.time(Date(timeIntervalSince1970: 2_556_143_999)) == DER.tlv(0x18, Data("20501231235959Z".utf8)))
    let serial = GatewayCertificate.randomSerial()
    #expect(serial.count == 16)
    #expect(serial[0] & 0x80 == 0 && serial[0] != 0)
  }

  #if canImport(CryptoKit) && canImport(Security)
  /// A certificate made with an in-memory key (nothing touches a Keychain)
  /// is one Security reads, with that key and a valid self-signature.
  @Test func selfSignedCertificateIsValid() throws {
    let key = P256.Signing.PrivateKey()
    let der = try GatewayCertificate.make(publicKeyX963: key.publicKey.x963Representation, commonName: "Hivemind Server on Test",
                                          now: Date()) { tbs in try key.signature(for: tbs).derRepresentation }
    let certificate = try #require(SecCertificateCreateWithData(nil, der as CFData))
    #expect(SecCertificateCopySubjectSummary(certificate) as String? == "Hivemind Server on Test")
    let publicKey = try #require(SecCertificateCopyKey(certificate))
    #expect(SecKeyCopyExternalRepresentation(publicKey, nil) as Data? == key.publicKey.x963Representation)
    #expect(CertificateFingerprint(certificateDER: SecCertificateCopyData(certificate) as Data) == CertificateFingerprint(certificateDER: der))

    // The outer signature covers the TBS element, which comes first inside.
    let parts = try DERReader.elements(ofSequence: der)
    #expect(parts.count == 3)
    #expect(parts[0].first == 0x30)
    #expect(parts[2].first == 0x03)
    let signature = try P256.Signing.ECDSASignature(derRepresentation: try DERReader.content(of: parts[2]).dropFirst())
    #expect(key.publicKey.isValidSignature(signature, for: parts[0]))
  }
  #endif
}

/// Just enough of a DER reader to take a certificate apart in a test.
enum DERReader {
  struct Malformed: Error {}

  /// The header length and content length of the TLV at `start`.
  static func header(_ der: Data, at start: Int) throws -> (header: Int, length: Int) {
    guard start + 1 < der.endIndex else { throw Malformed() }
    let first = Int(der[start + 1])
    guard first & 0x80 != 0 else { return (2, first) }
    let count = first & 0x7F
    guard (1...3).contains(count), start + 1 + count < der.endIndex else { throw Malformed() }
    let length = (0..<count).reduce(0) { $0 << 8 | Int(der[start + 2 + $1]) }
    return (2 + count, length)
  }

  static func content(of tlv: Data) throws -> Data {
    let (header, length) = try header(tlv, at: tlv.startIndex)
    guard tlv.count == header + length else { throw Malformed() }
    return tlv.dropFirst(header)
  }

  /// The whole TLVs inside a SEQUENCE.
  static func elements(ofSequence der: Data) throws -> [Data] {
    let body = try content(of: der)
    var out: [Data] = []
    var index = body.startIndex
    while index < body.endIndex {
      let (header, length) = try header(body, at: index)
      guard index + header + length <= body.endIndex else { throw Malformed() }
      out.append(body[index..<(index + header + length)])
      index += header + length
    }
    return out
  }
}
