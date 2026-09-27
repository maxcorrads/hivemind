import Foundation
import Testing
@testable import HivemindKit

// Worker template secrets (docs/worker-templates.md#secrets) over fakes only:
// nothing here touches the Keychain.

@MainActor
final class FakeTemplateSecretVault: TemplateSecretVault {
  var values: [String: [String: String]] = [:]
  var failure: String?

  func names(for template: TemplateID) throws(BrokerFiles.Failure) -> [String] {
    if let failure { throw BrokerFiles.Failure(failure) }
    return (values[template.rawValue] ?? [:]).keys.sorted()
  }

  func set(_ value: TemplateSecretValue, name: String, for template: TemplateID) throws(BrokerFiles.Failure) {
    if let failure { throw BrokerFiles.Failure(failure) }
    values[template.rawValue, default: [:]][name] = value.value
  }

  func delete(name: String?, for template: TemplateID) throws(BrokerFiles.Failure) {
    if let failure { throw BrokerFiles.Failure(failure) }
    if let name { values[template.rawValue]?[name] = nil } else { values[template.rawValue] = nil }
  }

  func values(for template: TemplateID) throws(BrokerFiles.Failure) -> [String: String] {
    if let failure { throw BrokerFiles.Failure(failure) }
    return values[template.rawValue] ?? [:]
  }
}

private let template = TemplateID("0f8fad5b-d9cb-469f-a165-70867728950e")!
private let secret = "sk-live-0123456789"

private func decode(_ json: String) -> Result<BrokerRequestFrame, BrokerProtocolError> {
  do { return .success(try BrokerRequestFrame.decode(Data(json.utf8))) } catch { return .failure(error) }
}

struct TemplateSecretProtocolTests {
  @Test func templateIDsAreLowercaseUUIDs() {
    #expect(TemplateID("0f8fad5b-d9cb-469f-a165-70867728950e") != nil)
    #expect(TemplateID("0F8FAD5B-D9CB-469F-A165-70867728950E") == nil)
    #expect(TemplateID("not-a-uuid") == nil)
    #expect(TemplateID("") == nil)
  }

  @Test func namesFollowTheLaunchEnvironmentRulesPlusTheOpenCodeKey() {
    #expect(TemplateSecrets.isValidName("OPENCODE_API_KEY"))
    #expect(TemplateSecrets.isValidName("ANTHROPIC_API_KEY"))
    #expect(!TemplateSecrets.isValidName("PATH"))
    #expect(!TemplateSecrets.isValidName("HIVEMIND_TOKEN"))
    #expect(!TemplateSecrets.isValidName("DYLD_INSERT_LIBRARIES"))
    #expect(!TemplateSecrets.isValidName("1BAD"))
  }

  @Test func requestsRoundTripAndTheValueNeverPrints() throws {
    let value = TemplateSecretValue(secret)!
    for request in [BrokerRequest.secretsList(template: template), .secretsSet(template: template, name: "OPENCODE_API_KEY", value: value),
                    .secretsDelete(template: template, name: "OPENCODE_API_KEY"), .secretsDelete(template: template, name: nil)] {
      let line = try BrokerRequestFrame(id: "s1", request).line()
      #expect(try BrokerRequestFrame.decode(line.dropLast()) == BrokerRequestFrame(id: "s1", request))
    }
    let frame = BrokerRequestFrame(.secretsSet(template: template, name: "OPENCODE_API_KEY", value: value))
    #expect(!String(describing: frame).contains(secret))
    #expect(!String(reflecting: frame).contains(secret))
    var dumped = ""
    dump(frame, to: &dumped)
    #expect(!dumped.contains(secret))
  }

