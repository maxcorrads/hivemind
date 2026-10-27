import Foundation

/// Whether a Claude transcript is open in another process (docs/accounts.md, "Live sessions"). A running Claude keeps
/// `sessions/<pid>.json` in its own config directory, so an account cannot see a session of another one on the same
/// transcripts: the check reads every directory of the launch's shared tree, the tree itself and each of its shadows.
/// Only `pid`, `sessionId`, `procStart`, `pidDomain` and `cwd` are taken from a record, and `sessions/*.key` is never
/// opened. A record is live when its `pidDomain` is `darwin`, `kill(pid, 0)` succeeds and `procStart` is that process's
/// start time (Claude's own guard against a reused pid). Claude does not refuse a second writer by itself.
public struct ClaudeLiveSessions {
  /// What a launch's Claude flags resume.
  public enum Resume: Equatable, Sendable {
    /// `--resume <id>` or `-r <id>`.
    case session(String)
    /// `--continue` or `-c`: the newest transcript of the launch's folder.
    case latest
  }

  /// A config directory to read, named by the label of the account that logs in there.
  public struct Directory: Equatable, Sendable {
    public let path: String
    public let label: String

    public init(path: String, label: String) {
      self.path = path
      self.label = label
    }
  }

  /// The live session that holds what a launch resumes, and the account it runs under.
  public struct Holder: Equatable, Sendable {
    public let sessionID: String
    public let label: String
  }

  /// A record is a few hundred bytes; a larger file is not read past this.
  static let maxRecordBytes = 64 * 1024

  /// The start time of a process as `TZ=UTC LC_ALL=C ps -o lstart= -p <pid>` prints it, or nil when there is none.
  public let processStart: (Int32) -> String?

  public init(processStart: @escaping (Int32) -> String? = ClaudeLiveSessions.systemProcessStart) {
    self.processStart = processStart
  }

  /// What a launch command resumes, or nil for a new session. The command must run Claude (a word `claude` or
  /// `…/claude`). Its options are read up to `--` or the end of that command (`;`, `&`, `|`), in words as the shell
  /// splits them, so a quoted prompt that mentions `-c` is one word. `--resume` with no id opens Claude's picker, and
  /// `--fork-session` starts a new session: neither is checked.
  public static func resumed(in command: String) -> Resume? {
    let words = shellWords(command)
    guard let start = words.firstIndex(where: { $0 == "claude" || $0?.hasSuffix("/claude") == true }) else { return nil }
    let options = words[(start + 1)...].prefix { $0 != nil && $0 != "--" }.compactMap { $0 }
    var resume: Resume?
    for (index, option) in options.enumerated() {
      let next = index + 1 < options.count ? options[index + 1] : nil
      switch option {
      case "--continue", "-c": resume = .latest
      case "--resume", "-r": if let next, !next.hasPrefix("-") { resume = .session(next) }
      case "--fork-session": return nil
      default:
        let value = option.dropFirst("--resume=".count)
        if option.hasPrefix("--resume="), !value.isEmpty { resume = .session(String(value)) }
      }
    }
    return resume
  }

  /// The directories whose live sessions share a launch's transcripts, each with a leading `~/` expanded with `home`:
  /// the shared tree (the Claude account's `homePath`, or ~/.claude; also for a launch without a Claude account), then
  /// every shadow of that tree among the launch's account and `known`. A directory is named by the label of the account
  /// that logs in there, or by its path when none is known.
  public static func directories(for account: LaunchAccount?, known: [LaunchAccount], home: String) -> [Directory] {
    let accounts = ([account].compactMap { $0 } + known).filter { $0.driver == .claude }
    let shared = account.flatMap { $0.driver == .claude ? tree(of: $0, home: home) : nil }
      ?? expandingHome(LaunchAccount.Driver.claude.defaultHome, home: home)
    let primary = accounts.first { $0.shadowPath.isEmpty && tree(of: $0, home: home) == shared }
    var directories = [Directory(path: shared, label: primary?.label ?? shared)]
    for shadow in accounts where !shadow.shadowPath.isEmpty && tree(of: shadow, home: home) == shared {
      let path = expandingHome(shadow.shadowPath, home: home)
      if !directories.contains(where: { $0.path == path }) { directories.append(Directory(path: path, label: shadow.label)) }
    }
    return directories
  }

  /// The directory a Claude account logs in to: its shadow, else its shared tree, with a leading `~/` expanded.
  public static func directory(of account: LaunchAccount, home: String) -> String {
    account.shadowPath.isEmpty ? tree(of: account, home: home) : expandingHome(account.shadowPath, home: home)
  }

  /// The live session in `directories` that holds what `resume` resumes from `cwd`, or nil: a record with that
  /// `sessionId`, or for `--continue` one whose `cwd` is the same folder (compared by realpath). Throws when a
  /// `sessions` folder is there but cannot be read, so the launch is refused rather than run unchecked.
  public func holder(of resume: Resume, cwd: String, in directories: [Directory]) throws -> Holder? {
    let folder = resume == .latest ? Self.canonical(cwd) : nil
    for directory in directories {
      for record in try Self.records(in: directory.path + "/sessions") {
        let held = switch resume {
        case .session(let id): record.sessionID == id
        case .latest: record.cwd.map(Self.canonical) == folder
        }
        if held, isLive(record) { return Holder(sessionID: record.sessionID, label: directory.label) }
      }
    }
    return nil
  }

