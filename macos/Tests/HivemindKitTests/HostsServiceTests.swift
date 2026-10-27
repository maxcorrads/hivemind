import Foundation
import Testing
@testable import HivemindKit

// Server.app's hosts (docs/remote-hosts.md#hosts) on fakes: hosts.json in a temp home, connections on a FakeLauncher,
// a FakeScheduler and FakeSSHRunner, and the catalog to a fake server that answers the instance proof and the PUT.

/// The server: its instance proof and `PUT /api/launcher/hosts`.
private actor HostsHTTPFake: LauncherHTTP {
  let secret: InstanceSecret
  var status = 200
  var requests: [URLRequest] = []

  init(secret: InstanceSecret) { self.secret = secret }

  func send(_ request: URLRequest) async throws -> (status: Int, body: Data) {
    requests.append(request)
    let url = request.url!
    if url.path == "/api/health/instance" {
      let nonce = InstanceNonce(hex: URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!.first!.value!)!
      return (200, Data("{\"proof\":\"\(InstanceProof.proof(secret: secret, nonce: nonce, port: ServerPort(url.port!)!))\"}".utf8))
    }
    if url.path == HostsService.catalogPath { return (status, Data("{\"ok\":true}".utf8)) }
    return (404, Data())
  }

  func recorded() -> [URLRequest] { requests }
  func failNext(_ status: Int) { self.status = status }

  /// The hosts of each catalog put, in order, decoded strictly: exactly `id`, `label` and `online`.
  func catalogs() throws -> [[HostCatalogEntry]] {
    try requests.filter { $0.url?.path == HostsService.catalogPath }.map { request in
      let body = request.httpBody ?? Data()
      let json = try JSONSerialization.jsonObject(with: body) as? [String: Any]
      guard json?.keys.sorted() == ["hosts"],
            (json?["hosts"] as? [[String: Any]])?.allSatisfy({ $0.keys.sorted() == ["id", "label", "online"] }) == true
      else { throw BrokerFiles.Failure("unexpected catalog keys") }
      struct Body: Decodable { let hosts: [HostCatalogEntry] }
      return try JSONDecoder().decode(Body.self, from: body).hosts
    }
  }
}

/// The server the service sees, which a test can replace.
@MainActor private final class ServerBox {
  var server: LauncherService.Server?
  init(_ server: LauncherService.Server?) { self.server = server }
}

@Suite("Hosts service")
@MainActor struct HostsServiceTests {
  let secret = InstanceSecret.generate()
  let launcher = FakeLauncher()
  let scheduler = FakeScheduler()
  let runner = FakeSSHRunner()
  let installer = FakeInstaller()
  let home: URL
  private let http: HostsHTTPFake
  var paths: HivemindPaths { HivemindPaths(home: home) }

  init() throws {
    home = try temporaryHome()
    http = HostsHTTPFake(secret: secret)
  }

  private func server(_ port: Int = 7520) -> LauncherService.Server {
    .init(endpoint: ServerEndpoint(port: ServerPort(port)!), secret: secret)
  }

  private func service(server: Bool = true, box: ServerBox? = nil) -> HostsService {
    let box = box ?? ServerBox(server ? self.server() : nil)
    let deps = HostsService.Dependencies(
      transport: SSHTransport(environment: [:], controlFolder: paths.hostSockets), launcher: launcher, runner: runner,
      scheduler: scheduler, installer: installer, http: http)
    return HostsService(store: RemoteHostStore(paths: paths), server: { box.server }, dependencies: deps)
  }

  @Test func withNoHostThereIsNoConnectionNoAgentListenerAndNoCatalogRequest() async throws {
    let hosts = service()
    var portChanges = 0
    hosts.onAgentPortChange = { portChanges += 1 }
    hosts.start()
    hosts.serverChanged()
    try await hosts.postCatalogOnce()
    await hosts.settle()
    scheduler.advance(120)
    #expect(hosts.hosts.isEmpty && hosts.agentPort == nil && hosts.summary == nil && hosts.catalog.isEmpty)
    #expect(launcher.specs.isEmpty && runner.calls.isEmpty && installer.ensured.isEmpty)
    #expect(await http.recorded().isEmpty, "the server is never asked anything, as before hosts")
    #expect(portChanges == 0)
    #expect(!FileManager.default.fileExists(atPath: paths.hostsFile.path))
    #expect(!FileManager.default.fileExists(atPath: paths.hostSockets.path))
    var stopped = false
    hosts.stop { stopped = true }
    #expect(stopped)
  }