  @Test func badRequestsAreRefusedWithoutQuotingTheValue() {
    let cases: [(String, String)] = [
      (#"{"type":"secrets.list","template":"nope"}"#, "template"),
      (#"{"type":"secrets.set","template":"\#(template)","name":"PATH","value":"x"}"#, "name"),
      (#"{"type":"secrets.set","template":"\#(template)","name":"OPENCODE_API_KEY","value":"has space \#(secret)"}"#, "value"),
      (#"{"type":"secrets.set","template":"\#(template)","name":"OPENCODE_API_KEY"}"#, "value"),
      (#"{"type":"secrets.delete","template":"\#(template)","name":7}"#, "name"),
    ]
    for (json, field) in cases {
      guard case .failure(let error) = decode(json) else {
        Issue.record("accepted \(json)")
        continue
      }
      #expect(error.code == .badMessage)
      #expect(error.message.hasPrefix(field))
      #expect(!error.message.contains(secret))
    }
  }

  @Test func theSecretsEventRoundTrips() throws {
    let frame = BrokerEventFrame(id: "s1", .secrets(template: template, names: ["ANTHROPIC_API_KEY", "OPENCODE_API_KEY"]))
    #expect(try BrokerEventFrame.decode(try frame.line().dropLast()) == frame)
  }
}

@MainActor
struct TemplateSecretBrokerTests {
  let harness = BrokerHarness()
  let vault = FakeTemplateSecretVault()

  init() {
    harness.templateSecrets = vault
  }

  @Test func setListAndDeleteAnswerWithNamesOnly() async {
    await harness.start()
    let (transport, connection) = await harness.client()
    await harness.send(connection, .secretsSet(template: template, name: "OPENCODE_API_KEY", value: TemplateSecretValue(secret)!), id: "a")
    await harness.send(connection, .secretsSet(template: template, name: "ANTHROPIC_API_KEY", value: TemplateSecretValue("k-2")!), id: "b")
    await harness.send(connection, .secretsList(template: template), id: "c")
    await harness.send(connection, .secretsDelete(template: template, name: "OPENCODE_API_KEY"), id: "d")
    await harness.send(connection, .secretsDelete(template: template, name: nil), id: "e")
    #expect(transport.take() == [
      BrokerEventFrame(id: "a", .secrets(template: template, names: ["OPENCODE_API_KEY"])),
      BrokerEventFrame(id: "b", .secrets(template: template, names: ["ANTHROPIC_API_KEY", "OPENCODE_API_KEY"])),
      BrokerEventFrame(id: "c", .secrets(template: template, names: ["ANTHROPIC_API_KEY", "OPENCODE_API_KEY"])),
      BrokerEventFrame(id: "d", .secrets(template: template, names: ["ANTHROPIC_API_KEY"])),
      BrokerEventFrame(id: "e", .secrets(template: template, names: [])),
    ])
    #expect(!String(decoding: transport.sent, as: UTF8.self).contains(secret), "no value ever goes back to a client")
    #expect(harness.logs.contains { $0.contains("set secret OPENCODE_API_KEY") })
    #expect(!harness.logs.joined().contains(secret))
  }

  @Test func aTemplateHoldsAtMostEightSecrets() async {
    await harness.start()
    let (transport, connection) = await harness.client()
    for i in 0..<TemplateSecrets.maxNames {
      await harness.send(connection, .secretsSet(template: template, name: "KEY_\(i)", value: TemplateSecretValue("v")!))
    }
    _ = transport.take()
    await harness.send(connection, .secretsSet(template: template, name: "KEY_0", value: TemplateSecretValue("again")!), id: "replace")
    await harness.send(connection, .secretsSet(template: template, name: "KEY_9", value: TemplateSecretValue("v")!), id: "ninth")
    let events = transport.take()
    #expect(events.first?.id == "replace")
    if case .secrets(_, let names) = events.first?.event { #expect(names.count == TemplateSecrets.maxNames) } else { Issue.record("no secrets") }
    #expect(events.last?.id == "ninth")
    if case .error(let code, _, _) = events.last?.event { #expect(code == .badMessage) } else { Issue.record("ninth accepted") }
    #expect(vault.values[template.rawValue]?["KEY_0"] == "again")
    #expect(vault.values[template.rawValue]?["KEY_9"] == nil)
  }

  @Test func withoutAVaultOrWhenItFailsTheAnswerIsAnError() async {
    let bare = BrokerHarness()
    await bare.start()
    let (transport, connection) = await bare.client()
    await bare.send(connection, .secretsList(template: template), id: "x")
    #expect(transport.take() == [BrokerEventFrame(id: "x", .error(code: .internal, message: "this broker cannot keep template secrets", stream: nil))])

    await harness.start()
    let (other, client) = await harness.client()
    vault.failure = "Cannot read in the Keychain: locked"
    await harness.send(client, .secretsSet(template: template, name: "OPENCODE_API_KEY", value: TemplateSecretValue(secret)!), id: "y")
    #expect(other.take() == [BrokerEventFrame(id: "y", .error(code: .internal, message: "Cannot read in the Keychain: locked", stream: nil))])
  }
}

@MainActor
struct TemplateSecretBridgeTests {
  @Test func pageMessagesAreParsedStrictly() {
    #expect(BridgeMessage(body: ["type": "template-secrets-list", "id": "p1", "template": template.rawValue])
      == .templateSecretsList(id: "p1", template: template))
    #expect(BridgeMessage(body: ["type": "template-secrets-set", "id": "p2", "template": template.rawValue, "name": "OPENCODE_API_KEY", "value": secret])
      == .templateSecretsSet(id: "p2", template: template, name: "OPENCODE_API_KEY", value: TemplateSecretValue(secret)!))
    #expect(BridgeMessage(body: ["type": "template-secrets-delete", "template": template.rawValue, "name": NSNull()])
      == .templateSecretsDelete(id: nil, template: template, name: nil))
    for bad: [String: Any] in [
      ["type": "template-secrets-list", "template": "nope"],
      ["type": "template-secrets-set", "template": template.rawValue, "name": "PATH", "value": "x"],
      ["type": "template-secrets-set", "template": template.rawValue, "name": "OPENCODE_API_KEY", "value": "has space"],
      ["type": "template-secrets-set", "template": template.rawValue, "name": "OPENCODE_API_KEY"],
      ["type": "template-secrets-delete", "template": template.rawValue, "name": 3],
    ] {
      #expect(BridgeMessage(body: bad) == nil)
    }
  }

  @Test func theAnswerCarriesNamesAndThePageID() {
    let event = BridgeTerminalEvent(BrokerEventFrame(.secrets(template: template, names: ["OPENCODE_API_KEY"])), id: "p1")
    #expect(event == .templateSecrets(id: "p1", template: template, names: ["OPENCODE_API_KEY"]))
    #expect(event?.detail["type"] as? String == "template-secrets")
    #expect(event?.detail["names"] as? [String] == ["OPENCODE_API_KEY"])
  }

  @Test func anUnverifiedPageIsRefused() {
    #expect(TerminalTrustGate.refusal(.templateSecretsList(id: "p1", template: template))
      == .answer(.error(id: "p1", code: .unauthorized, message: TerminalTrustGate.unverifiedMessage, stream: nil)))
    #expect(TerminalTrustGate.refusal(.templateSecretsSet(id: "p2", template: template, name: "OPENCODE_API_KEY", value: TemplateSecretValue(secret)!))
      == .answer(.error(id: "p2", code: .unauthorized, message: TerminalTrustGate.unverifiedMessage, stream: nil)))
  }

