import Foundation

// Hivemind Server.app's usage probe (docs/accounts.md, "Usage probe"). At start and every 5 minutes it fetches the
// catalog's accounts over the signed launcher channel, reads each account's quota windows, one account at a time, and
// posts the snapshots: a Codex account's from `codex app-server` (CodexUsage), a Claude account's from what its
// status-line tap saved (ClaudeStatusTap) or from Claude's own usage cache (ClaudeUsage). No read costs quota or opens
// a login. It also gives the broker the catalog's Claude accounts, so the live-session check sees a shadow after a
// restart. An error snapshot carries a fixed message, never a command's output or a file's contents.

/// Every key of a window, `resetsAt` and `windowMs` as null when there is none: the server's schema is strict.
extension UsageWindow: Encodable {
  private enum Keys: String, CodingKey { case key, label, usedPercent, resetsAt, windowMs }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: Keys.self)
    try container.encode(key, forKey: .key)
    try container.encode(label, forKey: .label)
    try container.encode(usedPercent, forKey: .usedPercent)
    try container.encode(resetsAt, forKey: .resetsAt)
    try container.encode(windowMs, forKey: .windowMs)
  }
}

/// One usage read of one account, as `POST /api/launcher/usage` takes it (src/shared/accounts.ts, usageSnapshotSchema).
/// Every key is sent, `error` and `limitErrorAt` as null when nil.
public struct UsageSnapshot: Encodable, Equatable, Sendable {
  /// Most windows, and the longest key and label, the schema takes.
  static let maxWindows = 8
  static let maxKeyLength = 64
  static let maxLabelLength = 80

  public let accountId: String
  /// Unix ms: when the windows were true. The server also takes it as the attempt's time.
  public let capturedAt: Int
  public let source: LaunchAccount.Driver
  /// `subscription`, `api-key` or `unknown`.
  public let plan: String
  public let windows: [UsageWindow]
  /// Why the read failed, a fixed message of at most 200 characters; the server then keeps the previous windows.
  public let error: String?
  /// Unix ms of the last `rate_limit` stop the Claude tap saw; nil keeps the server's.
  public let limitErrorAt: Int?

  /// The windows the schema takes: a key or label too long and a repeated key are left out, then the first 8 are kept.
  public init(accountId: String, capturedAt: Int, source: LaunchAccount.Driver, plan: String, windows: [UsageWindow],
              error: String? = nil, limitErrorAt: Int? = nil) {
    var keys = Set<String>()
    let fitting = windows.filter { window in
      window.key.utf16.count <= Self.maxKeyLength && window.label.utf16.count <= Self.maxLabelLength && keys.insert(window.key).inserted
    }
    self.accountId = accountId
    self.capturedAt = capturedAt
    self.source = source
    self.plan = plan
    self.windows = Array(fitting.prefix(Self.maxWindows))
    self.error = error
    self.limitErrorAt = limitErrorAt
  }

  /// A read of `account` that failed with `message`, at `capturedAt`.
  static func failed(_ account: LaunchAccount, _ message: String, at capturedAt: Int, limitErrorAt: Int? = nil) -> Self {
    Self(accountId: account.id, capturedAt: capturedAt, source: account.driver, plan: "unknown", windows: [],
         error: message, limitErrorAt: limitErrorAt)
  }

  private enum Keys: String, CodingKey { case accountId, capturedAt, source, plan, windows, error, limitErrorAt }

  public func encode(to encoder: Encoder) throws {
    var container = encoder.container(keyedBy: Keys.self)
    try container.encode(accountId, forKey: .accountId)
    try container.encode(capturedAt, forKey: .capturedAt)
    try container.encode(source, forKey: .source)
    try container.encode(plan, forKey: .plan)
    try container.encode(windows, forKey: .windows)
    try container.encode(error, forKey: .error)
    try container.encode(limitErrorAt, forKey: .limitErrorAt)
  }
}

/// Runs one `codex app-server` probe: CodexAppServerProbe in the app, a fake in the tests.
@MainActor public protocol CodexProbeRunning {
  /// The stdout lines of `codex app-server` given CodexUsage.probeRequests, with `set` exported and `unset` removed, read
  /// until the replies to requests 2 and 3, the end of its output or the timeout. No lines when it cannot run.
  func probe(set: [(name: String, value: String)], unset: [String]) async -> [String]
}

