import Foundation

/// The WKScriptMessageHandler name web/native-bridge.ts posts to
/// (window.webkit.messageHandlers.hivemind).
public let bridgeHandlerName = "hivemind"

/// The DOM event native commands arrive as (`CustomEvent` with detail).
public let bridgeEventName = "hivemind:native"

/// The DOM event terminal events arrive as (`CustomEvent` with detail
/// {type, …}); see BridgeTerminalEvent.
public let bridgeTerminalEventName = "hivemind:terminal"

/// Web → native. Parsed from the WKScriptMessage body (a JSON-like
/// dictionary); anything malformed is dropped, never trusted partially.
public enum BridgeMessage: Equatable, Sendable {
  case ready
  /// `target` is the hash route the notice opens ("#" + hashFor(notice.target)).
  case notify(title: String, body: String, tag: String?, target: String?)
  case badge(count: Int)

  // Terminals (docs/terminal-broker.md#bridge). The app relays each to the
  // broker; `id` is the page's own request id, echoed on the answer.

  /// Start (or reuse) one tmux session per launch; answered with
  /// terminal-launched. `openInTerminal`: then open a Terminal.app window
  /// attached to each session.
  case terminalLaunch(id: String?, launches: [TerminalSessionLaunch], openInTerminal: Bool)
  /// Open a Terminal.app window attached to a running session.
  case terminalOpen(session: SessionName)
  /// Attach an in-page terminal; answered with terminal-attached (or terminal-error).
  case terminalAttach(id: String?, session: SessionName, size: TerminalSize)
  case terminalInput(stream: BrokerStreamID, data: Data)
  case terminalResize(stream: BrokerStreamID, size: TerminalSize)
  case terminalDetach(stream: BrokerStreamID)
  /// The page drew `bytes` (decoded) of a stream's terminal-output; the app
  /// stops reading the broker while too much is not acked (TerminalOutputFlow).
  case terminalAck(stream: BrokerStreamID, bytes: Int)
  /// Kill a session (after the page's confirm modal); answered with terminal-killed.
  case terminalKill(id: String?, session: SessionName)
  /// terminal-status and sessions now, then sessions on every change.
  case sessionsSubscribe
  case sessionsUnsubscribe

  static let maxText = 4096

  public init?(body: Any) {
    guard let object = body as? [String: Any], let type = object["type"] as? String else { return nil }
    switch type {
    case "ready":
      self = .ready
    case "notify":
      guard let title = Self.text(object["title"]), !title.isEmpty else { return nil }
      self = .notify(
        title: title,
        body: Self.text(object["body"]) ?? "",
        tag: Self.text(object["tag"]).flatMap { $0.isEmpty ? nil : $0 },
        target: Self.text(object["target"]).flatMap(BridgeCommand.validHash))
    case "badge":
      // WebKit hands JS numbers over as NSNumber; a Bool is an NSNumber too.
      guard let number = object["count"] as? NSNumber,
            CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
      let value = number.doubleValue
      guard value.isFinite, value >= 0, value == value.rounded() else { return nil }
      self = .badge(count: Int(min(value, Double(Int32.max))))
    case "terminal-launch":
      guard let id = Self.requestID(object["id"]),
            let launches = TerminalSessionLaunch.list(object["launches"]),
            let open = object["openInTerminal"] as? NSNumber, CFGetTypeID(open) == CFBooleanGetTypeID() else { return nil }
      self = .terminalLaunch(id: id, launches: launches, openInTerminal: open.boolValue)
    case "terminal-open":
      guard let session = Self.session(object["session"]) else { return nil }
      self = .terminalOpen(session: session)
    case "terminal-attach":
      guard let id = Self.requestID(object["id"]), let session = Self.session(object["session"]),
            let size = Self.size(object) else { return nil }
      self = .terminalAttach(id: id, session: session, size: size)
    case "terminal-input":
      guard let stream = Self.stream(object["stream"]), let encoded = object["data"] as? String,
            encoded.utf8.count <= (BrokerLimits.maxInputBytes / 3 + 1) * 4,
            let data = Data(base64Encoded: encoded), !data.isEmpty, data.count <= BrokerLimits.maxInputBytes else { return nil }
      self = .terminalInput(stream: stream, data: data)
    case "terminal-resize":
      guard let stream = Self.stream(object["stream"]), let size = Self.size(object) else { return nil }
      self = .terminalResize(stream: stream, size: size)
    case "terminal-detach":
      guard let stream = Self.stream(object["stream"]) else { return nil }
      self = .terminalDetach(stream: stream)
    case "terminal-ack":
      guard let stream = Self.stream(object["stream"]), let bytes = Self.integer(object["bytes"]), bytes >= 1 else { return nil }
      self = .terminalAck(stream: stream, bytes: bytes)
    case "terminal-kill":
      guard let id = Self.requestID(object["id"]), let session = Self.session(object["session"]) else { return nil }
      self = .terminalKill(id: id, session: session)
    case "sessions-subscribe":
      self = .sessionsSubscribe
    case "sessions-unsubscribe":
      self = .sessionsUnsubscribe
    default:
      return nil
    }
  }

