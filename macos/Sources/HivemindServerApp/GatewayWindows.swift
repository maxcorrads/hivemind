import AppKit
import CoreImage
import CoreImage.CIFilterBuiltins
import HivemindKit
import SwiftUI

// The two remote-access windows: "Pair a Device…" (the QR code) and
// "Devices…" (the paired devices, with Revoke). A menu-bar app has no
// windows of its own, so each is an NSWindow around a SwiftUI view,
// brought to the front when opened.

@MainActor
private func makeWindow(title: String, content: some View) -> NSWindow {
  let window = NSWindow(contentViewController: NSHostingController(rootView: content))
  window.title = title
  window.styleMask = [.titled, .closable]
  window.isReleasedWhenClosed = false
  window.center()
  return window
}

// MARK: - Pairing

@MainActor
final class PairingModel: ObservableObject {
  weak var service: RemoteAccessService?
  @Published private(set) var payload: PairingPayload?
  @Published private(set) var qrCode: NSImage?
  var dismiss: (@MainActor () -> Void)?

  init(service: RemoteAccessService) { self.service = service }

  var window: GatewayPairingWindow? { service?.pairing }
  var fingerprint: CertificateFingerprint? { payload?.fingerprint }

  func show(_ payload: PairingPayload) {
    self.payload = payload
    qrCode = QRCode.image(payload.url.absoluteString, side: 260)
  }

  func refresh() { objectWillChange.send() }

  func copyLink() {
    guard let payload else { return }
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(payload.url.absoluteString, forType: .string)
  }

  func newCode() { service?.openPairing() }
}

@MainActor
final class PairingWindowController: NSObject, NSWindowDelegate {
  private let model: PairingModel
  private let window: NSWindow
  private var closing: DispatchWorkItem?
  var onClose: (@MainActor () -> Void)?

  init(service: RemoteAccessService) {
    let model = PairingModel(service: service)
    self.model = model
    window = makeWindow(title: "Pair a Device", content: PairingView(model: model))
    super.init()
    model.dismiss = { [weak self] in self?.close() }
    window.delegate = self
  }

  func show(payload: PairingPayload) {
    closing?.cancel()
    closing = nil
    model.show(payload)
    Dialogs.activate()
    window.makeKeyAndOrderFront(nil)
  }

  /// Pairing state changed. Once a device paired, the window shows so for a
  /// moment and closes: the code is used up anyway.
  func refresh() {
    model.refresh()
    if case .paired = model.window?.state, closing == nil {
      let item = DispatchWorkItem { [weak self] in self?.close() }
      closing = item
      DispatchQueue.main.asyncAfter(deadline: .now() + 2.5, execute: item)
    }
  }

  func close() { window.close() }

  func windowWillClose(_ notification: Notification) {
    closing?.cancel()
    onClose?()
  }
}

private struct PairingView: View {
  @ObservedObject var model: PairingModel

  var body: some View {
    VStack(spacing: 14) {
      Text("Pair an iPhone or iPad").font(.title2.bold())
      Text("In the Hivemind app on the device, scan this code.")
        .foregroundStyle(.secondary)
      TimelineView(.periodic(from: .now, by: 1)) { context in
        let phase = Phase(window: model.window, now: context.date)
        VStack(spacing: 10) {
          ZStack {
            RoundedRectangle(cornerRadius: 12).fill(Color.white)
            if phase.showsCode, let image = model.qrCode {
              Image(nsImage: image).interpolation(.none).resizable().padding(12)
            } else {
              Image(systemName: phase.symbol).font(.system(size: 64)).foregroundStyle(Color.gray)
            }
          }
          .frame(width: 260, height: 260)
          .accessibilityLabel(phase.showsCode ? "Pairing QR code" : phase.text)
          Text(phase.text).font(.headline).foregroundStyle(phase.isProblem ? Color.orange : Color.primary)
        }
      }
      if let fingerprint = model.fingerprint {
        VStack(spacing: 2) {
          Text("Certificate").font(.caption).foregroundStyle(.secondary)
          Text(fingerprint.short).font(.system(.body, design: .monospaced)).textSelection(.enabled)
        }
        .help("The device shows the same when it pairs.")
      }
      Text("""
        Anyone who sees this code while it is valid can pair a device that controls this Mac, \
        terminals included. Do not share or photograph it.
        """)
        .font(.caption).foregroundStyle(.secondary).multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true)
      HStack {
        Button("Copy Pairing Link") { model.copyLink() }
          .help("Paste it in the Hivemind app instead of scanning.")
        Spacer()
        Button("New Code") { model.newCode() }
        Button("Done") { model.dismiss?() }.keyboardShortcut(.defaultAction)
      }
    }
    .padding(24)
    .frame(width: 400)
  }

  struct Phase {
    let text: String
    let symbol: String
    let showsCode: Bool
    let isProblem: Bool

    init(window: GatewayPairingWindow?, now: Date) {
      guard let window else {
        self.init("Closed", "xmark.circle", false, true)
        return
      }
      switch window.state {
      case .paired(let name):
        self.init("Paired with \(name)", "checkmark.circle", false, false)
      case .locked:
        self.init("Too many wrong codes. Choose New Code.", "lock", false, true)
      case .open where window.isExpired(at: now):
        self.init("The code expired. Choose New Code.", "clock", false, true)
      case .open:
        let seconds = Int(window.remaining(at: now).rounded(.up))
        self.init(String(format: "Valid for %d:%02d", seconds / 60, seconds % 60), "qrcode", true, false)
      }
    }

    private init(_ text: String, _ symbol: String, _ showsCode: Bool, _ isProblem: Bool) {
      self.text = text
      self.symbol = symbol
      self.showsCode = showsCode
      self.isProblem = isProblem
    }
  }
}

