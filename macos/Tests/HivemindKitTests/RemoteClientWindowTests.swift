import Foundation
import Testing
@testable import HivemindKit

// What an iOS scene decides without UIKit.

struct RemoteClientNavigationTests {
  let endpoint = GatewayEndpoint(host: "192.168.1.20", port: 7443)!

  func decide(_ text: String, mainFrame: Bool = true, user: Bool = false) -> NavigationDecision {
    RemoteClientNavigation.decide(URL(string: text)!, endpoint: endpoint, isMainFrame: mainFrame, userActivated: user)
  }

  @Test func staysOnTheGatewayOrigin() {
    #expect(decide("https://192.168.1.20:7443/") == .allow)
    #expect(decide("https://192.168.1.20:7443/api/files/1?inline=1#x") == .allow)
    #expect(decide("about:blank") == .allow)
    #expect(decide("about:srcdoc") == .allow)
    #expect(decide("blob:https://192.168.1.20:7443/5e1c") == .allow)
    // The same host on another port or scheme is another origin.
    #expect(decide("https://192.168.1.20:7420/") == .openExternally)
    #expect(decide("http://192.168.1.20:7443/") == .openExternally)
    #expect(decide("wss://192.168.1.20:7443/ws") == .deny)
    #expect(decide("blob:https://evil.example/5e1c") == .deny)
    #expect(decide("about:config") == .deny)
    #expect(decide("https://user:pw@192.168.1.20:7443/") == .deny)
  }

  @Test func onlyATapInAnIframeLeavesForSafari() {
    #expect(decide("https://example.com/") == .openExternally)
    #expect(decide("mailto:a@example.com") == .openExternally)
    #expect(decide("https://example.com/", mainFrame: false) == .deny)
    #expect(decide("https://example.com/", mainFrame: false, user: true) == .openExternally)
    #expect(decide("hivemind-server://start") == .deny)
    #expect(decide("javascript:alert(1)") == .deny)
    #expect(decide("file:///etc/passwd") == .deny)
  }

  @Test func mainFrameStatuses() {
    #expect(RemoteClientNavigation.mainFrameStatus(200) == .show)
    #expect(RemoteClientNavigation.mainFrameStatus(404) == .show)
    #expect(RemoteClientNavigation.mainFrameStatus(401) == .renewSession)
    #expect(RemoteClientNavigation.mainFrameStatus(502) == .serverStopped)
    #expect(RemoteClientNavigation.mainFrameStatus(503) == .serverUnverified)
  }
}

struct RemoteBridgeOriginGateTests {
  @Test func onlyTheGatewaysMainFrame() {
    let v4 = GatewayEndpoint(host: "192.168.1.20", port: 7443)!
    #expect(RemoteBridgeOriginGate.accepts(isMainFrame: true, scheme: "https", host: "192.168.1.20", port: 7443, endpoint: v4))
    #expect(!RemoteBridgeOriginGate.accepts(isMainFrame: false, scheme: "https", host: "192.168.1.20", port: 7443, endpoint: v4))
    #expect(!RemoteBridgeOriginGate.accepts(isMainFrame: true, scheme: "http", host: "192.168.1.20", port: 7443, endpoint: v4))
    #expect(!RemoteBridgeOriginGate.accepts(isMainFrame: true, scheme: "https", host: "192.168.1.21", port: 7443, endpoint: v4))
    #expect(!RemoteBridgeOriginGate.accepts(isMainFrame: true, scheme: "https", host: "192.168.1.20", port: 0, endpoint: v4))
    let v6 = GatewayEndpoint(host: "FD7A:115C:A1E0:0::5", port: 7443)!
    #expect(RemoteBridgeOriginGate.accepts(isMainFrame: true, scheme: "https", host: "fd7a:115c:a1e0::5", port: 7443, endpoint: v6))
    #expect(RemoteBridgeOriginGate.accepts(isMainFrame: true, scheme: "HTTPS", host: "[fd7a:115c:a1e0::5]", port: 7443, endpoint: v6))
    let standard = GatewayEndpoint(host: "10.0.0.2", port: 443)!
    #expect(RemoteBridgeOriginGate.accepts(isMainFrame: true, scheme: "https", host: "10.0.0.2", port: 0, endpoint: standard))
  }
}

