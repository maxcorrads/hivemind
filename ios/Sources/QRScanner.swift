import AVFoundation
import HivemindKit
import SwiftUI
import VisionKit

/// Scans the pairing QR code with the camera (VisionKit's data scanner).
/// Only hivemind-pair:// codes end the scan; any other code is ignored, so
/// pointing the camera past another QR code does no harm. Where the scanner
/// is not available (the Simulator, an older device, no camera access) the
/// sheet says so and the pairing screen's paste field remains.
struct QRScannerSheet: View {
  let onCode: (String) -> Void
  @Environment(\.dismiss) private var dismiss
  @Environment(\.openURL) private var openURL
  @State private var access = AVCaptureDevice.authorizationStatus(for: .video)

  var body: some View {
    NavigationStack {
      Group {
        if !DataScannerViewController.isSupported {
          ContentUnavailableView(
            "This device can’t scan codes", systemImage: "camera",
            description: Text("Paste the pairing link instead."))
        } else {
          switch access {
          case .authorized:
            if DataScannerViewController.isAvailable {
              QRScanner(onCode: onCode).ignoresSafeArea()
            } else {
              ContentUnavailableView(
                "The camera is not available", systemImage: "camera",
                description: Text("Paste the pairing link instead."))
            }
          case .notDetermined:
            ProgressView().task {
              let granted = await AVCaptureDevice.requestAccess(for: .video)
              access = granted ? .authorized : .denied
            }
          default:
            ContentUnavailableView {
              Label("Camera access is off", systemImage: "camera")
            } description: {
              Text("Allow Hivemind to use the camera in Settings, or paste the pairing link instead.")
            } actions: {
              Button("Open Settings") {
                if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
              }
            }
          }
        }
      }
      .navigationTitle("Scan the Pairing Code")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
      }
    }
  }
}

private struct QRScanner: UIViewControllerRepresentable {
  let onCode: (String) -> Void

  func makeCoordinator() -> Coordinator { Coordinator(onCode: onCode) }

  func makeUIViewController(context: Context) -> DataScannerViewController {
    let scanner = DataScannerViewController(
      recognizedDataTypes: [.barcode(symbologies: [.qr])],
      qualityLevel: .balanced,
      recognizesMultipleItems: false,
      isHighFrameRateTrackingEnabled: false,
      isHighlightingEnabled: true)
    scanner.delegate = context.coordinator
    try? scanner.startScanning()
    return scanner
  }

  func updateUIViewController(_ scanner: DataScannerViewController, context: Context) {}

  static func dismantleUIViewController(_ scanner: DataScannerViewController, coordinator: Coordinator) {
    scanner.stopScanning()
  }

  @MainActor
  final class Coordinator: NSObject, DataScannerViewControllerDelegate {
    let onCode: (String) -> Void
    private var done = false

    init(onCode: @escaping (String) -> Void) { self.onCode = onCode }

    func dataScanner(_ scanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
      guard !done else { return }
      for item in addedItems {
        guard case .barcode(let barcode) = item, let text = barcode.payloadStringValue,
              text.lowercased().hasPrefix(PairingPayload.scheme + ":") else { continue }
        done = true
        scanner.stopScanning()
        UINotificationFeedbackGenerator().notificationOccurred(.success)
        onCode(text)
        return
      }
    }
  }
}
