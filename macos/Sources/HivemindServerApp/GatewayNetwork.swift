import Darwin
import Foundation
import HivemindKit
import Network

// Network.framework under the gateway: the TLS listeners on the Mac's
// private addresses, the streams HivemindKit's GatewayServer reads and
// writes, and the loopback connections to the Node server. All callbacks run
// on the main queue, where GatewayServer lives; TLS itself runs in the
// framework.

/// Network has an IPAddress protocol of its own; in this app the name means
/// HivemindKit's, which the address policy works on.
typealias IPAddress = HivemindKit.IPAddress

/// An NWConnection as a GatewayStream.
@MainActor
final class NWGatewayStream: GatewayStream {
  private let connection: NWConnection
  private var handlers: GatewayStreamHandlers?
  private var receiving = true
  private var receivePending = false
  private var opened = false
  private var closed = false

  static let readSize = 64 * 1024
  /// How long a close waits for the peer to take the last bytes.
  static let closeGrace: TimeInterval = 5

  init(_ connection: NWConnection) {
    self.connection = connection
  }

  func start(handlers: GatewayStreamHandlers) {
    self.handlers = handlers
    connection.stateUpdateHandler = { [weak self] state in
      MainActor.assumeIsolated { self?.stateChanged(state) }
    }
    if case .setup = connection.state {
      connection.start(queue: .main)
    } else {
      stateChanged(connection.state)
    }
    receiveNext()
  }

  private func stateChanged(_ state: NWConnection.State) {
    switch state {
    case .ready:
      guard !opened else { return }
      opened = true
      handlers?.onOpen()
    // A refused loopback connection waits for a network change instead of
    // failing; for the gateway that is simply "not there".
    case .waiting(let error), .failed(let error):
      end(error.localizedDescription)
    case .cancelled:
      end(nil)
    default:
      break
    }
  }

  private func receiveNext() {
    guard receiving, !receivePending, !closed else { return }
    receivePending = true
    connection.receive(minimumIncompleteLength: 1, maximumLength: Self.readSize) { [weak self] data, _, isComplete, error in
      MainActor.assumeIsolated {
        guard let self, !self.closed else { return }
        self.receivePending = false
        if let data, !data.isEmpty { self.handlers?.onData(data) }
        if isComplete { return self.end(nil) }
        if let error { return self.end(error.localizedDescription) }
        self.receiveNext()
      }
    }
  }

  func send(_ data: Data, completion: @escaping @MainActor @Sendable () -> Void) {
    guard !closed else { return }
    connection.send(content: data, completion: .contentProcessed { [weak self] error in
      MainActor.assumeIsolated {
        completion()
        if let error { self?.end(error.localizedDescription) }
      }
    })
  }

  func setReceiving(_ receiving: Bool) {
    self.receiving = receiving
    if receiving { receiveNext() }
  }

  func close() {
    guard !closed else { return }
    closed = true
    handlers = nil
    let connection = self.connection
    connection.stateUpdateHandler = nil
    // After what was queued: TLS close_notify, then FIN.
    connection.send(content: nil, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { _ in
      connection.cancel()
    })
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.closeGrace) { connection.cancel() }
  }

  private func end(_ reason: String?) {
    guard !closed else { return }
    closed = true
    let handlers = self.handlers
    self.handlers = nil
    connection.stateUpdateHandler = nil
    connection.cancel()
    handlers?.onClose(reason)
  }
}

/// Plain TCP to 127.0.0.1 on the one port the gateway was given: the Node
/// server, never anything a request names.
struct LoopbackConnector: GatewayUpstreamConnecting {
  static let connectTimeout = 5

  func connect(port: Int) -> any GatewayStream {
    let tcp = NWProtocolTCP.Options()
    tcp.noDelay = true
    tcp.connectionTimeout = Self.connectTimeout
    let parameters = NWParameters(tls: nil, tcp: tcp)
    parameters.requiredInterfaceType = .loopback
    let connection = NWConnection(host: .ipv4(.loopback), port: NWEndpoint.Port(rawValue: UInt16(port))!, using: parameters)
    return NWGatewayStream(connection)
  }
}

extension IPAddress {
  init?(_ host: NWEndpoint.Host) {
    switch host {
    case .ipv4(let address): self = .v4(Array(address.rawValue))
    case .ipv6(let address): self = .v6(Array(address.rawValue), zone: address.interface?.name)
    default: return nil
    }
  }

  /// The address as Network.framework takes it, with the zone of a
  /// link-local IPv6 address.
  var networkHost: NWEndpoint.Host? {
    switch self {
    case .v4(let bytes): IPv4Address(Data(bytes)).map { .ipv4($0) }
    case .v6: IPv6Address(description).map { .ipv6($0) }
    }
  }
}

extension NWEndpoint {
  var ipAddress: IPAddress? {
    guard case .hostPort(let host, _) = self else { return nil }
    return IPAddress(host)
  }
}

