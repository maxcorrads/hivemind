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
  public let port: Int
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

  /// Puts a host that just worked (or one Bonjour found for this
  /// fingerprint) first, keeping at most GatewayLimits.maxPairingHosts.
  public mutating func remember(_ endpoint: GatewayEndpoint) {
    guard endpoint.port == port else { return }
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
