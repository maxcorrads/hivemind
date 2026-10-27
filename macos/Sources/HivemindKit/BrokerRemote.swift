import Foundation

// The broker's remote hosts (docs/remote-hosts.md#launch): what it does on a host, over the host's master connection,
// that it does here with tmux and the file system. The steps and their order are the local launch's
// (BrokerConnection.launchNow); RemoteHostScripts builds what runs on the host. With no host (`deps.remoteHosts` nil)
// none of this runs.

/// A host's last probe and sessions.
struct RemoteListing {
  var probe: RemoteHostProbe?
  var sessions: [BrokerSession]
  var listedAt: Date
}

/// What one launch on a host came to.
struct RemoteLaunchOutcome {
  var started = false
  var created = false
  var failure: BrokerLaunchFailure?
}

extension TerminalBroker {
  // MARK: Sessions

  /// The sessions of every ready host, each listed again when `fresh` or when its last list is
  /// `BrokerLimits.remoteSessionsPollInterval` old. A host whose list fails keeps its last one.
  func remoteSessions(fresh: Bool) async -> [BrokerSession] {
    guard let remoteHosts = deps.remoteHosts else { return [] }
    var sessions: [BrokerSession] = []
    for host in remoteHosts.brokerHosts where host.ready {
      let listing = remoteListings[host.id]
      if fresh || listing.map({ deps.scheduler.now().timeIntervalSince($0.listedAt) >= BrokerLimits.remoteSessionsPollInterval }) ?? true {
        _ = await probe(host)
      }
      sessions += remoteListings[host.id]?.sessions ?? []
    }
    return sessions
  }

  /// The last sessions of hosts that are not ready now: not listed, but their names stay taken.
  var offlineRemoteSessions: [BrokerSession] {
    guard let remoteHosts = deps.remoteHosts else { return [] }
    return remoteHosts.brokerHosts.filter { !$0.ready }.flatMap { remoteListings[$0.id]?.sessions ?? [] }
  }

  /// Lists `host` now: its home, its tmux and its sessions. Nil when the host could not be asked.
  @discardableResult
  func probe(_ host: BrokerRemoteHost) async -> RemoteHostProbe? {
    guard let remoteHosts = deps.remoteHosts, let folder = host.runtimeFolder else { return nil }
    let scripts = RemoteHostScripts(runtimeFolder: folder, tmux: deps.remoteTmux)
    let result = await remoteHosts.run(onHost: host.id, script: scripts.probe, stdin: Data(), timeout: RemoteHostScripts.stepTimeout)
    guard result.succeeded, let probe = RemoteHostScripts.parseProbe(result.stdout, host: host.id) else {
      deps.log("[broker] \(host.label): list failed: \(result.reason ?? "status \(result.status)")")
      return nil
    }
    var listing = remoteListings[host.id] ?? RemoteListing(probe: nil, sessions: [], listedAt: .distantPast)
    listing.probe = probe
    listing.listedAt = deps.scheduler.now()
    switch probe.sessions {
    case .success(let sessions): listing.sessions = sessions
    case .failure(let error): deps.log("[broker] \(host.label): list-sessions failed: \(error.message)")
    }
    remoteListings[host.id] = listing
    return probe
  }

  /// The host `session` was last listed on, from the last lists only.
  func knownRemoteHost(of session: SessionName) -> BrokerRemoteHost? {
    guard let remoteHosts = deps.remoteHosts else { return nil }
    return remoteHosts.brokerHosts.first { host in remoteListings[host.id]?.sessions.contains { $0.name == session } == true }
  }

  /// The ready host `session` runs on, listing the hosts again when the last lists do not have it; nil for this Mac's.
  func remoteHost(of session: SessionName) async -> BrokerRemoteHost? {
    guard deps.remoteHosts != nil else { return nil }
    if let host = knownRemoteHost(of: session) { return host }
    _ = await remoteSessions(fresh: true)
    return knownRemoteHost(of: session)
  }

  /// tmux kill-session on `host`, as its result; nil when the host could not be asked.
  func killOnHost(_ session: SessionName, host: BrokerRemoteHost) async -> TmuxResult? {
    guard let remoteHosts = deps.remoteHosts, host.ready, let folder = host.runtimeFolder else { return nil }
    let scripts = RemoteHostScripts(runtimeFolder: folder, tmux: deps.remoteTmux)
    var found = remoteListings[host.id]?.probe
    if found?.tmux == nil { found = await probe(host) }
    guard let probe = found, let tmux = scripts.tmuxCommand(probe) else { return nil }
    let result = await remoteHosts.run(onHost: host.id, script: RemoteHostScripts.kill(session, tmux: tmux), stdin: Data(),
                                       timeout: RemoteHostScripts.stepTimeout)
    remoteListings[host.id]?.listedAt = .distantPast
    guard result.succeeded, let killed = RemoteHostScripts.parseKill(result.stdout) else { return nil }
    if killed.succeeded { deps.log("[broker] \(host.label): killed \(session)") }
    return killed
  }

  // MARK: Launch