/// Reads every account's quota windows and posts them to the server this app runs, one round at start and one every
/// `interval` after (docs/accounts.md, "Usage probe").
@MainActor public final class UsageProbeService {
  /// How long after one round the next one starts.
  public static let interval: Duration = .seconds(5 * 60)
  /// The fixed errors of a snapshot; CodexUsageError has the Codex probe's own.
  public static let shadowNotReady = "Shadow not ready: use Prepare in the Accounts sheet"
  public static let noClaudeData = "No recent Claude usage data"
  /// A status line is a few kilobytes and `.claude.json` a few megabytes; a larger file is not read.
  static let maxStatusLineBytes = 1 << 20
  static let maxClaudeJSONBytes = 64 << 20
  /// The most snapshots one post may carry.
  static let maxSnapshotsPerPost = 16

  private struct Accounts: Decodable { let accounts: [LaunchAccount] }
  private struct Usage: Encodable { let snapshots: [UsageSnapshot] }
  /// A Claude source's windows and when they were true, in Unix ms.
  private struct Read { let windows: [UsageWindow]; let capturedAt: Int }

  private let server: @MainActor () -> LauncherService.Server?
  private let http: any LauncherHTTP
  private let codex: any CodexProbeRunning
  private let shadowHomes: any ShadowHomePreparing
  private let tap: ClaudeStatusTap
  private let home: String
  private let now: @Sendable () -> Date
  private let onAccounts: @MainActor ([LaunchAccount]) -> Void
  /// The capture time of each account's last good snapshot the server took, so that a Claude source is news only when
  /// it is newer. Empty after a restart.
  private var lastCapturedAt: [String: Int] = [:]
  private var loop: Task<Void, Never>?
  /// A replacement loop waits for the old one's round to end, so two never probe at once.
  private var draining: Task<Void, Never>?

  /// `tap` is where the broker's Claude tap writes (HivemindPaths.accounts); `home` expands a leading `~/` of an
  /// account's paths. `onAccounts` gets the Claude accounts of each catalog read (TerminalBroker.learnClaudeAccounts).
  public init(server: @escaping @MainActor () -> LauncherService.Server?, http: any LauncherHTTP = URLSessionLauncherHTTP(),
              codex: any CodexProbeRunning, shadowHomes: any ShadowHomePreparing = FileShadowHomes(), tap: ClaudeStatusTap,
              home: String = HivemindPaths.userHome.path,
              now: @escaping @Sendable () -> Date = Date.init,
              onAccounts: @escaping @MainActor ([LaunchAccount]) -> Void = { _ in }) {
    self.server = server; self.http = http; self.codex = codex; self.shadowHomes = shadowHomes; self.tap = tap
    self.home = home; self.now = now; self.onAccounts = onAccounts
  }

  public func start() {
    guard loop == nil, server() != nil else { return }
    let previous = draining
    loop = Task { [weak self] in
      await previous?.value
      guard !Task.isCancelled else { return }
      await self?.run()
    }
  }
  public func stop() {
    loop?.cancel()
    if let loop { draining = loop }
    loop = nil
  }
  public func serverChanged() { stop(); if server() != nil { start() } }

  private func run() async {
    while !Task.isCancelled {
      // Network, proof and post failures are transient: the next round reads every account again.
      try? await refreshOnce()
      try? await Task.sleep(for: Self.interval)
    }
  }

