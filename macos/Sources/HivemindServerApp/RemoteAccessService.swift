import AppKit
import HivemindKit
import Network
import SystemConfiguration

/// Remote access as the menu runs it (docs/remote-access.md): off by
/// default; when on, the TLS identity from the Keychain, one listener per
/// private address with Bonjour, and HivemindKit's GatewayServer behind
/// them, proxying to the Node server this app runs and bridging to its
/// terminal broker. The paired devices outlive the gateway, so they can be
/// listed and revoked while it is off.
@MainActor
final class RemoteAccessService {
  private let paths: HivemindPaths
  private let settingsStore = GatewaySettingsStore()
  private let upstream: @MainActor () -> GatewayUpstreamServer?
  private let brokerRunning: @MainActor () -> Bool
  private let log: RotatingLog
  var onChange: (@MainActor () -> Void)?

  private(set) var settings: GatewaySettings
  /// Nil when devices.json exists but cannot be read (`devicesError`).
  private(set) var devices: GatewayDeviceStore?
  private var devicesError: String?
  private var identity: GatewayIdentity?
  private var server: GatewayServer?
  private var listeners: GatewayListeners?
  private var failure: String?

  private var pairingWindow: PairingWindowController?
  private var devicesWindow: DevicesWindowController?

  init(
    paths: HivemindPaths, server: @escaping @MainActor () -> GatewayUpstreamServer?, brokerRunning: @escaping @MainActor () -> Bool
  ) {
    self.paths = paths
    self.upstream = server
    self.brokerRunning = brokerRunning
    log = RotatingLog(file: paths.logsDirectory.appendingPathComponent("gateway.log"))
    settings = settingsStore.load()
    do {
      let store = try GatewayDeviceStore(storage: GatewayDeviceFile(paths: paths))
      devices = store
      store.onChange = { [weak self] in self?.changed() }
    } catch {
      devicesError = "\(paths.gatewayDevices.path) cannot be read (\(error.localizedDescription)). Move it away to pair again."
    }
  }

  // MARK: State

  var isRunning: Bool { server != nil }
  var isEnabled: Bool { settings.enabled }
  var port: ServerPort { settings.port }
  var deviceList: [DeviceRecord] { devices?.devices ?? [] }
  var fingerprint: CertificateFingerprint? { identity?.fingerprint }
  var pairing: GatewayPairingWindow? { server?.pairing.window }
  var canPair: Bool { server != nil && !(listeners?.addresses.isEmpty ?? true) }

  var status: GatewayStatus {
    let count = deviceList.count
    if let failure = failure ?? (settings.enabled ? devicesError : nil) {
      return GatewayStatus(state: .failed(failure), deviceCount: count)
    }
    guard settings.enabled, let listeners else { return GatewayStatus(state: .off, deviceCount: count) }
    let addresses = listeners.addresses.map(\.address)
    if addresses.isEmpty { return GatewayStatus(state: .noNetwork(port: port.value), deviceCount: count) }
    return GatewayStatus(state: .on(addresses: addresses, port: port.value), deviceCount: count)
  }

  // MARK: On and off

  func startIfEnabled() {
    if settings.enabled { start() }
  }

  func setEnabled(_ enabled: Bool) {
    guard enabled != settings.enabled else { return }
    if enabled {
      guard Dialogs.confirm(
        "Turn on remote access?",
        """
        Paired iPhones and iPads get everything you can do in Hivemind on this Mac, terminals included: \
        they can run commands on this Mac as you. Hivemind Server listens only on private networks \
        (your Wi-Fi or LAN, Tailscale), and only paired devices get in.
        """,
        action: "Turn On") else { return }
    }
    settings.enabled = enabled
    settingsStore.save(settings)
    enabled ? start() : stop()
    changed()
  }

  func changePort() {
    var problem: String?
    while true {
      let info = "Paired devices reach this Mac on this port, on private networks only. The default is \(GatewaySettings.defaultPort)."
      guard let answer = Dialogs.askPort(
        title: "Remote Access Port", current: settings.port, defaultPort: GatewaySettings.defaultPort,
        info: problem.map { "\($0)\n\n\(info)" } ?? info) else { return }
      guard let chosen = ServerPort(answer) else {
        problem = "“\(answer)” is not a port. Enter a number from 1 to 65535."
        continue
      }
      guard chosen.value != upstream()?.port else {
        problem = "\(chosen) is the server’s own port. Choose another."
        continue
      }
      guard chosen != settings.port else { return }
      settings.port = chosen
      settingsStore.save(settings)
      if server != nil {
        // Devices keep their pairing. The iOS app finds the new port through
        // Bonjour on the same network (pinned by fingerprint, as always) and
        // saves it; a device that only reaches this Mac over a VPN such as
        // Tailscale, where Bonjour does not reach, needs that once, or a new
        // pairing.
        stop()
        start()
      }
      changed()
      Dialogs.info("Remote access now uses port \(chosen)", "Paired devices on this network find the new port on their own and remember it. A device that reaches this Mac only another way, such as over Tailscale, finds it the next time it is on this Mac’s network, or pair it again.")
      return
    }
  }