  /// Starts `launch` as `name` on host `id`: the local launch's checks, in its order, on the host's facts, then one
  /// start there. The session name was chosen against every host's sessions (BrokerConnection.launchNow).
  func launchOnHost(_ id: String, _ launch: BrokerLaunch, name: SessionName, index: Int) async -> RemoteLaunchOutcome {
    func failed(_ code: BrokerErrorCode, _ field: String, _ message: String) -> RemoteLaunchOutcome {
      RemoteLaunchOutcome(failure: BrokerLaunchFailure(index: index, code: code, message: "launches[\(index)].\(field): \(message)"))
    }
    guard let remoteHosts = deps.remoteHosts, let host = remoteHosts.brokerHosts.first(where: { $0.id == id }) else {
      return failed(.internal, "host", "no such host")
    }
    guard host.ready, let folder = host.runtimeFolder else { return failed(.internal, "host", "\(host.label) is offline") }
    let scripts = RemoteHostScripts(runtimeFolder: folder, tmux: deps.remoteTmux)
    var listed = remoteListings[host.id]?.probe
    if listed == nil { listed = await self.probe(host) }
    guard let probe = listed else { return failed(.internal, "host", "cannot reach \(host.label)") }
    guard let tmux = scripts.tmuxCommand(probe) else {
      return failed(.tmuxMissing, "host", "\(host.label) has no tmux. \(TmuxLocator.installHint) there")
    }
    let home = probe.home

    // The facts every check below reads, after the folder is cloned there if it is missing.
    var request = RemoteFactsRequest(cwd: launch.cwd)
    let thread = launch.account != nil ? CodexThreadLock.resumedThread(in: launch.command) : nil
    if let thread {
      request.codexLock = .init(directory: CodexThreadLock(home: CodexThreadLock.sharedHome(for: launch.account, home: home)).directory,
                                thread: thread)
    }
    if let account = launch.account { noteClaudeAccount(account) }
    let resume = launch.account != nil ? ClaudeLiveSessions.resumed(in: launch.command) : nil
    let directories = resume != nil ? ClaudeLiveSessions.directories(for: launch.account, known: claudeAccounts, home: home) : []
    if resume != nil { request.claude = .init(directories: directories.map(\.path)) }
    if launch.account?.driver == .claude { request.projectSettings = BrokerConnection.projectSettingsFiles(cwd: launch.cwd) }
    if let account = launch.account, !account.shadowPath.isEmpty {
      request.shadow = .init(home: expandingHome(account.homePath.isEmpty ? account.driver.defaultHome : account.homePath, home: home),
                             shadow: expandingHome(account.shadowPath, home: home), driver: account.driver.rawValue)
    }
    let origin = await deps.originURL(launch.cwd)
    let preparing = await remoteHosts.run(onHost: host.id, script: RemoteHostScripts.prepare(cwd: launch.cwd),
                                          stdin: RemoteHostScripts.prepareInput(origin: origin, request: request),
                                          timeout: RemoteHostScripts.cloneTimeout)
    guard preparing.succeeded else {
      return failed(.internal, "host", "\(host.label): \(preparing.reason ?? "ssh exited with status \(preparing.status)")")
    }
    let facts: RemoteFacts
    switch RemoteHostScripts.parsePrepare(preparing.stdout) {
    case .cloneFailed(let reason): return failed(.internal, "cwd", "cannot clone the project into `\(launch.cwd)` on \(host.label): \(reason)")
    case .failed(let reason): return failed(.internal, "host", "\(host.label): \(reason)")
    case .facts(let read, let cloned):
      facts = read
      if cloned { deps.log("[broker] \(name): cloned the project on \(host.label)") }
    }

    // The one-writer checks run on the host that has the conversation (docs/accounts.md, "Live sessions").
    if let thread {
      switch facts.codexLock {
      case "open":
        return failed(.internal, "command",
                      "Codex thread `\(thread)` is already open in another process on \(host.label). Close it there, or start a new session.")
      case let state? where state.hasPrefix("error:"): return failed(.internal, "command", String(state.dropFirst(6)))
      default: break
      }
    }
    if let resume {
      if let error = facts.claude?.error { return failed(.internal, "command", error) }
      if let holder = ClaudeLiveSessions.holder(of: resume, cwd: facts.cwd.real ?? launch.cwd, in: directories,
                                                records: facts.claude?.records ?? []) {
        return failed(.internal, "command",
                      "Claude session `\(holder.sessionID)` is already open in another process on \(host.label) (account `\(holder.label)`).")
      }
    }

    // The account: the same variables and unset names as here, its paths expanded with the host's home.
    var accountVariables: [(name: String, value: String)] = []
    var fileEnvironment = launch.environment
    var unsetNames: [String] = []
    let tap = launch.account?.driver == .claude && deps.claudeTap != nil
      ? ClaudeStatusTap(folder: URL(fileURLWithPath: "\(home)/\(RemoteHostScripts.supportFolder)/accounts", isDirectory: true)) : nil
    if let account = launch.account {
      if let message = account.environmentConflict(in: launch.environment, secretNames: launch.secrets?.names ?? []) {
        return failed(.badMessage, "account", message)
      }
      if let message = BrokerConnection.projectOverride(of: account, settings: facts.projectSettings ?? []) {
        return failed(.badMessage, "account", message)
      }
      accountVariables = account.environment(home: home)
      unsetNames = account.controlledNames.filter { controlled in !accountVariables.contains { $0.name == controlled } }
      if !accountVariables.isEmpty {
        var values = launch.environment?.dictionary ?? [:]
        for variable in accountVariables { values[variable.name] = variable.value }
        do { fileEnvironment = try LaunchEnvironment(values) } catch { return failed(.badMessage, "account", error.message) }
      }
    }
    let environmentFile = launch.handsVariables || !accountVariables.isEmpty || tap != nil
      ? LaunchEnvironmentFile(path: "\(home)/\(RemoteHostScripts.supportFolder)/launch-secrets/\(UUID().uuidString).env") : nil
    let arguments = tmux.newSession(TmuxNewSession(name: name, launch: launch, environmentFile: environmentFile, unsetNames: unsetNames))
    let bytes = TmuxCommand.commandLineBytes(arguments)
    guard bytes <= TmuxCommand.maxCommandLineBytes else {
      return RemoteLaunchOutcome(failure: BrokerLaunchFailure(index: index, code: .badMessage,
                                                              message: BrokerConnection.tooLongForTmux(index: index, bytes: bytes)))
    }
    guard facts.cwd.directory else {
      return failed(.cwdMissing, "cwd", origin == nil
        ? "not a folder on \(host.label), and this Mac's copy has no origin to clone it from"
        : "not a folder on \(host.label)")
    }
    // The template's secrets come from this Mac's vault, never from the client.
    var templateSecrets: [String: String] = [:]
    if let template = launch.template, let vault = deps.templateSecrets {
      do { templateSecrets = try vault.values(for: template) } catch {
        deps.log("[broker] \(name): cannot read template \(template)'s secrets: \(error.message)")
        return failed(.internal, "template", error.message)
      }
      if !templateSecrets.isEmpty { deps.log("[broker] \(name): template secrets \(templateSecrets.keys.sorted())") }
    }
    var actions: [SnapshotShadowFiles.Action] = []
    var tapFiles: [RemoteHostScripts.PrivateFile] = []
    if let account = launch.account {
      if let message = account.environmentConflict(in: nil, secretNames: templateSecrets.keys.sorted()) {
        return failed(.badMessage, "account", message)
      }
      // The shadow is checked and linked by the same steps as here, on the host's files; its writes are made there.
      let files = SnapshotShadowFiles(facts.shadow ?? ShadowFacts(paths: [:]))
      do { try deps.shadowHomes.prepare(account, home: home, files: files) } catch {
        return failed(.internal, "account", error.localizedDescription)
      }
      actions = files.actions
      if let tap, let settings = tap.settings(for: account, home: home), let folder = tap.accountFolder(account.id) {
        let file = folder.appendingPathComponent("settings.json").path
        tapFiles = [.init(path: tap.script.path, contents: ClaudeStatusTap.scriptText),
                    .init(path: file, contents: String(decoding: settings, as: UTF8.self))]
        var values = fileEnvironment?.dictionary ?? [:]
        values[ClaudeStatusTap.variable] = file
        do { fileEnvironment = try LaunchEnvironment(values, field: "account", brokerNames: [ClaudeStatusTap.variable]) } catch {
          tapFiles = []
          deps.log("[broker] \(name): no Claude status-line tap on \(host.label): \(error.message)")
        }
      }
    }
    let contents = environmentFile == nil ? []
      : LaunchSecretStore.contents(environment: fileEnvironment, secrets: launch.secrets, templateSecrets: templateSecrets)
    let starting = await remoteHosts.run(
      onHost: host.id,
      script: RemoteHostScripts.start(actions: actions, tapFiles: tapFiles, file: environmentFile, tmux: tmux, arguments: arguments, name: name),
      stdin: Data(contents), timeout: RemoteHostScripts.stepTimeout)
    remoteListings[host.id]?.listedAt = .distantPast
    guard starting.succeeded, let started = RemoteHostScripts.parseStart(starting.stdout) else {
      return failed(.internal, "host", "\(host.label): \(starting.reason ?? "the launch did not answer")")
    }
    if let error = started.error { return failed(.internal, launch.account != nil && !actions.isEmpty ? "account" : "host", error) }
    if started.tap == false { deps.log("[broker] \(name): no Claude status-line tap on \(host.label): its files could not be written") }
    guard started.started else {
      let message = started.said ?? "tmux exited with status \(started.status)"
      return RemoteLaunchOutcome(failure: BrokerLaunchFailure(index: index, code: .tmuxFailed, message: message))
    }
    if started.status != 0 { deps.log("[broker] \(name) on \(host.label): \(started.said ?? "status \(started.status)")") }
    deps.log("[broker] \(name): started on \(host.label)")
    return RemoteLaunchOutcome(started: true, created: !started.duplicate)
  }
}