  /// The start time of `pid` from the kernel (`kinfo_proc`), formatted as `ps -o lstart=` does under TZ=UTC
  /// LC_ALL=C, with single spaces. Nil when there is no such process.
  public static func systemProcessStart(_ pid: Int32) -> String? {
    var info = kinfo_proc()
    var size = MemoryLayout<kinfo_proc>.stride
    var name: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
    guard sysctl(&name, u_int(name.count), &info, &size, nil, 0) == 0, size > 0 else { return nil }
    var seconds = info.kp_proc.p_un.__p_starttime.tv_sec
    var time = tm()
    guard gmtime_r(&seconds, &time) != nil else { return nil }
    let days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    let clock = String(format: "%02d:%02d:%02d", time.tm_hour, time.tm_min, time.tm_sec)
    return "\(days[Int(time.tm_wday)]) \(months[Int(time.tm_mon)]) \(time.tm_mday) \(clock) \(1900 + Int(time.tm_year))"
  }

  /// The five keys of one `sessions/<pid>.json`.
  struct Record {
    let pid: Int32
    let sessionID: String
    let procStart: String?
    let pidDomain: String?
    let cwd: String?
  }

  /// Every `<digits>.json` record in a `sessions` folder that parses; none when the folder is missing. A record that
  /// cannot be read is skipped: Claude removes its file when the process exits.
  static func records(in folder: String) throws -> [Record] {
    guard let stream = opendir(folder) else {
      let code = errno
      if code == ENOENT { return [] }
      throw BrokerProtocolError(.internal, "Cannot check `\(folder)`: \(String(cString: strerror(code)))")
    }
    var names: [String] = []
    while let entry = readdir(stream) {
      var raw = entry.pointee.d_name
      let name = withUnsafeBytes(of: &raw) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
      if name.wholeMatch(of: /[0-9]+\.json/) != nil { names.append(name) }
    }
    closedir(stream)
    return names.compactMap { name in
      guard let handle = FileHandle(forReadingAtPath: folder + "/" + name) else { return nil }
      defer { try? handle.close() }
      guard let data = try? handle.read(upToCount: maxRecordBytes),
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let pid = object["pid"] as? Int, let pid = Int32(exactly: pid), let sessionID = object["sessionId"] as? String
      else { return nil }
      return Record(pid: pid, sessionID: sessionID, procStart: object["procStart"] as? String,
                    pidDomain: object["pidDomain"] as? String, cwd: object["cwd"] as? String)
    }
  }

  /// Claude's own test: a Mac pid (above 1, as Claude asks) that answers signal 0, started when the record says.
  private func isLive(_ record: Record) -> Bool {
    guard record.pidDomain == "darwin", record.pid > 1, let recorded = record.procStart, kill(record.pid, 0) == 0,
          let started = processStart(record.pid) else { return false }
    return Self.squeezed(started) == Self.squeezed(recorded)
  }

  /// `holder(of:cwd:in:)` on a remote host's records (docs/remote-hosts.md#launch), which its perl read with the
  /// folders resolved there and the start time of each record's process when it answers signal 0
  /// (RemoteHostScripts.factsProgram). `cwd` is the launch's folder as the host resolved it.
  public static func holder(of resume: Resume, cwd: String, in directories: [Directory], records: [RemoteFacts.ClaudeRecord]) -> Holder? {
    for (index, directory) in directories.enumerated() {
      for record in records where record.directory == index {
        let held = switch resume {
        case .session(let id): record.sessionId == id
        case .latest: (record.cwdReal ?? record.cwd) == cwd
        }
        guard held, record.pidDomain == "darwin", record.pid > 1, let recorded = record.procStart, let started = record.started,
              squeezed(started) == squeezed(recorded) else { continue }
        return Holder(sessionID: record.sessionId, label: directory.label)
      }
    }
    return nil
  }

  /// `ps` pads the day of the month and the line; Claude keeps the padding.
  static func squeezed(_ text: String) -> String {
    text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
  }

  /// The shared tree a Claude account's transcripts live in: its `homePath`, or ~/.claude.
  private static func tree(of account: LaunchAccount, home: String) -> String {
    expandingHome(account.homePath.isEmpty ? account.driver.defaultHome : account.homePath, home: home)
  }

  /// `path` with its symlinks resolved, so two spellings of one folder compare equal.
  private static func canonical(_ path: String) -> String {
    guard let resolved = realpath(path, nil) else { return path }
    defer { free(resolved) }
    return String(cString: resolved)
  }

  /// `command` in words as the shell splits them: quotes and backslashes removed, expansions left as written. An
  /// unquoted `;`, `&`, `|` or newline ends a command, given as nil.
  static func shellWords(_ command: String) -> [String?] {
    var words: [String?] = []
    var word: String?
    var quote: Character?
    var escaped = false
    for character in command {
      if escaped {
        // Within double quotes a backslash escapes only these; before anything else it stays.
        if quote == "\"", !"$`\"\\\n".contains(character) { word?.append("\\") }
        word?.append(character)
        escaped = false
      } else if character == "\\", quote != "'" {
        escaped = true
        word = word ?? ""
      } else if let open = quote {
        if character == open { quote = nil } else { word?.append(character) }
      } else if character == "'" || character == "\"" {
        quote = character
        word = word ?? ""
      } else if character.isWhitespace || ";&|".contains(character) {
        if let word { words.append(word) }
        word = nil
        if character.isNewline || !character.isWhitespace { words.append(nil) }
      } else {
        word = (word ?? "") + String(character)
      }
    }
    if let word { words.append(word) }
    return words
  }
}