struct RemoteWindowRouteTests {
  let endpoint = GatewayEndpoint(host: "fd7a:115c:a1e0::5", port: 7443)!

  @Test func roundTripsAHashRoute() {
    let url = RemoteWindowRoute.url(hash: "#/c/acme/general", endpoint: endpoint)
    #expect(url.absoluteString == "https://[fd7a:115c:a1e0::5]:7443/#/c/acme/general")
    #expect(RemoteWindowRoute.route(of: url, endpoint: endpoint) == "#/c/acme/general")
    #expect(RemoteWindowRoute.url(hash: nil, endpoint: endpoint) == endpoint.baseURL)
    #expect(RemoteWindowRoute.url(hash: "#bad route", endpoint: endpoint) == endpoint.baseURL)
    #expect(RemoteWindowRoute.route(of: URL(string: "https://[fd7a:115c:a1e0::5]:7443/api/x#/c"), endpoint: endpoint) == nil)
    #expect(RemoteWindowRoute.route(of: URL(string: "https://10.0.0.1:7443/#/c"), endpoint: endpoint) == nil)
    #expect(RemoteWindowRoute.route(of: URL(string: "https://[fd7a:115c:a1e0::5]:7443/%23x#/dm/a%20b"), endpoint: endpoint) == nil)
    #expect(RemoteWindowRoute.route(of: URL(string: "https://[fd7a:115c:a1e0::5]:7443/#/dm/a%20b"), endpoint: endpoint) == "#/dm/a%20b")
  }
}

struct RemoteClientBridgeTests {
  func detail(_ script: String, event: String) throws -> [String: Any] {
    let prefix = "window.dispatchEvent(new CustomEvent(\"\(event)\", {detail: "
    #expect(script.hasPrefix(prefix))
    #expect(script.hasSuffix("}));"))
    let json = script.dropFirst(prefix.count).dropLast(4)
    return try #require(try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
  }

  @Test func readyIsAnsweredWithThePlatform() throws {
    let detail = try detail(RemoteClientBridge.readyReplyJavaScript(), event: bridgeEventName)
    #expect(detail["command"] as? String == "ready")
    #expect(detail["platform"] as? String == "ios")
  }

  @Test func terminalStatusCarriesThePlatform() throws {
    let status = try detail(RemoteClientBridge.javaScript(for: .status(tmux: .available, broker: .connected)), event: bridgeTerminalEventName)
    #expect(status["type"] as? String == "terminal-status")
    #expect(status["platform"] as? String == "ios")
    #expect(status["broker"] as? String == "connected")
    let exit = try detail(RemoteClientBridge.javaScript(for: .exit(stream: 3, status: nil)), event: bridgeTerminalEventName)
    #expect(exit["platform"] == nil)
    #expect(exit["stream"] as? Int == 3)
  }
}

struct RemoteTerminalPolicyTests {
  let session = SessionName("hm-acme-atlas")!

  func launch(cwd: String?) -> TerminalSessionLaunch {
    TerminalSessionLaunch(project: "acme", agent: "Atlas", title: "Acme - Atlas", cwd: cwd, command: "claude")!
  }

