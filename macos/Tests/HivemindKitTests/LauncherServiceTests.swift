import Foundation
import HivemindKit
import Testing

private let templateID = "11111111-1111-4111-8111-111111111111"
private let commandID = "22222222-2222-4222-8222-222222222222"
private let requestID = "33333333-3333-4333-8333-333333333333"
private let workerSession = SessionName(project: "acme", agent: "forge-task")

private func launchCommand() -> LauncherCommand {
  LauncherCommand(id: commandID, kind: .launch, requestId: requestID, templateId: templateID,
                  project: "acme", agent: "forge-task", title: "Forge task", session: workerSession.rawValue,
                  cwd: "/tmp/acme", command: "codex task\n", environment: ["MODE": "test"])
}

@MainActor private final class JournalFake: LauncherJournaling {
  var values: [String: LauncherJournalEntry] = [:]
  var writes: [LauncherJournalEntry] = []
  func read(_ id: String) throws -> LauncherJournalEntry? { values[id] }
  func write(_ entry: LauncherJournalEntry, id: String) throws { values[id] = entry; writes.append(entry) }
}

@MainActor private final class BrokerFake: LauncherBrokering {
  var listed: [BrokerSession] = []
  var launches: [BrokerLaunch] = []
  var kills: [SessionName] = []
  func sessions() async throws -> [BrokerSession] { listed }
  func launch(_ launch: BrokerLaunch) async throws -> SessionName {
    launches.append(launch)
    let name = SessionName(project: launch.project, agent: launch.agent!)
    listed.append(BrokerSession(name: name, project: launch.project, agent: launch.agent,
                                alive: true, attached: 0, createdAt: 1))
    return name
  }
  func kill(_ session: SessionName) async throws {
    kills.append(session)
    listed.removeAll { $0.name == session }
  }
}

@MainActor private final class PausingBroker: LauncherBrokering {
  var launches = 0
  var releaseLaunch: CheckedContinuation<SessionName, Never>?
  var listed: [BrokerSession] = []
  func sessions() async throws -> [BrokerSession] { listed }
  func launch(_ launch: BrokerLaunch) async throws -> SessionName {
    launches += 1
    return await withCheckedContinuation { releaseLaunch = $0 }
  }
  func kill(_ session: SessionName) async throws { }
  func release() {
    listed = [BrokerSession(name: workerSession, project: "acme", agent: "forge-task",
                            alive: true, attached: 0, createdAt: 1)]
    releaseLaunch?.resume(returning: workerSession)
    releaseLaunch = nil
  }
}

@MainActor private final class ApprovalNotifierFake: LauncherApprovalNotifying {
  var approvals: [LauncherApproval] = []
  func notify(_ approval: LauncherApproval) { approvals.append(approval) }
}

private actor HTTPFake: LauncherHTTP {
  let secret: InstanceSecret
  var next: Data
  var approvals = Data("{\"requests\":[]}".utf8)
  var requests: [URLRequest] = []
  var validProof = true

  init(secret: InstanceSecret, next: Data = Data("{\"command\":null}".utf8)) {
    self.secret = secret; self.next = next
  }

  func send(_ request: URLRequest) async throws -> (status: Int, body: Data) {
    requests.append(request)
    let url = request.url!
    if url.path == "/api/health/instance" {
      let nonce = InstanceNonce(hex: URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!.first!.value!)!
      let port = ServerPort(url.port!)!
      let proof = validProof ? InstanceProof.proof(secret: secret, nonce: nonce, port: port) : String(repeating: "0", count: 64)
      return (200, Data("{\"proof\":\"\(proof)\"}".utf8))
    }
    if url.path == "/api/launcher/next" { return (200, next) }
    if url.path == "/api/launcher/approvals" { return (200, approvals) }
    if url.path.hasSuffix("/result") || url.path.hasSuffix("/approve") || url.path.hasSuffix("/reject") { return (200, Data("{}".utf8)) }
    return (404, Data())
  }

  func recorded() -> [URLRequest] { requests }
  func invalidateProof() { validProof = false }
  func setApprovals(_ data: Data) { approvals = data }
}

