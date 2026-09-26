import Foundation

// Macs the iOS app hears advertise _hivemind._tcp on the local network
// (docs/remote-access.md#network-scope). An advertisement is never trusted
// for pairing, since anyone can send one: pairing always needs the QR code.
// It is only (1) listed on the pairing screen, as a hint of where to look,
// and (2) used to find a saved Mac again after its address changed, matched
// by the pinned fingerprint and connected to with that pin as always.

/// One advertisement the app's Bonjour browser saw.
public struct NearbyMac: Identifiable, Equatable, Sendable {
  /// The Bonjour service name (unique on the network).
  public let id: String
  public let advertisement: GatewayAdvertisement

  public init(serviceName: String, advertisement: GatewayAdvertisement) {
    id = serviceName
    self.advertisement = advertisement
  }

  public var name: String { advertisement.name }
}

public enum RemoteDiscovery {
  /// An advertisement from a TXT record, or nil for one this app cannot use
  /// (malformed, or a newer protocol version it does not speak).
  public static func nearbyMac(serviceName: String, txtRecord: [String: String]) -> NearbyMac? {
    guard let advertisement = GatewayAdvertisement(txtRecord: txtRecord),
          advertisement.version <= GatewayProtocol.version else { return nil }
    return NearbyMac(serviceName: serviceName, advertisement: advertisement)
  }

  /// A resolved service address as an endpoint the app may connect to:
  /// a private address only (the gateway refuses anything else), and no
  /// IPv6 link-local, whose zone would not fit a URL the web view loads.
  /// `host` may carry a zone ("fe80::1%en0"), which is dropped first.
  public static func endpoint(host: String, port: Int) -> GatewayEndpoint? {
    let bare = host.split(separator: "%", maxSplits: 1).first.map(String.init) ?? host
    guard let address = IPAddress(bare)?.unmapped, RemoteAddressPolicy.isPrivate(address) else { return nil }
    if address.isIPv6, AddressScope(address) == .linkLocal { return nil }
    return GatewayEndpoint(host: address.description, port: port)
  }
}
