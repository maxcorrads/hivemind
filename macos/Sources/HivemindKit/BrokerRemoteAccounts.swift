import Foundation

// The broker's accounts on remote hosts (docs/remote-hosts.md#accounts): the Accounts sheet's Prepare on a host, the
// same-account check of a launch there, and Find last conversations on a host. RemoteAccountScripts builds what runs on
// the host. With no host (`deps.remoteHosts` nil) none of this runs, and Prepare and launches are as before hosts.

extension TerminalBroker {
  // MARK: Prepare

  /// The Accounts sheet's Prepare on host `id`: the account's directories there get this Mac's configuration (what the
  /// host lacks), a shadow its folder and links, then its login there is checked against this Mac's. The answer is
  /// Prepare's: not logged in there (the sheet shows the command to run there), ready, or what is wrong.
  func prepareOnHost(_ account: LaunchAccount, host id: String) async -> AccountPreparation {
    func failed(_ message: String) -> AccountPreparation { AccountPreparation(loggedIn: false, error: message) }
    guard let remoteHosts = deps.remoteHosts, let host = remoteHosts.brokerHosts.first(where: { $0.id == id }) else {
      return failed("That host is not configured in Hivemind Server")
    }
    guard host.ready, let folder = host.runtimeFolder else { return failed("\(host.label) is offline") }
    var listed = remoteListings[host.id]?.probe
    if listed == nil { listed = await probe(host) }
    guard let home = listed?.home else { return failed("Cannot reach \(host.label)") }

    // 1. This Mac's configuration, each directory of the account in turn: the shared tree before a Claude shadow.
    for directory in Self.configDirectories(of: account) {
      let local = expandingHome(directory, home: deps.home), remote = expandingHome(directory, home: home)
      let entries = RemoteAccountScripts.configEntries(account.driver, in: local)
      let block = account.driver == .codex && directory == Self.homeDirectory(of: account)
        ? RemoteAccountScripts.codexMcpBlock(runtimeFolder: folder) : nil
      let script = RemoteAccountScripts.setup(target: remote, entries: entries, macHome: deps.home, codexBlock: block)
      let ran = entries.isEmpty
        ? await remoteHosts.run(onHost: host.id, script: script, stdin: Data(), timeout: RemoteAccountScripts.setupTimeout)
        : await remoteHosts.run(onHost: host.id, script: script, input: RemoteAccountScripts.archiveSpec(directory: local, entries: entries),
                                timeout: RemoteAccountScripts.setupTimeout)
      // The script's own refusal first: one that stops before reading the archive (a symlinked target, say) leaves
      // `tar` here with no reader, and the runner then reports the archive, not why.
      if let error = RemoteAccountScripts.parseSetup(ran.stdout)?.error { return failed("\(host.label): \(error)") }
      guard ran.succeeded, let result = RemoteAccountScripts.parseSetup(ran.stdout) else {
        return failed("\(host.label): \(ran.reason ?? "the setup did not answer")")
      }
      deps.log("[broker] account \(account.id) on \(host.label): \(remote) copied \(result.copied), kept \(result.kept)"
               + (result.mcpWritten == true ? ", MCP block written" : ""))
    }

    // 2. A shadow's folder and links, by the same steps as here, on the host's files; and its login there.
    var request = RemoteFactsRequest(cwd: home, login: .init(AccountLogin(account, home: home), driver: account.driver))
    if !account.shadowPath.isEmpty {
      request.shadow = .init(home: expandingHome(Self.homeDirectory(of: account), home: home),
                             shadow: expandingHome(account.shadowPath, home: home), driver: account.driver.rawValue)
    }
    let facts: RemoteFacts
    switch await hostFacts(host, request: request) {
    case .failure(let error): return failed(error.message)
    case .success(let read): facts = read
    }
    if !account.shadowPath.isEmpty {
      let files = SnapshotShadowFiles(facts.shadow ?? ShadowFacts(paths: [:]))
      do { try deps.shadowHomes.prepareForLogin(account, home: home, files: files) } catch {
        return failed(error.localizedDescription)
      }
      if !files.actions.isEmpty {
        let applied = await remoteHosts.run(onHost: host.id, script: RemoteAccountScripts.applyShadow(files.actions), stdin: Data(),
                                            timeout: RemoteHostScripts.stepTimeout)
        if let error = applied.succeeded ? RemoteAccountScripts.parseApplied(applied.stdout) : "\(applied.reason ?? "ssh failed")" {
          return failed("\(host.label): \(error)")
        }
      }
    }

    // 3. Logged in there: the same account as here, compared now (a new login is why Prepare runs again).
    guard let login = facts.login, login.loggedIn else {
      deps.log("[broker] account \(account.id) on \(host.label): prepare: not logged in")
      return AccountPreparation(loggedIn: false)
    }
    if let problem = await sameAccountProblem(account, on: host, login: login, home: home, fresh: true) {
      deps.log("[broker] account \(account.id) on \(host.label): prepare: not the same account")
      return AccountPreparation(loggedIn: true, error: problem)
    }
    deps.log("[broker] account \(account.id) on \(host.label): prepare: ready")
    return AccountPreparation(loggedIn: true)
  }

  /// The account's shared tree as stored: its `homePath`, or the driver's default.
  static func homeDirectory(of account: LaunchAccount) -> String {
    account.homePath.isEmpty ? account.driver.defaultHome : account.homePath
  }

  /// The directories whose configuration a host gets, as stored: the home; and a Claude shadow, whose settings, skills
  /// and plugins are its own. A Codex shadow's configuration is its home's, through its links.
  static func configDirectories(of account: LaunchAccount) -> [String] {
    account.driver == .claude && !account.shadowPath.isEmpty ? [homeDirectory(of: account), account.shadowPath] : [homeDirectory(of: account)]
  }