  @Test func theRouterRelaysAndAnswersOnlyTheSamePage() {
    let client = FakeBrokerClient()
    let recorder = RouterRecorder()
    let router = TerminalBridgeRouter(client: client, environment: .init(
      home: "/Users/me", tmuxConfigPath: "/tmp/tmux.conf", now: { recorder.clock },
      deliver: { recorder.delivered.append($0) }, openTerminals: { recorder.opened.append($0) }, scheduler: FakeScheduler()))
    client.status = BrokerClientStatus(connection: .connected, tmuxPath: "/opt/homebrew/bin/tmux")
    router.handle(.templateSecretsSet(id: "p1", template: template, name: "OPENCODE_API_KEY", value: TemplateSecretValue(secret)!))
    #expect(client.started == 1)
    #expect(client.sent == [.secretsSet(template: template, name: "OPENCODE_API_KEY", value: TemplateSecretValue(secret)!)])
    client.answer(.secrets(template: template, names: ["OPENCODE_API_KEY"]))
    #expect(recorder.delivered == [.templateSecrets(id: "p1", template: template, names: ["OPENCODE_API_KEY"])])
    router.handle(.templateSecretsList(id: "p2", template: template))
    router.pageDidChange()
    client.answer(.secrets(template: template, names: []))
    #expect(recorder.delivered.count == 1, "an answer for a page that is gone is dropped")
  }
}

