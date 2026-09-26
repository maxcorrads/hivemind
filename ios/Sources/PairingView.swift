import HivemindKit
import SwiftUI
import UIKit

/// Pairing with a Mac (docs/remote-access.md#pairing): read the pairing
/// link from the QR code Hivemind Server shows (or paste it), check the Mac
/// and its fingerprint, name this device, pair. Macs Bonjour finds nearby
/// are listed as a hint only: pairing always needs the code, since anyone
/// on the network can advertise.
struct PairingView: View {
  @Environment(AppModel.self) private var model
  let onPaired: (PairedMac) -> Void
  /// Nil when pairing is the only thing the app can show (no Mac yet).
  let onCancel: (() -> Void)?

  @State private var link = ""
  @State private var payload: PairingPayload?
  @State private var deviceName = UIDevice.current.name
  @State private var problem: String?
  @State private var scanning = false
  @State private var pairing = false

  var body: some View {
    NavigationStack {
      Form {
        if let payload {
          confirm(payload)
        } else {
          start
        }
        if let problem {
          Section {
            Label(problem, systemImage: "exclamationmark.triangle")
              .foregroundStyle(.red)
          }
        }
      }
      .navigationTitle(payload == nil ? "Pair with a Mac" : "Pair with \(payload!.name)")
      .toolbar {
        if let onCancel {
          ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: onCancel) }
        }
      }
      .fullScreenCover(isPresented: $scanning) {
        QRScannerSheet { code in
          scanning = false
          read(code)
        }
      }
      .disabled(pairing)
    }
  }

  @ViewBuilder private var start: some View {
    Section {
      Button("Scan the Pairing Code", systemImage: "qrcode.viewfinder") { scanning = true }
    } footer: {
      Text("On your Mac, open Hivemind Server’s menu, turn on Remote Access, then choose Pair a Device…")
    }
    Section {
      TextField("hivemind-pair://…", text: $link, axis: .vertical)
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
        .font(.body.monospaced())
        .lineLimit(1...4)
      HStack {
        PasteButton(payloadType: String.self) { strings in
          guard let text = strings.first else { return }
          Task { @MainActor in read(text) }
        }
        Spacer()
        Button("Continue") { read(link) }
          .disabled(link.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
    } header: {
      Text("Or paste the pairing link")
    } footer: {
      Text("For when the camera can’t read the code: the link holds the same pairing code, and the same care applies. Anyone with it can pair while it is valid.")
    }
    if !model.discovery.nearby.isEmpty {
      Section {
        ForEach(model.discovery.nearby) { mac in
          VStack(alignment: .leading, spacing: 2) {
            HStack {
              Text(mac.name)
              if model.macs.contains(where: { $0.isAdvertised(by: mac.advertisement) }) {
                Text("Paired").font(.caption).foregroundStyle(.secondary)
              }
            }
            Text(mac.advertisement.fingerprint.short)
              .font(.caption.monospaced())
              .foregroundStyle(.secondary)
          }
        }
      } header: {
        Text("Macs nearby with Remote Access on")
      } footer: {
        Text("To pair, choose Pair a Device… on that Mac and scan its code.")
      }
    }
  }

  @ViewBuilder private func confirm(_ payload: PairingPayload) -> some View {
    Section {
      LabeledContent("Mac", value: payload.name)
      LabeledContent("Address", value: payload.endpoints.first?.description ?? "")
      LabeledContent("Fingerprint") {
        Text(payload.fingerprint.short).font(.body.monospaced())
      }
    } footer: {
      Text("Check that the Mac’s pairing window shows the same fingerprint.")
    }
    Section {
      TextField("Name", text: $deviceName)
        .textInputAutocapitalization(.words)
    } header: {
      Text("This device’s name")
    } footer: {
      Text("The Mac lists this device under this name in Devices…")
    }
    Section {
      Button {
        pair(payload)
      } label: {
        HStack {
          Text("Pair")
          if pairing { Spacer(); ProgressView() }
        }
      }
      .disabled(DeviceName.validate(deviceName) == nil)
      Button("Use Another Code", role: .cancel) {
        self.payload = nil
        problem = nil
      }
    } footer: {
      Text("A paired device can do everything you can do in Hivemind on the Mac, including running commands in terminals. Pair only devices you own.")
    }
  }

  private func read(_ text: String) {
    do {
      payload = try PairingPayload(link: text)
      link = ""
      problem = nil
    } catch {
      problem = error.errorDescription
    }
  }

  private func pair(_ payload: PairingPayload) {
    pairing = true
    problem = nil
    Task {
      defer { pairing = false }
      do throws(RemoteClientError) {
        let mac = try await model.pair(payload, deviceName: deviceName)
        onPaired(mac)
      } catch {
        problem = Self.message(error)
      }
    }
  }

  static func message(_ error: RemoteClientError) -> String {
    switch error {
    case .unreachable:
      "The Mac did not answer. Make sure this device is on the same network or VPN as the Mac, and that Remote Access is on."
    case .pinMismatch:
      "The Mac answered with a different certificate than the code shows. Show a new code on the Mac and scan it again."
    case .gateway(let error) where error.code == .invalidCode || error.code == .pairingClosed:
      "This code was used already or has expired. Choose Pair a Device… on the Mac again and scan the new code."
    case .gateway(let error) where error.code == .pairingLocked:
      "Pairing is locked after too many wrong codes. Choose Pair a Device… on the Mac again."
    default:
      error.errorDescription ?? "Pairing failed."
    }
  }
}