  @Test func addingTheFirstHostSavesItConnectsItTurnsTheAgentListenerOnAndSendsTheCatalogSigned() async throws {
    let hosts = service()
    var portChanges: [ServerPort?] = []
    hosts.onAgentPortChange = { portChanges.append(hosts.agentPort) }
    hosts.start()
    try hosts.add(fakeHost)
    #expect(portChanges == [HostsService.defaultAgentPort])
    #expect(try RemoteHostStore(paths: paths).load() == [fakeHost])
    await hosts.settle()
    #expect(launcher.specs.count == 1, "the new host connects at once")
    #expect(launcher.specs[0].arguments.contains("127.0.0.1:7422:127.0.0.1:7422"))
    #expect(try await http.catalogs() == [[HostCatalogEntry(id: fakeHost.id, label: "Build Mac", online: false)]])

    scheduler.advance(HostConnection.checkInterval)
    await hosts.settle()
    #expect(hosts.connection(fakeHost.id)?.isReady == true)
    #expect(hosts.summary == "Host Build Mac: online")
    #expect(try await http.catalogs().last == [HostCatalogEntry(id: fakeHost.id, label: "Build Mac", online: true)])
    let requests = await http.recorded()
    for request in requests where request.url?.path == HostsService.catalogPath {
      #expect(request.httpMethod == "PUT")
      #expect(request.value(forHTTPHeaderField: "X-Hivemind-Signature")?.count == 64)
      let body = String(decoding: request.httpBody ?? Data(), as: UTF8.self)
      #expect(!body.contains("mini.local") && !body.contains("1080"), "the destination and forwards never leave the app")
    }
    #expect(requests.first?.url?.path == "/api/health/instance", "the server is verified before it learns a label")
  }

  @Test func removingTheLastHostEndsItsMasterClearsTheCatalogAndTurnsTheListenerOff() async throws {
    try RemoteHostStore(paths: paths).save([fakeHost])
    let hosts = service()
    #expect(hosts.agentPort == HostsService.defaultAgentPort, "a saved host opens the listener from the first start")
    var portChanges: [ServerPort?] = []
    hosts.onAgentPortChange = { portChanges.append(hosts.agentPort) }
    hosts.start()
    await hosts.settle()
    scheduler.advance(HostConnection.checkInterval)
    await hosts.settle()
    try hosts.remove(fakeHost.id)
    await hosts.settle()
    #expect(launcher.current?.terminated == 1)
    #expect(portChanges == [nil])
    #expect(try RemoteHostStore(paths: paths).load() == [])
    #expect(try await http.catalogs().last == [], "the server forgets the host")
    scheduler.advance(120)
    #expect(launcher.specs.count == 1, "a removed host never reconnects")
  }

  @Test func aNewServerGetsTheCatalogAgainAndAnUnchangedOneIsNotSentTwice() async throws {
    try RemoteHostStore(paths: paths).save([fakeHost])
    let box = ServerBox(server())
    let hosts = service(box: box)
    try await hosts.postCatalogOnce()
    try await hosts.postCatalogOnce()
    #expect(try await http.catalogs().count == 1)
    box.server = server(7521)
    hosts.serverChanged()
    await hosts.settle()
    let requests = await http.recorded().filter { $0.url?.path == HostsService.catalogPath }
    #expect(requests.map { $0.url?.port } == [7520, 7521], "a restarted server holds no catalog until it gets one")
    box.server = nil
    hosts.serverChanged()
    await hosts.settle()
    #expect(try await http.catalogs().count == 2, "no server, no post")
  }

  @Test func aRefusedCatalogIsAnErrorAndTheNextPostSendsItAgain() async throws {
    try RemoteHostStore(paths: paths).save([fakeHost])
    let hosts = service()
    await http.failNext(500)
    await #expect(throws: BrokerFiles.Failure("hosts catalog HTTP 500")) { try await hosts.postCatalogOnce() }
    await http.failNext(200)
    try await hosts.postCatalogOnce()
    #expect(try await http.catalogs().count == 2)
  }

  @Test func anUnreadableHostsFileConnectsNothingAndRefusesChanges() async throws {
    try FileManager.default.createDirectory(at: paths.appSupport, withIntermediateDirectories: true)
    try Data("not json".utf8).write(to: paths.hostsFile)
    let hosts = service()
    hosts.start()
    #expect(hosts.loadError?.contains("cannot be read") == true)
    #expect(!hosts.canAdd)
    #expect(throws: BrokerFiles.Failure.self) { try hosts.add(fakeHost) }
    #expect(try Data(contentsOf: paths.hostsFile) == Data("not json".utf8), "the file is never overwritten")
    #expect(launcher.specs.isEmpty)
  }

  @Test func atMostSixteenHosts() throws {
    let hosts = service(server: false)
    for index in 0..<HostsService.maxHosts {
      try hosts.add(RemoteHost(label: "Mac \(index)", ssh: "mac\(index)"))
    }
    #expect(!hosts.canAdd)
    #expect(throws: BrokerFiles.Failure("Hivemind takes at most 16 hosts")) { try hosts.add(RemoteHost(label: "One more", ssh: "more")) }
    #expect(hosts.summary == "Hosts: 0 of 16 online")
  }
}
