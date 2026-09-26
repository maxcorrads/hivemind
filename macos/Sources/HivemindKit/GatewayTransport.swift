import Foundation

// The seams between the gateway's logic and the network. Hivemind
// Server.app backs them with Network.framework (a TLS connection from a
// device, a TCP connection to 127.0.0.1) and the broker's Unix socket; the
// tests back them with fakes, so nothing in them listens or connects.

/// What a stream tells its user, always on the main actor and in order:
/// `onOpen` at most once, then `onData` any number of times, then `onClose`
/// once. Nothing arrives after the user called `close()`.
public struct GatewayStreamHandlers: Sendable {
  public var onOpen: @MainActor @Sendable () -> Void
  public var onData: @MainActor @Sendable (Data) -> Void
  /// A reason for the log, or nil for an orderly end.
  public var onClose: @MainActor @Sendable (String?) -> Void

  public init(
    onOpen: @escaping @MainActor @Sendable () -> Void = {},
    onData: @escaping @MainActor @Sendable (Data) -> Void,
    onClose: @escaping @MainActor @Sendable (String?) -> Void
  ) {
    self.onOpen = onOpen
    self.onData = onData
    self.onClose = onClose
  }
}

/// One byte stream: a device's TLS connection, or a loopback connection to
/// the Node server.
@MainActor
public protocol GatewayStream: AnyObject {
  /// Starts delivering to `handlers` (and connecting, for an outgoing one).
  func start(handlers: GatewayStreamHandlers)
  /// Queues bytes in order. `completion` runs once the network took them,
  /// which is how the gateway knows how much a slow peer still owes it.
  func send(_ data: Data, completion: @escaping @MainActor @Sendable () -> Void)
  /// Stops (false) or resumes (true) reading; TCP then pushes back on the peer.
  func setReceiving(_ receiving: Bool)
  /// Sends what was queued, then closes. No handler runs after this.
  func close()
}

/// Connections to the Node server: always 127.0.0.1, only ever the port
/// the gateway was told, never a host or port a request names.
@MainActor
public protocol GatewayUpstreamConnecting {
  func connect(port: Int) -> any GatewayStream
}

/// Where devices.json lives: a 0600 file in the app, memory in the tests.
public protocol GatewayDeviceStorage {
  /// The file's bytes, or nil when there is none yet.
  func load() throws -> Data?
  func save(_ data: Data) throws
}

/// devices.json in the app-support folder, written 0600 like the broker's
/// files (BrokerFiles.writePrivately), in a 0700 folder.
public struct GatewayDeviceFile: GatewayDeviceStorage {
  public let paths: HivemindPaths

  public init(paths: HivemindPaths) { self.paths = paths }

  public func load() throws -> Data? {
    let url = paths.gatewayDevices
    guard FileManager.default.fileExists(atPath: url.path) else { return nil }
    return try Data(contentsOf: url)
  }

  public func save(_ data: Data) throws {
    try BrokerFiles(paths: paths).prepareFolder()
    try BrokerFiles.writePrivately(data, to: paths.gatewayDevices)
  }
}

/// The paired devices, loaded once and written back on every change. It
/// lives as long as the app, not the gateway, so devices can be listed and
/// revoked while remote access is off.
@MainActor
public final class GatewayDeviceStore {
  public private(set) var registry: DeviceRegistry
  private let storage: any GatewayDeviceStorage
  public var onChange: (@MainActor () -> Void)?

  /// Throws when devices.json exists but cannot be read: it is never
  /// silently replaced, which would forget every paired device.
  public init(storage: any GatewayDeviceStorage) throws {
    self.storage = storage
    registry = try storage.load().map(DeviceRegistry.decode) ?? DeviceRegistry()
  }

  public var devices: [DeviceRecord] { registry.devices }

  /// False when the registry is full.
  public func add(_ device: DeviceRecord) throws -> Bool {
    var next = registry
    guard next.add(device) else { return false }
    try commit(next)
    return true
  }

  /// Revocation takes effect in memory even when the file cannot be
  /// written, so the device stops working now; the error still says the
  /// file is behind.
  @discardableResult
  public func remove(id: UUID) throws -> DeviceRecord? {
    var next = registry
    guard let removed = next.remove(id: id) else { return nil }
    try adopt(next)
    return removed
  }

  public func removeAll() throws {
    try adopt(DeviceRegistry())
  }

  public func rename(id: UUID, to name: String) throws -> Bool {
    var next = registry
    guard next.rename(id: id, to: name) else { return false }
    try commit(next)
    return true
  }

  /// A new session: the coarse "last seen". Not worth failing a session over.
  public func touch(id: UUID, at date: Date) {
    var next = registry
    next.touch(id: id, at: date)
    try? commit(next)
  }

  /// Written first, then adopted: memory never holds a device the file lost.
  private func commit(_ next: DeviceRegistry) throws {
    try storage.save(next.encoded())
    registry = next
    onChange?()
  }

  private func adopt(_ next: DeviceRegistry) throws {
    registry = next
    onChange?()
    try storage.save(next.encoded())
  }
}
