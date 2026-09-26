import Foundation

/// What the server app's menu shows for a supervisor state: kept apart from
/// SwiftUI so every state's wording and enabled actions are unit tested.
public struct ServerAppStatus: Equatable, Sendable {
  public enum Kind: Equatable, Sendable { case running, busy, stopped, failed }

  public var kind: Kind
  /// The first, disabled menu line.
  public var title: String
  /// The last error line, when it adds something to the title.
  public var detail: String?
  public var canStart: Bool
  public var canStop: Bool
  public var canRestart: Bool

  /// Menu items are one line; a long stack message would stretch the menu
  /// across the screen. The full text stays in the log.
  public static let maxLineLength = 120

  public init(state: SupervisorState, lastErrorLine: String?, port: ServerPort, unavailable: String? = nil) {
    let error = lastErrorLine.map(Self.clipped)
    if let unavailable {
      self.init(kind: .failed, title: Self.clipped(unavailable), detail: nil,
                canStart: false, canStop: false, canRestart: false)
      return
    }
    switch state {
    case .stopped:
      self.init(kind: .stopped, title: "Stopped", detail: nil, canStart: true, canStop: false, canRestart: false)
    case .starting:
      self.init(kind: .busy, title: "Starting on port \(port)…", detail: nil,
                canStart: false, canStop: true, canRestart: true)
    case .running:
      self.init(kind: .running, title: "Running on port \(port)", detail: nil,
                canStart: false, canStop: true, canRestart: true)
    case .waitingToRestart(let attempt, _):
      self.init(kind: .busy, title: "Crashed, restarting (attempt \(attempt))", detail: error,
                canStart: true, canStop: true, canRestart: false)
    case .stopping:
      self.init(kind: .busy, title: "Stopping…", detail: nil, canStart: false, canStop: false, canRestart: false)
    case .failed(let message):
      // A server line such as "Error: listen EADDRINUSE" already says so.
      let title = Self.clipped(message.lowercased().hasPrefix("error") ? message : "Error: \(message)")
      self.init(kind: .failed, title: title, detail: error == Self.clipped(message) ? nil : error,
                canStart: true, canStop: false, canRestart: false)
    }
  }

  public init(kind: Kind, title: String, detail: String?, canStart: Bool, canStop: Bool, canRestart: Bool) {
    self.kind = kind
    self.title = title
    self.detail = detail
    self.canStart = canStart
    self.canStop = canStop
    self.canRestart = canRestart
  }

  static func clipped(_ text: String) -> String {
    let line = text.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
    return line.count <= maxLineLength ? line : String(line.prefix(maxLineLength - 1)) + "…"
  }
}
