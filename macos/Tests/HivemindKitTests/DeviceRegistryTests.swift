import Foundation
import Testing
@testable import HivemindKit

struct DeviceRegistryTests {
  func record(_ name: String, token: DeviceToken = .generate(), created: TimeInterval = 1_800_000_000) -> DeviceRecord {
    DeviceRecord(name: name, platform: .ios, tokenHash: token.hash, createdAt: Date(timeIntervalSince1970: created))
  }

  @Test func findsByTokenHashOnly() {
    let token = DeviceToken.generate()
    var registry = DeviceRegistry()
    registry.add(record("phone", token: token))
    registry.add(record("tablet"))
    #expect(registry.device(tokenHash: token)?.name == "phone")
    #expect(registry.device(tokenHash: DeviceToken.generate()) == nil)
  }

  @Test func addRemoveRenameTouch() {
    var registry = DeviceRegistry()
    let phone = record("phone")
    let added = registry.add(phone), addedTwice = registry.add(phone)
    #expect(added && !addedTwice)
    let renamed = registry.rename(id: phone.id, to: "  Anna's phone "), renamedEmpty = registry.rename(id: phone.id, to: "")
    #expect(renamed && !renamedEmpty)
    #expect(registry.device(id: phone.id)?.name == "Anna's phone")
    registry.touch(id: phone.id, at: Date(timeIntervalSince1970: 1_800_000_100))
    #expect(registry.device(id: phone.id)?.lastSeenAt == Date(timeIntervalSince1970: 1_800_000_100))
    let removed = registry.remove(id: phone.id), removedTwice = registry.remove(id: phone.id)
    #expect(removed?.id == phone.id && removedTwice == nil)
    #expect(registry.devices.isEmpty)
  }

  @Test func refusesPastTheLimit() {
    var registry = DeviceRegistry()
    for index in 0..<GatewayLimits.maxDevices {
      let added = registry.add(record("d\(index)"))
      #expect(added)
    }
    #expect(registry.isFull)
    let overflow = registry.add(record("one too many"))
    #expect(!overflow)
  }

  @Test func fileRoundTripHoldsNoSecret() throws {
    let token = DeviceToken.generate()
    var registry = DeviceRegistry()
    registry.add(record("phone", token: token))
    let data = try registry.encoded()
    let text = String(decoding: data, as: UTF8.self)
    #expect(!text.contains(token.value))
    #expect(text.contains(token.hash.hex))
    #expect(text.contains(#""permissions" : ["#))
    #expect(try DeviceRegistry.decode(data) == registry)
  }

  @Test func permissions() throws {
    #expect(DevicePermissions.all.names == ["human", "terminals"])
    let decoded = try JSONDecoder().decode(DevicePermissions.self, from: Data(#"["terminals","from-the-future"]"#.utf8))
    #expect(decoded == .terminals)
    #expect(record("x").permissions == .all)
  }

  @Test func refusesOtherFormatVersions() {
    #expect(throws: DecodingError.self) { try DeviceRegistry.decode(Data(#"{"version":2,"devices":[]}"#.utf8)) }
    #expect(throws: DecodingError.self) { try DeviceRegistry.decode(Data("[]".utf8)) }
  }

  @Test func path() {
    let paths = HivemindPaths(home: URL(fileURLWithPath: "/Users/h", isDirectory: true))
    #expect(paths.gatewayDevices.path == "/Users/h/Library/Application Support/Hivemind/devices.json")
  }
}
