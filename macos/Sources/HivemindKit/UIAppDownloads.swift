import Foundation

/// Where a WKDownload lands. The suggested name comes from the server or a
/// page's `download` attribute, so it is reduced to a plain file name.
public enum DownloadNaming {
  public static func sanitized(_ suggested: String) -> String {
    let forbidden = CharacterSet(charactersIn: "/:\\").union(.controlCharacters)
    var name = String(String.UnicodeScalarView(suggested.unicodeScalars.map { forbidden.contains($0) ? "_" : $0 }))
      .trimmingCharacters(in: .whitespaces)
    // No hidden files and no "..".
    while name.hasPrefix(".") { name.removeFirst() }
    if name.utf8.count > 200 { name = String(name.prefix(200)) }
    return name.isEmpty ? "download" : name
  }

  /// `directory/name`, or `name 2.ext`, `name 3.ext`… when taken, like Safari.
  public static func destination(in directory: URL, suggested: String, exists: (URL) -> Bool) -> URL {
    let name = sanitized(suggested)
    let candidate = directory.appendingPathComponent(name)
    guard exists(candidate) else { return candidate }
    let ext = (name as NSString).pathExtension
    let stem = ext.isEmpty ? name : (name as NSString).deletingPathExtension
    for n in 2...9999 {
      let next = directory.appendingPathComponent(ext.isEmpty ? "\(stem) \(n)" : "\(stem) \(n).\(ext)")
      if !exists(next) { return next }
    }
    return directory.appendingPathComponent("\(UUID().uuidString)-\(name)")
  }
}
