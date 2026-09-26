import Foundation

// The paired devices Hivemind Server.app keeps (docs/remote-access.md#devices):
// `devices.json` (0600, HivemindPaths.gatewayDevices), written like the
// broker's files with BrokerFiles.writePrivately. It holds no secret: only the
// SHA-256 of each device token, so a copy of the file cannot pair anything.

/// What a paired device may do. Every device gets all of it for now (the
/// user's choice); the field exists so a later "no terminals" device needs no
/// migration. Stored as names, so an unknown one read back is dropped rather
/// than failing the whole file.
public struct DevicePermissions: OptionSet, Hashable, Sendable, Codable {
  public let rawValue: Int
  public init(rawValue: Int) { self.rawValue = rawValue }

  /// The Human UI through the proxy: everything a local Human can do.
  public static let human = DevicePermissions(rawValue: 1 << 0)
  /// /_hivemind/broker: launch, attach to, type into and kill terminal
  /// sessions on the Mac, i.e. run commands as the user.
  public static let terminals = DevicePermissions(rawValue: 1 << 1)

  public static let all: DevicePermissions = [.human, .terminals]

  private static let names: [(String, DevicePermissions)] = [("human", .human), ("terminals", .terminals)]

  public var names: [String] { Self.names.filter { contains($0.1) }.map(\.0) }

  public init(from decoder: any Decoder) throws {
    let names = try decoder.singleValueContainer().decode([String].self)
    self = DevicePermissions(Self.names.filter { names.contains($0.0) }.map(\.1))
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.singleValueContainer()
    try container.encode(names)
  }
}

public struct DeviceRecord: Codable, Equatable, Sendable, Identifiable {
  public let id: UUID
  public var name: String
  public let platform: DevicePlatform
  /// SHA-256 of the device token; the token itself is never stored.
  public let tokenHash: SecretHash
  public let createdAt: Date
  /// The last new session, not every request: a coarse "last used".
  public var lastSeenAt: Date?
  public var permissions: DevicePermissions

  public init(id: UUID = UUID(), name: String, platform: DevicePlatform, tokenHash: SecretHash, createdAt: Date,
              lastSeenAt: Date? = nil, permissions: DevicePermissions = .all) {
    self.id = id
    self.name = name
    self.platform = platform
    self.tokenHash = tokenHash
    self.createdAt = createdAt
    self.lastSeenAt = lastSeenAt
    self.permissions = permissions
  }
}

/// The whole devices.json. Pure value: the app loads it, changes it through
/// these methods and writes it back.
public struct DeviceRegistry: Codable, Equatable, Sendable {
  public static let formatVersion = 1

  public var version: Int
  public private(set) var devices: [DeviceRecord]

  public init(devices: [DeviceRecord] = []) {
    version = Self.formatVersion
    self.devices = devices
  }

  /// The device whose token hashes to `hash`. Compares against every record
  /// in constant time each, and does not stop at a match, so timing tells
  /// nothing about which device (or whether any) matched.
  public func device(tokenHash hash: SecretHash) -> DeviceRecord? {
    var found: DeviceRecord?
    for device in devices where device.tokenHash.matches(hash) {
      if found == nil { found = device }
    }
    return found
  }

  public func device(tokenHash token: DeviceToken) -> DeviceRecord? { device(tokenHash: token.hash) }

  public func device(id: UUID) -> DeviceRecord? { devices.first { $0.id == id } }

  public var isFull: Bool { devices.count >= GatewayLimits.maxDevices }

  /// Adds a new device; false when the registry is full or the id is taken.
  @discardableResult
  public mutating func add(_ device: DeviceRecord) -> Bool {
    guard !isFull, self.device(id: device.id) == nil else { return false }
    devices.append(device)
    return true
  }

  /// Removes a device (revocation). The gateway also closes its sessions and
  /// connections; the record going away is what makes its token worthless.
  @discardableResult
  public mutating func remove(id: UUID) -> DeviceRecord? {
    guard let index = devices.firstIndex(where: { $0.id == id }) else { return nil }
    return devices.remove(at: index)
  }

  public mutating func rename(id: UUID, to name: String) -> Bool {
    guard let index = devices.firstIndex(where: { $0.id == id }), let name = DeviceName.validate(name) else { return false }
    devices[index].name = name
    return true
  }

  public mutating func touch(id: UUID, at date: Date) {
    guard let index = devices.firstIndex(where: { $0.id == id }) else { return }
    devices[index].lastSeenAt = date
  }

  // MARK: File

  public static func decode(_ data: Data) throws -> DeviceRegistry {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    let registry = try decoder.decode(DeviceRegistry.self, from: data)
    guard registry.version == formatVersion else {
      throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "devices.json version \(registry.version) is not \(formatVersion)"))
    }
    return registry
  }

  public func encoded() throws -> Data {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    return try encoder.encode(self)
  }
}

extension HivemindPaths {
  /// The paired devices of the remote gateway (0600).
  public var gatewayDevices: URL { appSupport.appendingPathComponent("devices.json") }
}