@Suite("Native launcher")
@MainActor struct LauncherServiceTests {
  private func service(_ broker: BrokerFake, _ journal: JournalFake,
                       http: any LauncherHTTP = HTTPFake(secret: InstanceSecret.generate()),
                       secret: InstanceSecret = InstanceSecret.generate()) -> LauncherService {
    LauncherService(server: { .init(endpoint: ServerEndpoint(port: ServerPort(7520)!), secret: secret) },
                    http: http, broker: broker, journal: journal)
  }

  @Test func launchesWithTemplateOnceAndReplaysSavedResult() async throws {
    let broker = BrokerFake(), journal = JournalFake()
    let sut = service(broker, journal)
    let first = try await sut.execute(launchCommand())
    let second = try await sut.execute(launchCommand())
    #expect(first == .launched(workerSession))
    #expect(second == first)
    #expect(broker.launches.count == 1)
    #expect(broker.launches.first?.template?.rawValue == templateID)
    #expect(journal.writes.count == 2)
    #expect(journal.writes.first?.result == nil)
  }

  @Test func reconcilesIntentOnlyWithOwnedSessionAndNeverRelaunches() async throws {
    let broker = BrokerFake(), journal = JournalFake()
    let command = launchCommand()
    journal.values[command.id] = .init(digest: command.digest, session: command.session, kind: .launch)
    broker.listed = [BrokerSession(name: workerSession, project: "acme", agent: "forge-task",
                                   alive: true, attached: 0, createdAt: 1)]
    #expect(try await service(broker, journal).execute(command) == .launched(workerSession))
    #expect(broker.launches.isEmpty)
  }

  @Test func uncertainOrForeignSessionNeverRelaunches() async throws {
    for owner in [nil, "other-agent"] {
      let broker = BrokerFake(), journal = JournalFake(), command = launchCommand()
      journal.values[command.id] = .init(digest: command.digest, session: command.session, kind: .launch)
      if let owner {
        broker.listed = [BrokerSession(name: workerSession, project: "acme", agent: owner,
                                       alive: true, attached: 0, createdAt: 1)]
      }
      let result = try await service(broker, journal).execute(command)
      #expect(result.status == .failed)
      #expect(broker.launches.isEmpty)
    }
  }

  @Test func killIsIdempotentAfterResultAndAfterRestart() async throws {
    let broker = BrokerFake(), journal = JournalFake()
    let command = LauncherCommand(id: commandID, kind: .kill, session: workerSession.rawValue)
    broker.listed = [BrokerSession(name: workerSession, project: "acme", agent: "forge-task",
                                   alive: true, attached: 0, createdAt: 1)]
    let sut = service(broker, journal)
    #expect(try await sut.execute(command) == .killed)
    #expect(try await sut.execute(command) == .killed)
    #expect(broker.kills == [workerSession])
    journal.values[command.id] = .init(digest: command.digest, session: command.session, kind: .kill)
    #expect(try await sut.execute(command) == .killed)
    #expect(broker.kills == [workerSession])
  }

  @Test func verifiesServerAndSignsPollAndResultWithoutCookies() async throws {
    let secret = InstanceSecret.generate(), broker = BrokerFake(), journal = JournalFake()
    let payload = try JSONEncoder().encode(["command": launchCommand()])
    let http = HTTPFake(secret: secret, next: payload)
    try await service(broker, journal, http: http, secret: secret).pollOnce()
    let requests = await http.recorded()
    #expect(broker.launches.count == 1)
    #expect(requests.filter { $0.url!.path == "/api/health/instance" }.count == 3)
    let signed = requests.filter { $0.url!.path.hasPrefix("/api/launcher/") }
    #expect(signed.count == 2)
    #expect(signed.allSatisfy { $0.value(forHTTPHeaderField: "X-Hivemind-Signature")?.count == 64 })
    #expect(signed.allSatisfy { $0.value(forHTTPHeaderField: "Cookie") == nil })
  }