  /// One round: the catalog's accounts, a snapshot of each in catalog order, then the post. Exposed for fake HTTP tests;
  /// a live run uses the same path.
  public func refreshOnce() async throws {
    guard let current = server() else { return }
    guard await verify(current) else { throw BrokerFiles.Failure("usage server verification failed") }
    let (status, data) = try await http.signed(current, method: "GET", path: "/api/launcher/accounts", body: nil,
                                               timeout: 5, now: now())
    guard status == 200 else { throw BrokerFiles.Failure("usage accounts HTTP \(status)") }
    let accounts = try JSONDecoder().decode(Accounts.self, from: data).accounts.filter { (try? $0.validate()) != nil }
    onAccounts(accounts.filter { $0.driver == .claude })
    var snapshots: [UsageSnapshot] = []
    for account in accounts {
      try Task.checkCancellation()
      if let snapshot = await snapshot(of: account) { snapshots.append(snapshot) }
    }
    try Task.checkCancellation()
    guard !snapshots.isEmpty else { return }
    guard server() == current, await verify(current) else { throw BrokerFiles.Failure("usage server changed") }
    for start in stride(from: 0, to: snapshots.count, by: Self.maxSnapshotsPerPost) {
      let batch = Array(snapshots[start..<min(start + Self.maxSnapshotsPerPost, snapshots.count)])
      let body = try JSONEncoder().encode(Usage(snapshots: batch))
      let (posted, _) = try await http.signed(current, method: "POST", path: "/api/launcher/usage", body: body,
                                              timeout: 5, now: now())
      guard posted == 200 else { throw BrokerFiles.Failure("usage post HTTP \(posted)") }
      for snapshot in batch where snapshot.error == nil { lastCapturedAt[snapshot.accountId] = snapshot.capturedAt }
    }
  }

  /// The snapshot of one account: Codex from its probe, Claude from its files; nil when there is nothing to say yet.
  private func snapshot(of account: LaunchAccount) async -> UsageSnapshot? {
    switch account.driver {
    case .codex: await codexSnapshot(account)
    case .claude: claudeSnapshot(account)
    }
  }

  private func verify(_ current: LauncherService.Server) async -> Bool {
    await http.verifies(current) && server() == current
  }

  /// A shadow is prepared as before a launch (links, no new folder, a login required), then `codex app-server` runs
  /// with only the account's variables set and its other controlled names unset, as a launch's are.
  private func codexSnapshot(_ account: LaunchAccount) async -> UsageSnapshot {
    if !account.shadowPath.isEmpty {
      do { try shadowHomes.prepare(account, home: home) } catch {
        return .failed(account, Self.shadowNotReady, at: Self.milliseconds(now()))
      }
    }
    let variables = account.environment(home: home)
    let unset = account.controlledNames.filter { name in !variables.contains { $0.name == name } }
    let lines = await codex.probe(set: variables, unset: unset)
    let capturedAt = Self.milliseconds(now())
    switch CodexUsage.parseCodexProbe(lines: lines) {
    case .success(let probe):
      return UsageSnapshot(accountId: account.id, capturedAt: capturedAt, source: .codex, plan: probe.plan, windows: probe.windows)
    case .failure(let error):
      return .failed(account, error.message, at: capturedAt)
    }
  }

  /// The tap's `statusline.json` when it is newer than the last snapshot; otherwise, and before the first one, the newer
  /// of it and the usage cache in `.claude.json` that is not older than the last snapshot, so a round never goes back in
  /// time. Each read's time is when it was true: the file's modification time, or the cache's `fetchedAtMs`; windows
  /// that have reset since are left out. With no read there is no snapshot: Claude has not reported anything yet, which
  /// is not a failure. Only a `rate_limit` stop the tap saw is still sent then, as noClaudeData with `limitErrorAt`.
  private func claudeSnapshot(_ account: LaunchAccount) -> UsageSnapshot? {
    let date = now(), at = Self.milliseconds(date)
    let limitErrorAt = limitError(of: account)
    let last = lastCapturedAt[account.id]
    let status = statusLine(of: account, now: at)
    var read: Read?
    if let status, let last, status.capturedAt > last {
      read = status
    } else {
      read = [status, usageCache(of: account, now: date)].compactMap { $0 }
        .filter { $0.capturedAt >= last ?? 0 }
        .max { $0.capturedAt < $1.capturedAt }
    }
    let windows = read?.windows.filter { ($0.resetsAt ?? Int.max) > at } ?? []
    guard let read, !windows.isEmpty else {
      return limitErrorAt.map { .failed(account, Self.noClaudeData, at: at, limitErrorAt: $0) }
    }
    // Only a Claude subscription has rate limits, on the status line or in the cache.
    return UsageSnapshot(accountId: account.id, capturedAt: read.capturedAt, source: .claude, plan: "subscription",
                         windows: windows, limitErrorAt: limitErrorAt)
  }