enum QRCode {
  /// A QR code of `text`, drawn with whole pixels per module so it stays sharp.
  static func image(_ text: String, side: CGFloat) -> NSImage? {
    let filter = CIFilter.qrCodeGenerator()
    filter.message = Data(text.utf8)
    filter.correctionLevel = "M"
    guard let output = filter.outputImage else { return nil }
    let scale = max(1, (side / output.extent.width).rounded(.down))
    let scaled = output.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
    guard let image = CIContext().createCGImage(scaled, from: scaled.extent) else { return nil }
    return NSImage(cgImage: image, size: NSSize(width: scaled.extent.width, height: scaled.extent.height))
  }
}

// MARK: - Devices

@MainActor
final class DevicesModel: ObservableObject {
  weak var service: RemoteAccessService?
  var dismiss: (@MainActor () -> Void)?

  init(service: RemoteAccessService) { self.service = service }

  var devices: [DeviceRecord] { (service?.deviceList ?? []).sorted { $0.createdAt < $1.createdAt } }
  var fingerprint: CertificateFingerprint? { service?.fingerprint }
  var canPair: Bool { service?.canPair ?? false }

  func refresh() { objectWillChange.send() }
  func revoke(_ device: DeviceRecord) { service?.revoke(device) }
  func pair() { service?.openPairing() }
}

@MainActor
final class DevicesWindowController: NSObject, NSWindowDelegate {
  private let model: DevicesModel
  private let window: NSWindow
  var onClose: (@MainActor () -> Void)?

  init(service: RemoteAccessService) {
    let model = DevicesModel(service: service)
    self.model = model
    window = makeWindow(title: "Paired Devices", content: DevicesView(model: model))
    super.init()
    model.dismiss = { [weak self] in self?.window.close() }
    window.delegate = self
  }

  func show() {
    model.refresh()
    Dialogs.activate()
    window.makeKeyAndOrderFront(nil)
  }

  func refresh() { model.refresh() }

  func windowWillClose(_ notification: Notification) { onClose?() }
}

private struct DevicesView: View {
  @ObservedObject var model: DevicesModel

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      if model.devices.isEmpty {
        Text("No device is paired with this Mac.")
          .foregroundStyle(.secondary)
          .frame(maxWidth: .infinity, minHeight: 120)
      } else {
        List(model.devices) { device in
          HStack(alignment: .firstTextBaseline) {
            Image(systemName: device.platform == .ipados ? "ipad" : "iphone")
            VStack(alignment: .leading, spacing: 2) {
              Text(device.name).font(.headline)
              Text(Self.detail(device)).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            Button("Revoke…") { model.revoke(device) }
          }
          .padding(.vertical, 2)
        }
        .frame(minHeight: 160)
      }
      Text("""
        A paired device can do everything you can in Hivemind on this Mac, terminals included: \
        it can run commands here as you. Revoke a device you lost at once.
        """)
        .font(.caption).foregroundStyle(.secondary)
        .fixedSize(horizontal: false, vertical: true)
      if let fingerprint = model.fingerprint {
        Text("This Mac’s certificate: \(fingerprint.short)")
          .font(.system(.caption, design: .monospaced)).foregroundStyle(.secondary).textSelection(.enabled)
      }
      HStack {
        Button("Pair a Device…") { model.pair() }.disabled(!model.canPair)
        Spacer()
        Button("Done") { model.dismiss?() }.keyboardShortcut(.defaultAction)
      }
    }
    .padding(20)
    .frame(width: 440)
  }

  static func detail(_ device: DeviceRecord) -> String {
    let platform = device.platform == .ipados ? "iPad" : "iPhone"
    let paired = device.createdAt.formatted(date: .abbreviated, time: .omitted)
    let seen = device.lastSeenAt.map { "last seen " + $0.formatted(.relative(presentation: .named)) } ?? "not seen yet"
    return "\(platform) · paired \(paired) · \(seen)"
  }
}