@MainActor
struct TemplateLaunchTests {
  func harness() throws -> (BrokerHarness, LaunchSecretStore, FakeTemplateSecretVault) {
    let h = BrokerHarness()
    let store = LaunchSecretStore(folder: HivemindPaths(home: try temporaryHome()).launchSecrets)
    let vault = FakeTemplateSecretVault()
    h.secretStore = store
    h.templateSecrets = vault
    return (h, store, vault)
  }

  func files(_ store: LaunchSecretStore) -> [String] {
    ((try? FileManager.default.contentsOfDirectory(atPath: store.folder.path)) ?? []).map { store.folder.appendingPathComponent($0).path }
  }

  func launch(_ agent: String = "Forge-api", environment: LaunchEnvironment? = nil, secrets: LaunchSecrets? = nil) throws -> BrokerLaunch {
    try BrokerLaunch(project: "acme", agent: agent, title: "Acme - \(agent)", cwd: "/Users/me/acme", command: "opencode-hm",
                     secrets: secrets, environment: environment, template: template)
  }

  @Test func theBrokerAddsTheTemplateSecretsFromItsVaultNeverFromTheClient() async throws {
    let (h, store, vault) = try harness()
    vault.values[template.rawValue] = ["OPENCODE_API_KEY": secret, "OTHER_KEY": "k-2"]
    await h.start()
    let (transport, connection) = await h.client()
    await h.send(connection, .launch([try launch(environment: try LaunchEnvironment(["A": "1"]))]), id: "go")
    let session = SessionName("hm-acme-forge-api")!
    #expect(transport.take().first == BrokerEventFrame(id: "go", .launched(names: [session], created: [session], errors: [])))
    let written = files(store)
    #expect(written.count == 1)
    #expect(try Data(contentsOf: URL(fileURLWithPath: written[0])) == Data("A=1\nOPENCODE_API_KEY=\(secret)\nOTHER_KEY=k-2\n".utf8))
    #expect(!h.tmux.calls.joined().contains { $0.contains(secret) })
    #expect(!h.logs.joined().contains(secret))
    #expect(h.logs.contains { $0.contains("template secrets [\"OPENCODE_API_KEY\", \"OTHER_KEY\"]") })
    #expect(!String(decoding: transport.sent, as: UTF8.self).contains(secret))
  }

  @Test func theLaunchsOwnSecretWinsOverTheTemplates() {
    let bytes = LaunchSecretStore.contents(environment: nil, secrets: try? LaunchSecrets(["OPENCODE_API_KEY": "typed"]),
                                           templateSecrets: ["OPENCODE_API_KEY": "kept"])
    #expect(String(decoding: bytes, as: UTF8.self) == "OPENCODE_API_KEY=kept\nOPENCODE_API_KEY=typed\n", "the later line is exported last")
  }

  @Test func aTemplateWithoutKeptSecretsStillLaunchesAndAVaultFailureDoesNot() async throws {
    let (h, store, vault) = try harness()
    await h.start()
    let (transport, connection) = await h.client()
    await h.send(connection, .launch([try launch()]))
    if case .launched(let names, _, let errors) = transport.events().first { #expect(names.first != nil && errors.isEmpty) }
    #expect(files(store).count == 1, "an empty launch file; the script reads and deletes it")

    vault.failure = "Cannot read OPENCODE_API_KEY in the Keychain: locked"
    await h.send(connection, .launch([try launch("Forge-web")]))
    guard case .launched(let names, _, let errors) = transport.events().first else {
      Issue.record("no answer")
      return
    }
    #expect(names == [nil])
    #expect(errors == [BrokerLaunchFailure(index: 0, code: .internal, message: "launches[0].template: Cannot read OPENCODE_API_KEY in the Keychain: locked")])
  }

  @Test func theTemplateTravelsOnTheWireAndThroughTheBridge() throws {
    let frame = BrokerRequestFrame(id: "l", .launch([try launch()]))
    #expect(try BrokerRequestFrame.decode(try frame.line().dropLast()) == frame)
    let body: [String: Any] = ["project": "acme", "agent": "Forge-api", "title": "Acme - Forge-api", "cwd": "~/acme", "command": "opencode-hm",
                               "template": template.rawValue]
    #expect(TerminalSessionLaunch(body: body)?.brokerLaunch(home: "/Users/me")?.template == template)
    var bad = body
    bad["template"] = "nope"
    #expect(TerminalSessionLaunch(body: bad) == nil)
  }
}