  @Test func refusesCommandsFromAServerWithoutInstanceProof() async throws {
    let secret = InstanceSecret.generate(), broker = BrokerFake(), journal = JournalFake()
    let payload = try JSONEncoder().encode(["command": launchCommand()])
    let http = HTTPFake(secret: secret, next: payload)
    await http.invalidateProof()
    do { try await service(broker, journal, http: http, secret: secret).pollOnce(); Issue.record("accepted bad proof") }
    catch { }
    #expect(broker.launches.isEmpty)
    #expect((await http.recorded()).count == 1)
  }

  @Test func nativeApprovalIsSignedAndRejectHasAnEmptyBody() async throws {
    let secret = InstanceSecret.generate(), broker = BrokerFake(), journal = JournalFake()
    let http = HTTPFake(secret: secret)
    let sut = service(broker, journal, http: http, secret: secret)
    let approve = await sut.decide(requestId: requestID, templateId: TemplateID(templateID), approve: true)
    let reject = await sut.decide(requestId: requestID, templateId: nil, approve: false)
    guard case .success = approve, case .success = reject else { Issue.record("native decision failed"); return }
    let requests = await http.recorded()
    let decisions = requests.filter { $0.url!.path.contains("/requests/") }
    #expect(decisions.count == 2)
    #expect(String(decoding: decisions[0].httpBody!, as: UTF8.self).contains(templateID))
    #expect(String(decoding: decisions[1].httpBody!, as: UTF8.self) == "{}")
    #expect(decisions.allSatisfy { $0.value(forHTTPHeaderField: "X-Hivemind-Signature")?.count == 64 })
  }

  @Test func backgroundApprovalPollNotifiesOnceWithVerifiedServer() async throws {
    let secret = InstanceSecret.generate(), broker = BrokerFake(), journal = JournalFake()
    let http = HTTPFake(secret: secret)
    let notifier = ApprovalNotifierFake()
    await http.setApprovals(Data("{\"requests\":[{\"id\":\"\(requestID)\",\"reason\":\"Need review\"}]}".utf8))
    let sut = LauncherService(server: { .init(endpoint: ServerEndpoint(port: ServerPort(7520)!), secret: secret) },
                              http: http, broker: broker, journal: journal, notifier: notifier)
    try await sut.pollOnce()
    try await sut.pollOnce()
    #expect(notifier.approvals == [LauncherApproval(id: requestID, reason: "Need review")])
    let approvals = await http.recorded().filter { $0.url!.path == "/api/launcher/approvals" }
    #expect(approvals.count == 2)
    #expect(approvals.allSatisfy { $0.value(forHTTPHeaderField: "X-Hivemind-Signature")?.count == 64 })
    await http.invalidateProof()
    do { try await sut.pollOnce(); Issue.record("accepted an unverified server") } catch { }
    #expect(notifier.approvals.count == 1)
  }

  @Test func approvalNotificationURLCanOnlyOpenInbox() {
    #expect(UIAppURLCommand(UIAppURLCommand.inboxURL.absoluteString) == .inbox)
    #expect(UIAppURLCommand.inbox.route == "#/inbox")
    for text in ["hivemind://inbox/other", "hivemind://inbox?x=1", "hivemind://evil",
                 "https://127.0.0.1/inbox", "hivemind://user@inbox"] {
      #expect(UIAppURLCommand(text) == nil)
    }
  }