  /// The facts of `request` on `host`, its project folder never cloned.
  private func hostFacts(_ host: BrokerRemoteHost, request: RemoteFactsRequest) async -> Result<RemoteFacts, BrokerFiles.Failure> {
    guard let remoteHosts = deps.remoteHosts else { return .failure(.init("no hosts")) }
    let ran = await remoteHosts.run(onHost: host.id, script: RemoteHostScripts.prepare(cwd: request.cwd),
                                    stdin: RemoteHostScripts.prepareInput(origin: nil, request: request), timeout: RemoteHostScripts.stepTimeout)
    guard ran.succeeded else { return .failure(.init("\(host.label): \(ran.reason ?? "ssh exited with status \(ran.status)")")) }
    switch RemoteHostScripts.parsePrepare(ran.stdout) {
    case .facts(let facts, _): return .success(facts)
    case .cloneFailed(let reason), .failed(let reason): return .failure(.init("\(host.label): \(reason)"))
    }
  }

  // MARK: Same account

  /// Nil when `account` on `host` is logged in to the same provider account as here; else why not, naming the host, the
  /// home and the account. Claude compares the digest the host's facts carry with this Mac's `.claude.json`; Codex asks
  /// `account/read` on both sides, unless the two login files are unchanged since they last matched (`fresh` asks
  /// anyway). Only digests are compared, and none is logged.
  func sameAccountProblem(_ account: LaunchAccount, on host: BrokerRemoteHost, login: RemoteFacts.Login?, home: String,
                          fresh: Bool) async -> String? {
    guard let reader = deps.accountIdentity else { return "This Hivemind Server cannot check accounts on a host" }
    let place = "`\(account.storedDirectory)` on \(host.label)"
    let notLoggedIn = "\(place) has no login of \(account.label) yet. Run `\(account.loginCommand)` in a terminal on \(host.label), "
      + "then Prepare the account in the Accounts sheet."
    guard let login, login.loggedIn else { return notLoggedIn }
    let key = [host.id, account.id, account.homePath, account.shadowPath].joined(separator: "\u{0}")
    let stamps = login.stamp + "|" + LocalAccountIdentity.stamp(AccountLogin(account, home: deps.home).loginFile)
    if account.driver == .codex, !fresh, matchedCodexLogins[key] == stamps { return nil }
    matchedCodexLogins[key] = nil

    let here: AccountIdentity
    switch await reader.identity(of: account, home: deps.home) {
    case .failure(let error): return "Cannot tell which account \(account.label) is logged in to on this Mac: \(error.message)"
    case .success(.none):
      return "\(account.label) is not logged in on this Mac, so its login on \(host.label) cannot be checked. "
        + "Log in here first with `\(account.loginCommand)`."
    case .success(let identity): here = identity
    }
    let there: AccountIdentity
    switch account.driver {
    case .claude:
      there = login.identity.map { .account($0) } ?? .none
    case .codex:
      guard let remoteHosts = deps.remoteHosts else { return notLoggedIn }
      let variables = account.environment(home: home)
      let unset = account.controlledNames.filter { name in !variables.contains { $0.name == name } }
      let ran = await remoteHosts.run(onHost: host.id, script: RemoteAccountScripts.codexIdentity(deps.remoteCodex, set: variables, unset: unset),
                                      stdin: Data(), timeout: RemoteAccountScripts.identityTimeout)
      guard ran.succeeded else { return "Cannot tell which account \(place) is logged in to: \(ran.reason ?? "ssh failed")" }
      switch RemoteAccountScripts.parseIdentity(ran.stdout) {
      case .failure(let error): return "Cannot tell which account \(place) is logged in to: \(error.message)"
      case .success(let identity): there = identity
      }
    }
    guard there != .none else { return notLoggedIn }
    guard there == here else {
      return "\(place) is logged in to another account than \(account.label) on this Mac. Log in there again with "
        + "`\(account.loginCommand)`, then Prepare the account in the Accounts sheet."
    }
    if account.driver == .codex { matchedCodexLogins[key] = stamps }
    return nil
  }

  // MARK: Conversations

  /// Find last conversations on host `id` (docs/remote-hosts.md#conversations): the server's own scan, run there with
  /// the host's runtime, each conversation carrying the host.
  func conversationsOnHost(_ id: String, agents: [ConversationAgent]) async -> Result<[String: BrokerConversation], BrokerProtocolError> {
    guard let remoteHosts = deps.remoteHosts, let host = remoteHosts.brokerHosts.first(where: { $0.id == id }) else {
      return .failure(BrokerProtocolError(.internal, "That host is not configured in Hivemind Server"))
    }
    guard host.ready, let folder = host.runtimeFolder else { return .failure(BrokerProtocolError(.internal, "\(host.label) is offline")) }
    struct Input: Encodable { let agents: [ConversationAgent] }
    let input = (try? JSONEncoder().encode(Input(agents: agents))) ?? Data("{}".utf8)
    let ran = await remoteHosts.run(onHost: host.id, script: RemoteAccountScripts.conversations(runtimeFolder: folder), stdin: input,
                                    timeout: RemoteAccountScripts.identityTimeout)
    guard ran.succeeded else { return .failure(BrokerProtocolError(.internal, "\(host.label): \(ran.reason ?? "ssh failed")")) }
    switch RemoteAccountScripts.parseConversations(ran.stdout, host: host.id) {
    case .failure(let error):
      deps.log("[broker] \(host.label): conversations failed: \(error.message)")
      return .failure(BrokerProtocolError(.internal, "\(host.label): \(error.message)"))
    case .success(let found):
      deps.log("[broker] \(host.label): \(found.count) of \(agents.count) conversations found")
      return .success(found)
    }
  }
}