  private static func text(_ value: Any?) -> String? {
    guard let string = value as? String else { return nil }
    return string.count > maxText ? String(string.prefix(maxText)) : string
  }

  /// A JS integer (NSNumber, not a Bool, no fraction), or nil.
  static func integer(_ value: Any?) -> Int? {
    guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
    let double = number.doubleValue
    guard double.isFinite, double == double.rounded(), abs(double) <= Double(Int32.max) else { return nil }
    return Int(double)
  }

  private static func stream(_ value: Any?) -> BrokerStreamID? {
    guard let stream = integer(value), stream >= 1 else { return nil }
    return stream
  }

  private static func session(_ value: Any?) -> SessionName? {
    (value as? String).flatMap(SessionName.init)
  }

  private static func size(_ object: [String: Any]) -> TerminalSize? {
    guard let columns = integer(object["cols"]), let rows = integer(object["rows"]) else { return nil }
    return TerminalSize(columns: columns, rows: rows)
  }

  /// Missing or null: `.some(nil)`, no id. A bad id: nil, which drops the message.
  private static func requestID(_ value: Any?) -> String?? {
    switch value {
    case nil, is NSNull: return .some(nil)
    case let id as String:
      guard (1...BrokerLimits.maxRequestIDCharacters).contains(id.count), !BrokerText.hasControlCharacters(id) else { return nil }
      return .some(id)
    default: return nil
    }
  }
}

/// One session the Launch agent sheet asks for, in a terminal-launch message.
/// Checked as the broker checks a launch (BrokerLaunch), except that the page
/// may send "~" / "~/…" or no folder, which the app resolves.
public struct TerminalSessionLaunch: Equatable, Sendable {
  public let project: String
  public let agent: String?
  public let title: String
  /// Absolute, or "~" / "~/…". Nil: the home folder.
  public let cwd: String?
  public let command: String
  /// The agent's last reported session, reused when it still runs (BrokerLaunch.session).
  public let session: SessionName?

  public init?(project: String, agent: String?, title: String, cwd: String?, command: String, session: SessionName? = nil) {
    // Validate with the home folder standing in for "~" and a missing folder.
    guard Self.launch(project: project, agent: agent, title: title, cwd: cwd, command: command, session: session, home: "/") != nil else { return nil }
    if let cwd {
      guard cwd.hasPrefix("/") || cwd == "~" || cwd.hasPrefix("~/"), cwd.utf8.count <= BrokerLimits.maxCwdBytes else { return nil }
    }
    self.project = project
    self.agent = agent
    self.title = title
    self.cwd = cwd
    self.command = command
    self.session = session
  }

  init?(body: Any) {
    guard let object = body as? [String: Any],
          let project = object["project"] as? String,
          let title = object["title"] as? String,
          let command = object["command"] as? String else { return nil }
    let agent: String?
    switch object["agent"] {
    case nil, is NSNull: agent = nil
    case let name as String: agent = name
    default: return nil
    }
    let cwd: String?
    switch object["cwd"] {
    case nil, is NSNull: cwd = nil
    case let path as String: cwd = path
    default: return nil
    }
    let session: SessionName?
    switch object["session"] {
    case nil, is NSNull: session = nil
    case let name as String:
      guard let valid = SessionName(name) else { return nil }
      session = valid
    default: return nil
    }
    self.init(project: project, agent: agent, title: title, cwd: cwd, command: command, session: session)
  }