  /// The status line the tap saved for `account`, if it has `rate_limits`, as of its modification time.
  private func statusLine(of account: LaunchAccount, now: Int) -> Read? {
    guard let file = tap.statusLineFile(account.id), let saved = Self.regularFile(file.path, max: Self.maxStatusLineBytes),
          let windows = ClaudeUsage.parseStatusLine(saved.data) else { return nil }
    return Read(windows: windows, capturedAt: max(0, min(saved.modified, now)))
  }

  /// The usage cache of `account`'s `.claude.json`, if it is its login's and at most 8 days old, as of `fetchedAtMs`.
  /// Without CLAUDE_CONFIG_DIR (a primary with no `homePath`) Claude keeps the file in the Mac home, next to `~/.claude`.
  private func usageCache(of account: LaunchAccount, now: Date) -> Read? {
    let file = account.homePath.isEmpty && account.shadowPath.isEmpty
      ? expandingHome("~/.claude.json", home: home)
      : ClaudeLiveSessions.directory(of: account, home: home) + "/.claude.json"
    guard let saved = Self.regularFile(file, max: Self.maxClaudeJSONBytes),
          let cache = ClaudeUsage.readUsageCache(claudeJSON: saved.data, now: now) else { return nil }
    return Read(windows: cache.windows, capturedAt: min(cache.fetchedAtMs, Self.milliseconds(now)))
  }

  /// The tap's `limit-error` of `account`, Unix seconds on one line, in ms.
  private func limitError(of account: LaunchAccount) -> Int? {
    guard let file = tap.limitErrorFile(account.id), let saved = Self.regularFile(file.path, max: 64),
          let seconds = Int(String(decoding: saved.data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)),
          (0...1_000_000_000_000).contains(seconds) else { return nil }
    return seconds * 1000
  }

  /// The bytes and modification time (Unix ms) of a regular file, symlinks followed, of at most `max` bytes.
  private static func regularFile(_ path: String, max: Int) -> (data: Data, modified: Int)? {
    var info = stat()
    guard stat(path, &info) == 0, info.st_mode & S_IFMT == S_IFREG, info.st_size <= max,
          let data = FileManager.default.contents(atPath: path) else { return nil }
    return (data, Int(info.st_mtimespec.tv_sec) * 1000 + Int(info.st_mtimespec.tv_nsec) / 1_000_000)
  }

  private static func milliseconds(_ date: Date) -> Int {
    max(0, Int((date.timeIntervalSince1970 * 1000).rounded()))
  }
}

// Foundation.Process does not exist on iOS, which never probes.
#if os(macOS)
/// `codex app-server` as a session finds it: the login shell the sessions run (TmuxCommand.shell `-lic`, so ~/.zshrc's
/// PATH applies) sets the account's variables and unsets the other names after its startup files, as a launch's script
/// does, then execs codex in the home folder. Stdin carries CodexUsage.probeRequests and stays open until the replies to
/// requests 2 and 3 arrive, in either order, or `timeout` passes; then it is closed, and codex is ended if it has not
/// exited 2 s later. stderr is discarded, and stdout goes only to the parser.
public struct CodexAppServerProbe: CodexProbeRunning {
  nonisolated public static let timeout: TimeInterval = 20
  /// How long codex has to exit once its stdin is closed, and again after SIGTERM.
  nonisolated static let exitGrace: TimeInterval = 2
  /// The rate-limit reply is a few kilobytes; output past this is not read.
  nonisolated static let maxOutputBytes = 1 << 20
  nonisolated static let maxLineBytes = 256 << 10

  /// The shell and its flags, before the script.
  public let shell: [String]
  /// The command the script execs.
  public let codex: String
  /// The environment the shell starts with (the broker's, without TMUX and with Homebrew on PATH).
  public let environment: [String: String]
  public let directory: String
  public let timeout: TimeInterval

  public init(shell: [String] = [TmuxCommand.shell, "-lic"], codex: String = "codex",
              environment: [String: String] = BrokerEnvironment.tmux(from: ProcessInfo.processInfo.environment),
              directory: String = FileManager.default.homeDirectoryForCurrentUser.path, timeout: TimeInterval = Self.timeout) {
    self.shell = shell; self.codex = codex; self.environment = environment; self.directory = directory; self.timeout = timeout
  }