  @Test func launchesNeverOpenTerminalApp() {
    let launches = [launch(cwd: "/Users/anna/acme"), launch(cwd: "~/acme")]
    #expect(RemoteTerminalPolicy.decide(.terminalLaunch(id: "t1", launches: launches, openInTerminal: true), home: "/Users/anna")
      == .forward(.terminalLaunch(id: "t1", launches: launches, openInTerminal: false)))
  }

  @Test func terminalOpenIsAnsweredOnTheDevice() {
    #expect(RemoteTerminalPolicy.decide(.terminalOpen(session: session), home: "/Users/anna")
      == .answer(.error(id: nil, code: .internal, message: RemoteTerminalPolicy.terminalAppMessage, stream: nil)))
  }

  @Test func withoutTheMacsHomeOnlyAbsoluteFoldersLaunch() {
    let absolute = [launch(cwd: "/Users/anna/acme")]
    #expect(RemoteTerminalPolicy.decide(.terminalLaunch(id: nil, launches: absolute, openInTerminal: false), home: nil)
      == .forward(.terminalLaunch(id: nil, launches: absolute, openInTerminal: false)))
    for cwd in [nil, "~", "~/acme"] as [String?] {
      let decision = RemoteTerminalPolicy.decide(.terminalLaunch(id: "t2", launches: absolute + [launch(cwd: cwd)], openInTerminal: false), home: nil)
      #expect(decision == .answer(.error(id: "t2", code: .badMessage, message: RemoteTerminalPolicy.noHomeMessage, stream: nil)))
    }
  }

  @Test func everythingElseIsForwarded() {
    for message: BridgeMessage in [.sessionsSubscribe, .terminalKill(id: "k", session: session), .terminalDetach(stream: 1)] {
      #expect(RemoteTerminalPolicy.decide(message, home: nil) == .forward(message))
    }
  }

  /// The router expands "~" against the Mac's home, never the device's.
  @MainActor
  @Test func theRouterLaunchesInTheMacsHome() {
    final class Client: BrokerClienting {
      var status = BrokerClientStatus(connection: .connected, tmuxPath: "/opt/homebrew/bin/tmux")
      var onStatusChange: (@MainActor (BrokerClientStatus) -> Void)?
      var onEvent: (@MainActor (BrokerEvent) -> Void)?
      var sent: [BrokerRequest] = []
      func start() {}
      func stop() {}
      func retryNow() {}
      func send(_ request: BrokerRequest, reply: (@MainActor (BrokerEvent) -> Void)?) { sent.append(request) }
      func setSessionsSubscribed(_ subscribed: Bool) {}
      func setReading(_ reading: Bool) {}
    }
    let client = Client()
    var opened = 0
    let router = TerminalBridgeRouter(client: client, environment: .init(
      home: "/Users/anna", tmuxConfigPath: "", deliver: { _ in }, openTerminals: { _ in opened += 1 }, scheduler: FakeScheduler()))
    guard case .forward(let message) = RemoteTerminalPolicy.decide(.terminalLaunch(id: nil, launches: [launch(cwd: "~/acme")], openInTerminal: true), home: "/Users/anna") else {
      Issue.record("not forwarded"); return
    }
    router.handle(message)
    guard case .launch(let launches)? = client.sent.first else { Issue.record("no launch"); return }
    #expect(launches.map(\.cwd) == ["/Users/anna/acme"])
    #expect(opened == 0)
  }
}

struct RemoteBadgeAggregatorTests {
  @Test func maxPerMacSumAcrossMacs() {
    var badge = RemoteBadgeAggregator()
    let studio = UUID(), laptop = UUID()
    badge.set(3, scene: "a", mac: studio)
    badge.set(5, scene: "b", mac: studio)
    badge.set(2, scene: "c", mac: laptop)
    #expect(badge.count == 7)
    badge.remove(scene: "b")
    #expect(badge.count == 5)
    badge.set(-4, scene: "a", mac: studio)
    #expect(badge.count == 2)
    badge.remove(mac: laptop)
    #expect(badge.count == 0)
  }
}

struct RemoteConnectScreenTests {
  @Test func problemsFromErrors() {
    #expect(RemoteConnectionProblem(.unreachable("timed out")) == .unreachable("timed out"))
    #expect(RemoteConnectionProblem(.pinMismatch) == .pinMismatch)
    #expect(RemoteConnectionProblem(.gateway(GatewayError(.unauthorized, "x"))) == .revoked)
    #expect(RemoteConnectionProblem(.gateway(GatewayError(.deviceRevoked, "x"))) == .revoked)
    #expect(RemoteConnectionProblem(.gateway(GatewayError(.serverUnverified, "x"))) == .serverUnverified)
    #expect(RemoteConnectionProblem(.gateway(GatewayError(.serverUnavailable, "x"))) == .serverStopped)
    #expect(RemoteConnectionProblem(.gateway(GatewayError(.tooLarge, "Too large."))) == .other("Too large."))
    guard case .other = RemoteConnectionProblem(.gateway(GatewayError(.rateLimited, "x"))) else { Issue.record("rate limit"); return }
  }