  /// All launches of a message, or nil when the list or any one is invalid.
  static func list(_ value: Any?) -> [TerminalSessionLaunch]? {
    guard let items = value as? [Any], (1...BrokerLimits.maxLaunches).contains(items.count) else { return nil }
    var launches: [TerminalSessionLaunch] = []
    for item in items {
      guard let launch = TerminalSessionLaunch(body: item) else { return nil }
      launches.append(launch)
    }
    return launches
  }

  /// The broker's launch: "~" expanded against `home`, no folder meaning
  /// `home`. Nil only when the expanded folder breaks the broker's limits.
  public func brokerLaunch(home: String) -> BrokerLaunch? {
    Self.launch(project: project, agent: agent, title: title, cwd: cwd, command: command, session: session, home: home)
  }

  private static func launch(
    project: String, agent: String?, title: String, cwd: String?, command: String, session: SessionName?, home: String
  ) -> BrokerLaunch? {
    let base = home.hasSuffix("/") && home.count > 1 ? String(home.dropLast()) : home
    let folder: String
    switch cwd {
    case nil, "~": folder = base
    case let path? where path.hasPrefix("~/"): folder = (base == "/" ? "" : base) + path.dropFirst()
    case let path?: folder = path
    }
    return try? BrokerLaunch(project: project, agent: agent, title: title, cwd: folder, command: command, session: session)
  }
}

/// Native → web terminal events, delivered like BridgeCommand by evaluating
/// `javaScript`, as a "hivemind:terminal" CustomEvent whose detail is
/// {type, …}. Binary data is base64.
public enum BridgeTerminalEvent: Equatable, Sendable {
  /// Whether terminals can work at all. Sent on sessions-subscribe and on
  /// every change. `broker` unavailable: the page shows "Start Hivemind
  /// Server to use terminals" with hivemind-server://start; `unverified`:
  /// terminals are off for this window (TerminalTrustGate).
  case status(tmux: TmuxStatus, broker: BrokerStatus)
  case sessions([BrokerSession])
  case launched(id: String?, names: [SessionName?], created: [SessionName], errors: [BrokerLaunchFailure])
  case attached(id: String?, stream: BrokerStreamID, session: SessionName)
  case output(stream: BrokerStreamID, data: Data)
  case exit(stream: BrokerStreamID, status: Int?)
  case killed(id: String?, session: SessionName)
  case error(id: String?, code: BrokerErrorCode, message: String, stream: BrokerStreamID?)

  public enum TmuxStatus: String, Sendable, Equatable {
    case available
    /// "Install tmux: brew install tmux"; launch buttons are disabled.
    case missing
    /// Not known while the broker is unreachable.
    case unknown
  }

  public enum BrokerStatus: String, Sendable, Equatable {
    case connected
    case connecting
    case unavailable
    /// The window's server could not be verified, so it was opened without
    /// terminals (TerminalTrustGate): the page says so and offers nothing.
    case unverified
  }

  public var type: String {
    switch self {
    case .status: "terminal-status"
    case .sessions: "sessions"
    case .launched: "terminal-launched"
    case .attached: "terminal-attached"
    case .output: "terminal-output"
    case .exit: "terminal-exit"
    case .killed: "terminal-killed"
    case .error: "terminal-error"
    }
  }

  /// The page's event for a broker event, with the page's request id. Nil
  /// for welcome, which becomes a status once the app knows the broker's tmux.
  public init?(_ frame: BrokerEventFrame, id: String? = nil) {
    switch frame.event {
    case .welcome: return nil
    case .sessions(let items): self = .sessions(items)
    case .launched(let names, let created, let errors): self = .launched(id: id, names: names, created: created, errors: errors)
    case .attached(let stream, let session): self = .attached(id: id, stream: stream, session: session)
    case .output(let stream, let data): self = .output(stream: stream, data: data)
    case .exit(let stream, let status): self = .exit(stream: stream, status: status)
    case .killed(let session): self = .killed(id: id, session: session)
    case .error(let code, let message, let stream): self = .error(id: id, code: code, message: message, stream: stream)
    }
  }