  /// `builtin`, because ~/.zshrc's aliases and functions apply in this shell; values and the command single-quoted, so
  /// nothing in them is expanded and no alias replaces codex.
  public static func script(codex: String, set: [(name: String, value: String)], unset: [String]) -> String {
    let exports = set.map { "builtin export \($0.name)=\(TerminalScript.shellQuoted($0.value))\n" }.joined()
    let unsets = unset.isEmpty ? "" : "builtin unset -v \(unset.joined(separator: " "))\n"
    return exports + unsets + "exec \(TerminalScript.shellQuoted(codex)) app-server"
  }

  public func probe(set: [(name: String, value: String)], unset: [String]) async -> [String] {
    var environment = environment
    for name in unset { environment[name] = nil }
    for variable in set { environment[variable.name] = variable.value }
    let arguments = Array(shell.dropFirst()) + [Self.script(codex: codex, set: set, unset: unset)]
    let (executable, directory, timeout) = (shell[0], directory, timeout)
    return await withCheckedContinuation { [environment] continuation in
      DispatchQueue.global(qos: .utility).async {
        continuation.resume(returning: Self.run(executable: executable, arguments: arguments, environment: environment,
                                                directory: directory, timeout: timeout))
      }
    }
  }

  nonisolated private static func run(executable: String, arguments: [String], environment: [String: String],
                                      directory: String, timeout: TimeInterval) -> [String] {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executable)
    process.arguments = arguments
    process.environment = environment
    process.currentDirectoryURL = URL(fileURLWithPath: directory)
    let input = Pipe(), output = Pipe()
    process.standardInput = input
    process.standardOutput = output
    process.standardError = FileHandle.nullDevice
    let exited = DispatchSemaphore(value: 0)
    process.terminationHandler = { _ in exited.signal() }
    do { try process.run() } catch { return [] }
    let writer = input.fileHandleForWriting.fileDescriptor
    // A codex that exits before reading gets EPIPE here, not the app a SIGPIPE.
    _ = fcntl(writer, F_SETNOSIGPIPE, 1)
    let requests = Array((CodexUsage.probeRequests.joined(separator: "\n") + "\n").utf8)
    // A few hundred bytes: the pipe holds them all, so this never waits on codex.
    _ = requests.withUnsafeBytes { Darwin.write(writer, $0.baseAddress, $0.count) }
    let lines = readReplies(output.fileHandleForReading.fileDescriptor, until: Date().addingTimeInterval(timeout))
    try? input.fileHandleForWriting.close()
    if exited.wait(timeout: .now() + exitGrace) == .timedOut {
      process.terminate()
      if exited.wait(timeout: .now() + exitGrace) == .timedOut {
        Darwin.kill(process.processIdentifier, SIGKILL)
        _ = exited.wait(timeout: .now() + exitGrace)
      }
    }
    try? output.fileHandleForReading.close()
    return lines
  }

  /// The lines on `fd` until the replies to requests 2 and 3, the end of the output, `maxOutputBytes` or `deadline`.
  nonisolated private static func readReplies(_ fd: Int32, until deadline: Date) -> [String] {
    var splitter = LineSplitter(maxLineBytes: maxLineBytes)
    var lines: [String] = []
    var awaiting = CodexUsage.awaitedReplyIds
    var total = 0
    var buffer = [UInt8](repeating: 0, count: 64 * 1024)
    while total < maxOutputBytes {
      let remaining = deadline.timeIntervalSinceNow
      guard remaining > 0 else { break }
      var descriptor = pollfd(fd: fd, events: Int16(POLLIN), revents: 0)
      let ready = poll(&descriptor, 1, Int32((remaining * 1000).rounded(.up)))
      if ready < 0 && errno == EINTR { continue }
      guard ready > 0 else { break }
      let count = buffer.withUnsafeMutableBytes { Darwin.read(fd, $0.baseAddress, $0.count) }
      if count < 0 && errno == EINTR { continue }
      guard count > 0 else {
        lines += splitter.finish()
        break
      }
      total += count
      let new = splitter.append(Data(buffer[0..<count]))
      lines += new
      for line in new { if let id = CodexUsage.replyId(line) { awaiting.remove(id) } }
      if awaiting.isEmpty { break }
    }
    return lines
  }
}
#endif