/// The Mac's addresses, from getifaddrs: interfaces that are up and not
/// loopback. RemoteAddressPolicy picks the private ones.
enum MacInterfaces {
  static func addresses() -> [InterfaceAddress] {
    var list: UnsafeMutablePointer<ifaddrs>?
    guard getifaddrs(&list) == 0, let first = list else { return [] }
    defer { freeifaddrs(list) }
    var out: [InterfaceAddress] = []
    for entry in sequence(first: first, next: { $0.pointee.ifa_next }) {
      let flags = Int32(entry.pointee.ifa_flags)
      guard flags & IFF_UP != 0, flags & IFF_RUNNING != 0, flags & IFF_LOOPBACK == 0,
            let socketAddress = entry.pointee.ifa_addr
      else { continue }
      let name = String(cString: entry.pointee.ifa_name)
      switch Int32(socketAddress.pointee.sa_family) {
      case AF_INET:
        let bytes = socketAddress.withMemoryRebound(to: sockaddr_in.self, capacity: 1) {
          withUnsafeBytes(of: $0.pointee.sin_addr) { Array($0) }
        }
        out.append(InterfaceAddress(interface: name, address: .v4(bytes)))
      case AF_INET6:
        let bytes = socketAddress.withMemoryRebound(to: sockaddr_in6.self, capacity: 1) {
          withUnsafeBytes(of: $0.pointee.sin6_addr) { Array($0) }
        }
        let linkLocal = bytes[0] == 0xfe && bytes[1] & 0xc0 == 0x80
        out.append(InterfaceAddress(interface: name, address: .v6(bytes, zone: linkLocal ? name : nil)))
      default:
        continue
      }
    }
    return out
  }
}

/// One TLS listener per private address of the Mac, following address
/// changes, with the Bonjour advertisement on one of them. Every accepted
/// connection is checked twice: its remote address against the listener's
/// before the handshake, and both ends from the connection's own path once
/// it is ready, when it goes to GatewayServer.
@MainActor
final class GatewayListeners {
  private let port: NWEndpoint.Port
  private let identity: SecIdentity
  private let advertisement: GatewayAdvertisement
  private let serviceName: String
  private let onConnection: @MainActor (any GatewayStream, IPAddress, IPAddress) -> Void
  private let log: @MainActor (String) -> Void
  var onChange: (@MainActor () -> Void)?

  private var listeners: [InterfaceAddress: NWListener] = [:]
  private var ready: Set<InterfaceAddress> = []
  private var advertisedOn: InterfaceAddress?
  private var handshakes: [ObjectIdentifier: NWConnection] = [:]
  private var monitor: NWPathMonitor?
  private var stopped = false
  private(set) var lastError: String?

  /// TLS handshakes in flight at once, and how long one may take.
  static let maxHandshakes = 32
  static let handshakeTimeout: TimeInterval = 15
  static let retryDelay: TimeInterval = 30

  init(port: Int, identity: SecIdentity, advertisement: GatewayAdvertisement, serviceName: String,
       log: @escaping @MainActor (String) -> Void,
       onConnection: @escaping @MainActor (any GatewayStream, IPAddress, IPAddress) -> Void) {
    self.port = NWEndpoint.Port(rawValue: UInt16(port))!
    self.identity = identity
    self.advertisement = advertisement
    self.serviceName = serviceName
    self.log = log
    self.onConnection = onConnection
  }

  /// The addresses listening now, in the order a pairing code lists them.
  var addresses: [InterfaceAddress] {
    RemoteAddressPolicy.listenAddresses(Array(ready))
  }

  func start() {
    let monitor = NWPathMonitor()
    monitor.pathUpdateHandler = { [weak self] _ in
      // The path says an interface changed; its addresses come from getifaddrs.
      MainActor.assumeIsolated { self?.refresh() }
    }
    monitor.start(queue: .main)
    self.monitor = monitor
    refresh()
  }

  func stop() {
    stopped = true
    monitor?.cancel()
    monitor = nil
    for listener in listeners.values { listener.cancel() }
    listeners.removeAll()
    ready.removeAll()
    for connection in handshakes.values { connection.cancel() }
    handshakes.removeAll()
  }

  func refresh() {
    guard !stopped else { return }
    let plan = GatewayListenPlan(current: Set(listeners.keys), interfaces: MacInterfaces.addresses())
    for gone in plan.close {
      listeners.removeValue(forKey: gone)?.cancel()
      ready.remove(gone)
      if advertisedOn == gone { advertisedOn = nil }
    }
    // Bonjour on exactly one listener; another takes over when it goes.
    let target = advertisedOn == nil
      ? RemoteAddressPolicy.listenAddresses(Array(Set(listeners.keys).union(plan.open))).first : nil
    for entry in plan.open { listen(on: entry, advertise: entry == target) }
    if let target, advertisedOn == nil, listeners[target] != nil {
      listeners.removeValue(forKey: target)?.cancel()
      ready.remove(target)
      listen(on: target, advertise: true)
    }
    if !plan.isEmpty { onChange?() }
  }