  private func start() {
    guard server == nil else { return }
    failure = nil
    guard let devices else {
      failure = devicesError
      return changed()
    }
    let macName = Self.macName()
    let identity: GatewayIdentity
    do {
      identity = try self.identity ?? GatewayIdentityStore.loadOrCreate(macName: macName)
    } catch {
      failure = error.localizedDescription
      log.append("[gateway] no identity: \(error.localizedDescription)")
      return changed()
    }
    self.identity = identity

    let paths = self.paths
    let brokerRunning = self.brokerRunning
    let upstreamServer = self.upstream
    let log = self.log
    let server = GatewayServer(
      configuration: .init(macName: macName, port: settings.port.value, hostNames: Self.localHostNames(),
                           home: HivemindPaths.userHome.path),
      devices: devices,
      dependencies: .init(
        scheduler: MainQueueScheduler(), upstream: LoopbackConnector(),
        broker: UnixSocketBrokerConnector(path: paths.brokerSocket.path),
        brokerToken: { brokerRunning() ? BrokerTokenFile.read(paths.brokerToken) : nil },
        server: upstreamServer, verifier: InstanceServerVerifier(),
        log: { log.append($0) }))
    server.onChange = { [weak self] in self?.changed() }
    let listeners = GatewayListeners(
      port: settings.port.value, identity: identity.identity,
      advertisement: GatewayAdvertisement(fingerprint: identity.fingerprint, name: macName),
      serviceName: macName, log: { log.append($0) },
      onConnection: { [weak server] stream, local, remote in
        guard let server else { return stream.close() }
        server.accept(stream, local: local, remote: remote)
      })
    listeners.onChange = { [weak self] in self?.changed() }
    self.server = server
    self.listeners = listeners
    listeners.start()
    log.append("[gateway] on, port \(settings.port), fingerprint \(identity.fingerprint.short)")
  }

  /// Off (or Quit): listeners and every connection close. Devices stay paired.
  func stop() {
    pairingWindow?.close()
    listeners?.stop()
    listeners = nil
    server?.stop()
    server = nil
    if failure != nil { failure = nil }
    log.append("[gateway] off")
  }

  // MARK: Pairing

  func openPairing() {
    guard let server, let listeners, let identity else { return }
    let hosts = RemoteAddressPolicy.pairingHosts(listeners.addresses)
    let window = server.openPairing()
    let payload: PairingPayload
    do {
      payload = try PairingPayload(name: server.configuration.macName, hosts: hosts, port: settings.port.value,
                                   fingerprint: identity.fingerprint, code: window.code)
    } catch {
      server.closePairing()
      return Dialogs.error("Cannot pair a device now", "This Mac has no private network address to offer (\(error.localizedDescription)).")
    }
    if let pairingWindow {
      pairingWindow.show(payload: payload)
    } else {
      let controller = PairingWindowController(service: self)
      controller.onClose = { [weak self] in
        self?.server?.closePairing()
        self?.pairingWindow = nil
      }
      pairingWindow = controller
      controller.show(payload: payload)
    }
  }

  // MARK: Devices

  func showDevices() {
    if devicesWindow == nil {
      let controller = DevicesWindowController(service: self)
      controller.onClose = { [weak self] in self?.devicesWindow = nil }
      devicesWindow = controller
    }
    devicesWindow?.show()
  }

  func revoke(_ device: DeviceRecord) {
    guard Dialogs.confirm("Revoke \(device.name)?", "It can no longer reach this Mac, and its open connections close now. It can pair again with a new code.", action: "Revoke") else { return }
    do {
      if let server { try server.revoke(device.id) } else { try devices?.remove(id: device.id) }
      log.append("[gateway] revoked \(device.name)")
    } catch {
      Dialogs.error("The device is revoked, but devices.json could not be written", error.localizedDescription)
    }
    changed()
  }

  /// A new TLS identity: every device must pair again, so every device is
  /// revoked with it.
  func resetIdentity() {
    guard Dialogs.confirm(
      "Reset the remote access identity?",
      "This Mac gets a new certificate. Every paired device is revoked and must pair again.",
      action: "Reset") else { return }
    let wasRunning = server != nil
    do {
      if let server { try server.revokeAll() } else { try devices?.removeAll() }
    } catch {
      Dialogs.error("Could not write devices.json", error.localizedDescription)
    }
    stop()
    GatewayIdentityStore.delete()
    identity = nil
    log.append("[gateway] identity reset; every device revoked")
    if wasRunning { start() }
    changed()
  }

  func showLog() {
    let file = log.file
    if !FileManager.default.fileExists(atPath: file.path) {
      try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
      FileManager.default.createFile(atPath: file.path, contents: nil, attributes: [.posixPermissions: 0o600])
    }
    NSWorkspace.shared.open(file)
  }

  private func changed() {
    pairingWindow?.refresh()
    devicesWindow?.refresh()
    onChange?()
  }

  // MARK: The Mac's names

  /// The computer name from Sharing settings ("Anna's MacBook Pro").
  static func macName() -> String {
    let name = SCDynamicStoreCopyComputerName(nil, nil) as String? ?? Host.current().localizedName ?? "Mac"
    return DeviceName.validate(name, limit: GatewayLimits.maxMacNameCharacters) ?? "Mac"
  }

  /// The Bonjour host name ("annas-macbook-pro.local"): a device that found
  /// the Mac by Bonjour may use it in Host.
  static func localHostNames() -> [String] {
    guard let name = SCDynamicStoreCopyLocalHostName(nil) as String?, !name.isEmpty else { return [] }
    return ["\(name).local"]
  }
}
