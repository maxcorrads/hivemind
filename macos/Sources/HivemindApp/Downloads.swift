import AppKit
import HivemindKit
import WebKit

/// Saves WKDownloads to ~/Downloads without asking, like Safari's default.
@MainActor
final class Downloads: NSObject, WKDownloadDelegate {
  private var destinations: [ObjectIdentifier: URL] = [:]
  /// WKDownload.delegate is weak and WebKit's own reference ends with the
  /// download; this keeps each one alive until it finishes or fails.
  private var active: [ObjectIdentifier: WKDownload] = [:]

  func adopt(_ download: WKDownload) {
    active[ObjectIdentifier(download)] = download
    download.delegate = self
  }

  func download(
    _ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
    completionHandler: @escaping @MainActor (URL?) -> Void
  ) {
    let fm = FileManager.default
    let directory = fm.urls(for: .downloadsDirectory, in: .userDomainMask).first ?? fm.homeDirectoryForCurrentUser
    let destination = DownloadNaming.destination(in: directory, suggested: suggestedFilename) {
      fm.fileExists(atPath: $0.path)
    }
    destinations[ObjectIdentifier(download)] = destination
    completionHandler(destination)
  }

  func downloadDidFinish(_ download: WKDownload) {
    active[ObjectIdentifier(download)] = nil
    guard let destination = destinations.removeValue(forKey: ObjectIdentifier(download)) else { return }
    // Bounces the Downloads stack in the Dock, as Safari does.
    DistributedNotificationCenter.default().post(name: .init("com.apple.DownloadFileFinished"), object: destination.path)
  }

  func download(_ download: WKDownload, didFailWithError error: any Error, resumeData: Data?) {
    active[ObjectIdentifier(download)] = nil
    destinations[ObjectIdentifier(download)] = nil
    let alert = NSAlert()
    alert.messageText = "The download failed"
    alert.informativeText = error.localizedDescription
    alert.runModal()
  }
}