  private func listen(on entry: InterfaceAddress, advertise: Bool = false) {
    guard let host = entry.address.networkHost else { return }
    let parameters = tlsParameters()
    parameters.requiredLocalEndpoint = .hostPort(host: host, port: port)
    parameters.allowLocalEndpointReuse = true
    let listener: NWListener
    do {
      listener = try NWListener(using: parameters)
    } catch {
      lastError = "\(entry.address): \(error.localizedDescription)"
      log("[gateway] cannot listen on \(entry.address):\(port): \(error.localizedDescription)")
      return
    }
    if advertise {
      listener.service = NWListener.Service(
        name: serviceName, type: GatewayAdvertisement.serviceType, domain: nil,
        txtRecord: NWTXTRecord(advertisement.txtRecord))
      advertisedOn = entry
    }
    let local = entry.address
    listener.newConnectionHandler = { [weak self] connection in
      MainActor.assumeIsolated { self?.handshake(connection, local: local) }
    }
    listener.stateUpdateHandler = { [weak self, weak listener] state in
      MainActor.assumeIsolated {
        guard let self, let listener, self.listeners[entry] === listener else { return }
        switch state {
        case .ready:
          self.ready.insert(entry)
          self.lastError = nil
          self.log("[gateway] listening on \(GatewayEndpoint(host: local.description, port: Int(self.port.rawValue))?.description ?? "\(local)")")
          self.onChange?()
        case .failed(let error):
          self.lastError = "\(local): \(error.localizedDescription)"
          self.log("[gateway] listener on \(local) failed: \(error.localizedDescription)")
          self.listeners[entry] = nil
          self.ready.remove(entry)
          if self.advertisedOn == entry { self.advertisedOn = nil }
          listener.cancel()
          self.onChange?()
          // Try again later (a port another app held, say), or on the next
          // network change.
          DispatchQueue.main.asyncAfter(deadline: .now() + Self.retryDelay) { [weak self] in
            MainActor.assumeIsolated { self?.refresh() }
          }
        default:
          break
        }
      }
    }
    listeners[entry] = listener
    listener.start(queue: .main)
  }

  private func tlsParameters() -> NWParameters {
    let tls = NWProtocolTLS.Options()
    let security = tls.securityProtocolOptions
    if let secIdentity = sec_identity_create(identity) {
      sec_protocol_options_set_local_identity(security, secIdentity)
    }
    // Both ends are Hivemind: nothing older is needed.
    sec_protocol_options_set_min_tls_protocol_version(security, .TLSv13)
    sec_protocol_options_set_max_tls_protocol_version(security, .TLSv13)
    // The gateway speaks HTTP/1.1 only; without this a client may try h2.
    sec_protocol_options_add_tls_application_protocol(security, "http/1.1")
    let tcp = NWProtocolTCP.Options()
    tcp.noDelay = true
    tcp.enableKeepalive = true
    tcp.keepaliveIdle = 60
    let parameters = NWParameters(tls: tls, tcp: tcp)
    parameters.includePeerToPeer = false
    return parameters
  }

  private func handshake(_ connection: NWConnection, local: IPAddress) {
    // Before any TLS work: a remote address that is not private never gets a
    // handshake.
    guard !stopped, let remote = connection.endpoint.ipAddress, RemoteAddressPolicy.accepts(local: local, remote: remote),
          handshakes.count < Self.maxHandshakes
    else {
      connection.cancel()
      return
    }
    let id = ObjectIdentifier(connection)
    handshakes[id] = connection
    connection.stateUpdateHandler = { [weak self, weak connection] state in
      MainActor.assumeIsolated {
        guard let self, let connection else { return }
        switch state {
        case .ready:
          self.handshakes[id] = nil
          // The connection's own view of both ends, now that it has one.
          let path = connection.currentPath
          guard let localNow = path?.localEndpoint?.ipAddress ?? Optional(local),
                let remoteNow = path?.remoteEndpoint?.ipAddress ?? connection.endpoint.ipAddress
          else {
            connection.cancel()
            return
          }
          connection.stateUpdateHandler = nil
          self.onConnection(NWGatewayStream(connection), localNow, remoteNow)
        case .failed, .cancelled:
          self.handshakes[id] = nil
          connection.cancel()
        default:
          break
        }
      }
    }
    connection.start(queue: .main)
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.handshakeTimeout) { [weak self, weak connection] in
      MainActor.assumeIsolated {
        guard let self, let connection, self.handshakes[id] != nil else { return }
        self.handshakes[id] = nil
        connection.cancel()
      }
    }
  }
}