  @Test func whatTheScreenOffers() {
    let connecting = RemoteConnectScreenContent(problem: nil, macName: "Studio")
    #expect(connecting.title == "Connecting to Studio…")
    #expect(!connecting.offersRetry && !connecting.offersPairAgain)
    let revoked = RemoteConnectScreenContent(problem: .revoked, macName: "Studio")
    #expect(revoked.offersPairAgain && !revoked.offersRetry)
    #expect(revoked.title == "This device was removed from Studio")
    #expect(revoked.detail.hasPrefix("Pair again"))
    let unverified = RemoteConnectScreenContent(problem: .serverUnverified, macName: "Studio")
    #expect(unverified.offersRetry && !unverified.offersPairAgain)
    let pin = RemoteConnectScreenContent(problem: .pinMismatch, macName: "Studio")
    #expect(pin.offersPairAgain && pin.offersRetry)
    let asleep = RemoteConnectScreenContent(problem: .unreachable("timed out"), macName: "Studio")
    #expect(asleep.offersRetry && !asleep.offersPairAgain)
    #expect(asleep.detail.contains("timed out"))
  }
}

struct RemoteDiscoveryTests {
  let fingerprint = CertificateFingerprint(certificateDER: Data("gateway certificate".utf8))

  @Test func readsAnAdvertisement() {
    let txt = GatewayAdvertisement(fingerprint: fingerprint, name: "Studio Mac").txtRecord
    let nearby = RemoteDiscovery.nearbyMac(serviceName: "Studio Mac (Hivemind)", txtRecord: txt)
    #expect(nearby?.name == "Studio Mac")
    #expect(nearby?.advertisement.fingerprint == fingerprint)
    #expect(nearby?.id == "Studio Mac (Hivemind)")
    var newer = txt
    newer["v"] = "2"
    #expect(RemoteDiscovery.nearbyMac(serviceName: "x", txtRecord: newer) == nil)
    #expect(RemoteDiscovery.nearbyMac(serviceName: "x", txtRecord: ["v": "1", "name": "Studio"]) == nil)
  }

  @Test func onlyPrivateAddressesAWebViewCanLoad() {
    #expect(RemoteDiscovery.endpoint(host: "192.168.1.20", port: 7443)?.origin == "https://192.168.1.20:7443")
    #expect(RemoteDiscovery.endpoint(host: "100.101.102.103", port: 7443) != nil)
    #expect(RemoteDiscovery.endpoint(host: "fd7a:115c:a1e0::5%utun4", port: 7443)?.origin == "https://[fd7a:115c:a1e0::5]:7443")
    #expect(RemoteDiscovery.endpoint(host: "::ffff:10.0.0.4", port: 7443)?.host == "10.0.0.4")
    #expect(RemoteDiscovery.endpoint(host: "fe80::1%en0", port: 7443) == nil)
    #expect(RemoteDiscovery.endpoint(host: "8.8.8.8", port: 7443) == nil)
    #expect(RemoteDiscovery.endpoint(host: "127.0.0.1", port: 7443) == nil)
    #expect(RemoteDiscovery.endpoint(host: "studio.local", port: 7443) == nil)
    #expect(RemoteDiscovery.endpoint(host: "10.0.0.4", port: 0) == nil)
  }
}

struct RemoteNoticePolicyTests {
  @Test func conversationsFromRoutes() {
    #expect(RemoteNoticePolicy.conversation("#/c/general") == "general")
    #expect(RemoteNoticePolicy.conversation("#/c/general/t/m1") == "general/t/m1")
    #expect(RemoteNoticePolicy.conversation("#/for-you/acme") == nil)
    #expect(RemoteNoticePolicy.conversation("#/c/") == nil)
    #expect(RemoteNoticePolicy.conversation(nil) == nil)
  }

  @Test func onlyTheOpenConversationIsQuiet() {
    let open: [String?] = ["#/c/general", nil, "#/inbox/acme"]
    #expect(RemoteNoticePolicy.isAboutOpenConversation(target: "#/c/general", openRoutes: open))
    // A reply in a thread that is not open, another channel, a notice without a target: shown.
    #expect(!RemoteNoticePolicy.isAboutOpenConversation(target: "#/c/general/t/m1", openRoutes: open))
    #expect(!RemoteNoticePolicy.isAboutOpenConversation(target: "#/c/dm-atlas", openRoutes: open))
    #expect(!RemoteNoticePolicy.isAboutOpenConversation(target: nil, openRoutes: open))
    #expect(RemoteNoticePolicy.isAboutOpenConversation(target: "#/c/general/t/m1", openRoutes: ["#/c/general/t/m1"]))
    #expect(!RemoteNoticePolicy.isAboutOpenConversation(target: "#/c/general", openRoutes: []))
  }
}
