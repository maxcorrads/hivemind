import Foundation

/// Finds tmux. Hivemind uses the user's own tmux (from Homebrew) and never
/// installs one: without it the Launch sheet shows "Install tmux: brew
/// install tmux". Apps started by launchd get a bare PATH, so the Homebrew
/// locations are tried first, then PATH.
public struct TmuxLocator: Sendable {
  public static let candidates = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux"]
  public static let installHint = "Install tmux: brew install tmux"

  private let isExecutable: @Sendable (String) -> Bool
  private let path: String?

  /// `isExecutable` is injectable so tests never look at the real disk.
  public init(
    path: String? = ProcessInfo.processInfo.environment["PATH"],
    isExecutable: @escaping @Sendable (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) }
  ) {
    self.path = path
    self.isExecutable = isExecutable
  }

  /// Every place looked at, in order, without duplicates. Relative PATH
  /// entries (".", "bin") are skipped: they depend on the broker's folder.
  public var searchPaths: [String] {
    var seen = Set<String>()
    let fromPath = (path ?? "").split(separator: ":").map(String.init)
      .filter { $0.hasPrefix("/") }
      .map { ($0.hasSuffix("/") ? String($0.dropLast()) : $0) + "/tmux" }
    return (Self.candidates + fromPath).filter { seen.insert($0).inserted }
  }

  /// The first executable tmux, or nil when there is none. Looked up again
  /// on every broker hello, so installing tmux needs no restart.
  public func locate() -> String? {
    searchPaths.first(where: isExecutable)
  }
}