  /// The JSON detail, keys sorted.
  public var detail: [String: Any] {
    var detail: [String: Any] = ["type": type]
    func put(_ key: String, _ value: Any?) { detail[key] = value ?? NSNull() }
    switch self {
    case .status(let tmux, let broker):
      detail["tmux"] = tmux.rawValue
      detail["broker"] = broker.rawValue
    case .sessions(let items):
      detail["items"] = items.map { item -> [String: Any] in
        ["name": item.name.rawValue, "project": item.project ?? NSNull(), "agent": item.agent ?? NSNull(),
         "alive": item.alive, "attached": item.attached, "createdAt": item.createdAt]
      }
    case .launched(let id, let names, let created, let errors):
      put("id", id)
      detail["names"] = names.map { $0?.rawValue ?? NSNull() as Any }
      detail["created"] = created.map(\.rawValue)
      detail["errors"] = errors.map { ["index": $0.index, "code": $0.code.rawValue, "message": $0.message] as [String: Any] }
    case .attached(let id, let stream, let session):
      put("id", id)
      detail["stream"] = stream
      detail["session"] = session.rawValue
    case .output(let stream, let data):
      detail["stream"] = stream
      detail["data"] = data.base64EncodedString()
    case .exit(let stream, let status):
      detail["stream"] = stream
      put("status", status)
    case .killed(let id, let session):
      put("id", id)
      detail["session"] = session.rawValue
    case .error(let id, let code, let message, let stream):
      put("id", id)
      detail["code"] = code.rawValue
      detail["message"] = message
      put("stream", stream)
    }
    return detail
  }

  public var javaScript: String {
    BridgeScript.dispatch(event: bridgeTerminalEventName, detail: detail)
  }
}

/// window.dispatchEvent(new CustomEvent(<event>, {detail})) with the detail
/// as JSON, so no value is ever spliced into script text raw.
enum BridgeScript {
  static func dispatch(event: String, detail: [String: Any]) -> String {
    let data = (try? JSONSerialization.data(withJSONObject: detail, options: [.sortedKeys])) ?? Data("{}".utf8)
    // JSON is valid JS except for U+2028/U+2029 in older engines; escape them anyway.
    let json = String(decoding: data, as: UTF8.self)
      .replacingOccurrences(of: "\u{2028}", with: "\\u2028")
      .replacingOccurrences(of: "\u{2029}", with: "\\u2029")
    return "window.dispatchEvent(new CustomEvent(\(quoted(event)), {detail: \(json)}));"
  }

  static func quoted(_ value: String) -> String {
    let data = (try? JSONSerialization.data(withJSONObject: [value], options: [])) ?? Data("[\"\"]".utf8)
    return String(String(decoding: data, as: UTF8.self).dropFirst().dropLast())
  }
}

/// NSApp.dockTile.badgeLabel for an attention total: nothing at zero.
public func dockBadgeLabel(count: Int) -> String? {
  count > 0 ? String(count) : nil
}

/// Native → web commands, delivered by evaluating `javaScript` in the page.
public enum BridgeCommand: Equatable, Sendable {
  case jump
  case forYou
  case newChannel
  case settings
  case toggleTheme
  /// Go to an in-app hash route ("#/…").
  case navigate(hash: String)

  public var name: String {
    switch self {
    case .jump: "jump"
    case .forYou: "for-you"
    case .newChannel: "new-channel"
    case .settings: "settings"
    case .toggleTheme: "toggle-theme"
    case .navigate: "navigate"
    }
  }

  /// A hash route the app may navigate to, normalized to start with "#"
  /// (web/selection.ts hashFor returns it without). Whitespace or control
  /// characters drop it rather than being escaped.
  public static func validHash(_ raw: String) -> String? {
    let value = raw.hasPrefix("#") ? raw : "#" + raw
    guard value.count > 1, value.count <= 2048,
          !value.unicodeScalars.contains(where: { CharacterSet.whitespacesAndNewlines.contains($0) || CharacterSet.controlCharacters.contains($0) })
    else { return nil }
    return value
  }

  /// window.dispatchEvent(new CustomEvent("hivemind:native", {detail})) with
  /// the detail as JSON, so no value is ever spliced into script text raw.
  public var javaScript: String {
    var detail: [String: String] = ["command": name]
    if case .navigate(let hash) = self { detail["hash"] = hash }
    return BridgeScript.dispatch(event: bridgeEventName, detail: detail)
  }
}