  @Test func hmacMatchesTheNodeCanonicalVector() {
    let endpoint = ServerEndpoint(port: ServerPort(7520)!)
    let url = URL(string: "api/launcher/requests/\(requestID)/reject", relativeTo: endpoint.baseURL)!.absoluteURL
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.httpBody = Data("{}".utf8)
    LauncherProof.sign(&request, secret: InstanceSecret(hex: String(repeating: "11", count: 32))!,
                       now: Date(timeIntervalSince1970: 1_780_000_000),
                       nonce: InstanceNonce(hex: String(repeating: "22", count: 32))!)
    #expect(request.value(forHTTPHeaderField: "X-Hivemind-Signature") ==
            "64dc9abeebd96f07ca06c7934ad14ec3ba15125cf2c5db76b17524b5e0536fcb")
  }

  @Test func fileJournalSurvivesNewInstanceWithoutPersistingCommandValues() throws {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: folder) }
    let entry = LauncherJournalEntry(digest: launchCommand().digest, session: workerSession.rawValue, kind: .launch)
    try FileLauncherJournal(folder: folder).write(entry, id: commandID)
    #expect(try FileLauncherJournal(folder: folder).read(commandID) == entry)
    let raw = try String(contentsOf: folder.appendingPathComponent(commandID + ".json"), encoding: .utf8)
    #expect(!raw.contains("codex task"))
    #expect(!raw.contains("MODE"))
  }

  @Test func inProcessAdapterUsesTheBrokerRequestPath() async throws {
    let harness = BrokerHarness()
    await harness.start()
    let adapter = InProcessLauncherBroker(current: { harness.broker })
    #expect(try await adapter.sessions().isEmpty)
    let launch = try BrokerLaunch(project: "acme", agent: "forge-task", title: "Forge task",
                                  cwd: "/Users/me/acme", command: "codex task")
    #expect(try await adapter.launch(launch) == workerSession)
    #expect(try await adapter.sessions().map(\.name) == [workerSession])
    try await adapter.kill(workerSession)
    #expect(try await adapter.sessions().isEmpty)
    #expect(harness.tmux.calls("new-session").count == 1)
    #expect(harness.tmux.calls("kill-session").count == 1)
  }

  @Test func serverChangeDrainsOldEffectBeforeReplayingQueue() async throws {
    let secret = InstanceSecret.generate(), broker = PausingBroker(), journal = JournalFake()
    let payload = try JSONEncoder().encode(["command": launchCommand()])
    let http = HTTPFake(secret: secret, next: payload)
    let sut = LauncherService(server: { .init(endpoint: ServerEndpoint(port: ServerPort(7520)!), secret: secret) },
                              http: http, broker: broker, journal: journal)
    sut.start()
    for _ in 0..<10_000 where broker.releaseLaunch == nil { await Task.yield() }
    #expect(broker.releaseLaunch != nil)
    sut.serverChanged()
    try await Task.sleep(for: .milliseconds(20))
    let before = await http.recorded().filter { $0.url!.path == "/api/launcher/next" }.count
    #expect(before == 1, "replacement must await the old broker effect")
    broker.release()
    for _ in 0..<10_000 {
      if await http.recorded().filter({ $0.url!.path == "/api/launcher/next" }).count >= 2 { break }
      await Task.yield()
    }
    sut.stop()
    #expect(broker.launches == 1)
  }

  @Test func nativeDecisionsAreValidatedAndTrustGated() throws {
    let parsed = BridgeMessage(body: ["type": "launcher-approve", "id": "page-1",
                                      "requestId": requestID, "templateId": templateID])
    #expect(parsed == .launcherApprove(id: "page-1", requestId: requestID, templateId: TemplateID(templateID)))
    #expect(BridgeMessage(body: ["type": "launcher-reject", "requestId": "not-a-uuid"]) == nil)
    #expect(TerminalTrustGate.refusal(parsed!) == .answer(.error(id: "page-1", code: .unauthorized,
                                                                  message: TerminalTrustGate.unverifiedMessage, stream: nil)))
    let frame = BrokerRequestFrame(id: "page-1", .launcherReject(requestId: requestID))
    #expect(try BrokerRequestFrame.decode(Data(frame.line().dropLast())) == frame)
  }

  @Test func brokerRelaysNativeDecisionAndKeepsRequestIdentity() async throws {
    let harness = BrokerHarness()
    harness.broker.launcherDecision = { id, template, approve in
      #expect(id == requestID)
      #expect(template?.rawValue == templateID)
      #expect(approve)
      return .success(())
    }
    await harness.start()
    let (transport, connection) = await harness.client()
    await harness.send(connection, .launcherApprove(requestId: requestID, templateId: TemplateID(templateID)), id: "page-1")
    #expect(transport.take() == [BrokerEventFrame(id: "page-1", .launcherDecided(requestId: requestID, action: "approve"))])
  }
}
