import Foundation
import HivemindKit
import Network
import Observation

/// Macs advertising Hivemind's remote gateway (_hivemind._tcp) on the local
/// network. Runs only while the app is active; iOS asks for Local Network
/// access the first time it starts (NSLocalNetworkUsageDescription).
///
/// What an advertisement is good for (RemoteDiscovery): a hint on the
/// pairing screen, and finding a saved Mac again after its address changed.
/// For the second, the service is resolved to an address by opening (and
/// at once closing) a plain TCP connection to it; the app then connects to
/// that address with the Mac's pin like to any other.
@MainActor
@Observable
final class DiscoveryBrowser {
  private(set) var nearby: [NearbyMac] = []
  /// Private addresses resolved for advertised fingerprints.
  private(set) var resolved: [CertificateFingerprint: [GatewayEndpoint]] = [:]

  /// Fingerprints worth resolving: the saved Macs'.
  var wanted: Set<CertificateFingerprint> = [] {
    didSet { resolveWanted() }
  }

  private var browser: NWBrowser?
  private var results: [String: NWBrowser.Result] = [:]
  private var resolving: [String: NWConnection] = [:]

  func start() {
    guard browser == nil else { return }
    let parameters = NWParameters.tcp
    parameters.includePeerToPeer = false
    let browser = NWBrowser(for: .bonjourWithTXTRecord(type: GatewayAdvertisement.serviceType, domain: nil), using: parameters)
    browser.browseResultsChangedHandler = { [weak self] results, _ in
      MainActor.assumeIsolated { self?.update(results) }
    }
    browser.stateUpdateHandler = { [weak self] state in
      guard case .failed = state else { return }
      MainActor.assumeIsolated {
        // Local Network access denied, or the network went away: start over
        // next time the app becomes active.
        self?.stop()
      }
    }
    self.browser = browser
    browser.start(queue: .main)
  }

  func stop() {
    browser?.cancel()
    browser = nil
    for connection in resolving.values { connection.cancel() }
    resolving = [:]
    results = [:]
    nearby = []
  }

  /// Addresses Bonjour found for a Mac, to try before its saved ones.
  func endpoints(for fingerprint: CertificateFingerprint) -> [GatewayEndpoint] {
    resolved[fingerprint] ?? []
  }

  private func update(_ results: Set<NWBrowser.Result>) {
    var byName: [String: NWBrowser.Result] = [:]
    var found: [NearbyMac] = []
    for result in results {
      guard case .service(let name, _, _, _) = result.endpoint,
            case .bonjour(let record) = result.metadata,
            let mac = RemoteDiscovery.nearbyMac(serviceName: name, txtRecord: record.dictionary) else { continue }
      byName[name] = result
      found.append(mac)
    }
    self.results = byName
    nearby = found.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    let live = Set(found.map(\.advertisement.fingerprint))
    resolved = resolved.filter { live.contains($0.key) }
    resolveWanted()
  }

  private func resolveWanted() {
    for mac in nearby where wanted.contains(mac.advertisement.fingerprint) && resolving[mac.id] == nil && resolved[mac.advertisement.fingerprint] == nil {
      guard let result = results[mac.id] else { continue }
      resolve(result.endpoint, name: mac.id, fingerprint: mac.advertisement.fingerprint)
    }
  }

  private func resolve(_ endpoint: NWEndpoint, name: String, fingerprint: CertificateFingerprint) {
    let connection = NWConnection(to: endpoint, using: .tcp)
    resolving[name] = connection
    connection.stateUpdateHandler = { [weak self, weak connection] state in
      MainActor.assumeIsolated {
        guard let self, let connection else { return }
        switch state {
        case .ready:
          if case .hostPort(let host, let port)? = connection.currentPath?.remoteEndpoint,
             let found = RemoteDiscovery.endpoint(host: Self.text(host), port: Int(port.rawValue)) {
            self.resolved[fingerprint] = [found]
          }
          connection.cancel()
          self.resolving[name] = nil
        case .failed, .cancelled:
          connection.cancel()
          if self.resolving[name] === connection { self.resolving[name] = nil }
        default:
          break
        }
      }
    }
    connection.start(queue: .main)
  }

  private static func text(_ host: NWEndpoint.Host) -> String {
    switch host {
    case .ipv4(let address): "\(address)"
    case .ipv6(let address): "\(address)"
    case .name(let name, _): name
    @unknown default: ""
    }
  }
}
