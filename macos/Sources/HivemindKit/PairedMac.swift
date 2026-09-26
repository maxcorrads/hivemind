import Foundation

/// A Mac the iOS app has paired with: everything it needs to reach that
/// Mac's gateway again, except the device token, which lives only in the
/// device's Keychain (keyed by `id`). Kept as JSON in the app's own storage.
public struct PairedMac: Codable, Equatable, Sendable, Identifiable {
  /// The device id the Mac gave this device (PairResponse.deviceId). It is
  /// this device's identity on that Mac, and the Keychain key of its token.
  public let id: UUID
  /// The Mac's name; the user may rename it on the device.
  public var name: String
  /// Hosts in the order to try; the last one that worked comes first.
  public private(set) var hosts: [String]
  /// The gateway's port: the one in the pairing code, until the Mac's
  /// gateway answered as the pinned Mac on another one (its port changed,
  /// found through Bonjour).
  public private(set) var port: Int
  /// Pinned for every connection; a Mac with a new identity needs pairing again.
  public let fingerprint: CertificateFingerprint
  public let pairedAt: Date

  /// Nil when the reply does not belong with the payload (a device id that
  /// is not a UUID).
  public init?(payload: PairingPayload, response: PairResponse, at date: Date) {
    guard let id = UUID(uuidString: response.deviceId) else { return nil }
    self.id = id
    name = DeviceName.validate(response.name, limit: GatewayLimits.maxMacNameCharacters) ?? payload.name
    hosts = payload.hosts.map(\.description)
    port = payload.port
    fingerprint = payload.fingerprint
    pairedAt = date
  }

  public var endpoints: [GatewayEndpoint] {
    hosts.compactMap { GatewayEndpoint(host: $0, port: port) }
  }

  /// Puts a host that just answered as this Mac first, keeping at most
  /// GatewayLimits.maxPairingHosts. Only call it for an endpoint that
  /// answered over TLS pinned to `fingerprint` (a device session came from
  /// it): then a new port is the Mac's gateway on a new port (changed in
  /// the menu, and found again through Bonjour), and every saved host uses
  /// it from now on, since the gateway listens on one port on all of them.
  public mutating func remember(_ endpoint: GatewayEndpoint) {
    port = endpoint.port
    hosts.removeAll { $0 == endpoint.host }
    hosts.insert(endpoint.host, at: 0)
    hosts = Array(hosts.prefix(GatewayLimits.maxPairingHosts))
  }

  /// Whether a Bonjour advertisement is this Mac: only the fingerprint
  /// counts, never the advertised name.
  public func isAdvertised(by advertisement: GatewayAdvertisement) -> Bool {
    advertisement.fingerprint == fingerprint
  }
}
