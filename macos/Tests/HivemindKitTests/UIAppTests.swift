import Foundation
import Testing
@testable import HivemindKit

// The UI app's pure logic. No web view, socket or real home folder: health
// checks answer from a table keyed by port.

private struct PortTableHTTP: HTTPGetting {
  enum Answer: Sendable { case hivemind, other, refused }
  var answers: [Int: Answer]

  func get(_ url: URL, timeout: TimeInterval) async throws -> (status: Int, body: Data) {
    switch answers[url.port ?? 80] ?? .refused {
    case .hivemind: return (200, Data(#"{"ok":true,"name":"hivemind"}"#.utf8))
    case .other: return (200, Data("<html>".utf8))
    case .refused: throw URLError(.cannotConnectToHost)
    }
  }
}

private func endpoint(_ port: Int) -> ServerEndpoint { ServerEndpoint(port: ServerPort(port)!) }

struct UIServerLocatorTests {
  fileprivate func locator(discoveryPort: Int?, alive: Bool = true, answers: [Int: PortTableHTTP.Answer]) throws -> UIServerLocator {
    let store = DiscoveryStore(paths: HivemindPaths(home: try temporaryHome()))
    if let discoveryPort {
      try store.write(ServerDiscovery(
        port: ServerPort(discoveryPort)!, pid: 4242, home: "/h/.hivemind", startedAt: Date(), version: "0.5.0"))
    }
    let http = PortTableHTTP(answers: answers)
    return UIServerLocator(discovery: store, health: HealthChecker(http: http), verifier: InstanceVerifier(http: http),
                           isAlive: { _ in alive })
  }

  @Test func candidatesPutTheLiveDiscoveryFirstWithoutRepeats() throws {
    #expect(try locator(discoveryPort: 7421, answers: [:]).candidates(configuredPort: ServerPort(7500)).map(\.endpoint)
      == [endpoint(7421), endpoint(7500), endpoint(7420)])
    #expect(try locator(discoveryPort: 7420, answers: [:]).candidates(configuredPort: .default).map(\.endpoint) == [endpoint(7420)])
    // A dead server's discovery file is ignored.
    #expect(try locator(discoveryPort: 7421, alive: false, answers: [:]).candidates(configuredPort: nil).map(\.endpoint)
      == [endpoint(7420)])
  }

  /// Health alone never connects (InstanceVerificationTests has the
  /// verified cases): the first server that answers is only `unverified`.
  @Test func theFirstHealthyCandidateIsOnlyUnverified() async throws {
    let found = try locator(discoveryPort: 7421, answers: [7421: .refused, 7420: .hivemind])
    #expect(await found.resolve(configuredPort: nil) == .unverified(endpoint(7420), .notStartedByServerApp))
    let discovered = try locator(discoveryPort: 7421, answers: [7421: .hivemind, 7420: .hivemind])
    #expect(await discovered.resolve(configuredPort: nil) == .unverified(endpoint(7421), .failed(.noSecret)))
  }

  @Test func reportsHowTheFirstCandidateFailed() async throws {
    let refused = try locator(discoveryPort: nil, answers: [7420: .other])
    if case .unreachable(let at, _) = await refused.resolve(configuredPort: ServerPort(7500)) {
      #expect(at == endpoint(7500))
    } else {
      Issue.record("expected unreachable")
    }
    let foreign = try locator(discoveryPort: nil, answers: [7420: .other])
    #expect(await foreign.resolve(configuredPort: nil) == .foreign(endpoint(7420)))
  }
}

struct ConnectScreenContentTests {
  @Test func offersTheServerAppOnlyWhenInstalledAndUseful() {
    let down = UIConnectionState.unreachable(endpoint(7420), reason: "refused")
    #expect(ConnectScreenContent(state: down, serverAppInstalled: true).offersServerApp)
    #expect(!ConnectScreenContent(state: down, serverAppInstalled: false).offersServerApp)
    #expect(!ConnectScreenContent(state: .checking(endpoint(7420)), serverAppInstalled: true).offersServerApp)
    #expect(ConnectScreenContent(state: down, serverAppInstalled: false).detail.contains("127.0.0.1:7420"))
    #expect(ConnectScreenContent(state: .foreign(endpoint(8080)), serverAppInstalled: true).title == "Port 8080 is taken")
  }
}

struct UIMenuCommandTests {
  @Test func shortcutsAreTheSpecifiedOnesAndUnique() {
    #expect(UIMenuCommand.settings.shortcut == MenuShortcut(","))
    #expect(UIMenuCommand.newWindow.shortcut == MenuShortcut("n"))
    #expect(UIMenuCommand.newChannel.shortcut == MenuShortcut("n", [.command, .shift]))
    #expect(UIMenuCommand.closeWindow.shortcut == MenuShortcut("w"))
    #expect(UIMenuCommand.reload.shortcut == MenuShortcut("r"))
    #expect(UIMenuCommand.jump.shortcut == MenuShortcut("k"))
    #expect(UIMenuCommand.forYou.shortcut == MenuShortcut("i", [.command, .shift]))
    let shortcuts = UIMenuCommand.allCases.compactMap(\.shortcut)
    #expect(Set(shortcuts).count == shortcuts.count)
    // Shift is a modifier, never an uppercase key.
    #expect(shortcuts.allSatisfy { $0.key == $0.key.lowercased() })
  }

  @Test func pageCommandsMapOntoTheBridge() {
    #expect(UIMenuCommand.jump.bridgeCommand == .jump)
    #expect(UIMenuCommand.forYou.bridgeCommand == .forYou)
    #expect(UIMenuCommand.newChannel.bridgeCommand == .newChannel)
    #expect(UIMenuCommand.settings.bridgeCommand == .settings)
    #expect(UIMenuCommand.toggleTheme.bridgeCommand == .toggleTheme)
    for command in [UIMenuCommand.newWindow, .closeWindow, .reload, .actualSize, .zoomIn, .zoomOut, .back, .forward, .help] {
      #expect(command.bridgeCommand == nil)
    }
  }
}

struct PageZoomTests {
  @Test func stepsAlongTheLadderAndStopsAtTheEnds() {
    #expect(PageZoom.zoomIn(from: 1) == 1.1)
    #expect(PageZoom.zoomOut(from: 1) == 0.9)
    #expect(PageZoom.zoomIn(from: 1.2) == 1.25)
    #expect(PageZoom.zoomOut(from: 1.2) == 1.1)
    #expect(PageZoom.zoomIn(from: 3) == 3)
    #expect(PageZoom.zoomOut(from: 0.5) == 0.5)
    // pageZoom reads back with float noise.
    #expect(PageZoom.zoomIn(from: 1.0999999) == 1.25)
  }

  @Test func clamps() {
    #expect(PageZoom.clamp(.nan) == 1)
    #expect(PageZoom.clamp(0) == 0.5)
    #expect(PageZoom.clamp(9) == 3)
    #expect(PageZoom.clamp(1.3) == 1.3)
  }
}

struct UIWindowStateTests {
  let local = endpoint(7420)

  @Test func keepsOnlyTheRouteOfTheLocalUI() {
    #expect(UIWindowState.route(of: URL(string: "http://127.0.0.1:7420/#/c/ch%201/t/m2"), endpoint: local) == "#/c/ch%201/t/m2")
    #expect(UIWindowState.route(of: URL(string: "http://127.0.0.1:7420/"), endpoint: local) == nil)
    #expect(UIWindowState.route(of: URL(string: "http://127.0.0.1:7420/api/files/x#/c/a"), endpoint: local) == nil)
    #expect(UIWindowState.route(of: URL(string: "http://localhost:7420/#/c/a"), endpoint: local) == nil)
    #expect(UIWindowState.route(of: URL(string: "http://127.0.0.1:7421/#/c/a"), endpoint: local) == nil)
    #expect(UIWindowState.route(of: nil, endpoint: local) == nil)
  }

  @Test func rebuildsTheURLOnWhateverPortTheServerHasNow() {
    let state = UIWindowState(hash: "/c/ch%201", zoom: 1.25)
    #expect(state.hash == "#/c/ch%201")
    // hashFor's percent-encoding is kept, not doubled.
    #expect(state.url(endpoint: endpoint(7421)).absoluteString == "http://127.0.0.1:7421/#/c/ch%201")
    #expect(UIWindowState().url(endpoint: local).absoluteString == "http://127.0.0.1:7420/")
  }

  @Test func restoredValuesAreSanitized() {
    #expect(UIWindowState(hash: "#/c/a b").hash == nil)
    #expect(UIWindowState(hash: "#").hash == nil)
    #expect(UIWindowState(zoom: 40).zoom == 3)
  }
}

// #expect cannot call a mutating member, hence the local helpers.
struct BridgeOutboxTests {
  @Test func queuesUntilReadyThenDeliversDirectly() {
    var outbox = BridgeOutbox()
    func send(_ command: BridgeCommand) -> [BridgeCommand] { outbox.send(command) }
    func ready() -> [BridgeCommand] { outbox.ready() }
    #expect(send(.jump).isEmpty)
    #expect(send(.forYou).isEmpty)
    #expect(ready() == [.jump, .forYou])
    #expect(send(.settings) == [.settings])
  }

  @Test func aNewPageWaitsForItsOwnReady() {
    var outbox = BridgeOutbox()
    _ = outbox.ready()
    outbox.pageWillLoad()
    let sent = outbox.send(.newChannel)
    #expect(sent.isEmpty)
    let flushed = outbox.ready()
    #expect(flushed == [.newChannel])
  }

  @Test func onlyTheLatestNavigationSurvives() {
    var outbox = BridgeOutbox()
    _ = outbox.send(.navigate(hash: "#/a"))
    _ = outbox.send(.jump)
    _ = outbox.send(.navigate(hash: "#/b"))
    let flushed = outbox.ready()
    #expect(flushed == [.jump, .navigate(hash: "#/b")])
  }

  @Test func isBoundedAndDiscardable() {
    var outbox = BridgeOutbox()
    for _ in 0..<40 { _ = outbox.send(.toggleTheme) }
    _ = outbox.send(.jump)
    let flushed = outbox.ready()
    #expect(flushed.count == BridgeOutbox.capacity)
    #expect(flushed.last == .jump)
    _ = outbox.send(.jump)
    outbox.discard()
    #expect(!outbox.isReady)
    let after = outbox.ready()
    #expect(after.isEmpty)
  }
}

struct BadgeAggregatorTests {
  @Test func showsTheHighestOpenWindow() {
    var badge = BadgeAggregator<String>()
    #expect(badge.count == 0)
    badge.set(3, for: "a")
    badge.set(0, for: "b")
    #expect(badge.count == 3)
    badge.set(-2, for: "a")
    #expect(badge.count == 0)
    badge.set(5, for: "b")
    badge.remove("b")
    #expect(badge.count == 0)
    #expect(dockBadgeLabel(count: badge.count) == nil)
  }
}

struct BridgeOriginGateTests {
  let local = endpoint(7420)

  @Test func acceptsOnlyTheLocalMainFrame() {
    #expect(BridgeOriginGate.accepts(isMainFrame: true, scheme: "http", host: "127.0.0.1", port: 7420, endpoint: local))
    #expect(!BridgeOriginGate.accepts(isMainFrame: false, scheme: "http", host: "127.0.0.1", port: 7420, endpoint: local))
    #expect(!BridgeOriginGate.accepts(isMainFrame: true, scheme: "https", host: "127.0.0.1", port: 7420, endpoint: local))
    #expect(!BridgeOriginGate.accepts(isMainFrame: true, scheme: "http", host: "localhost", port: 7420, endpoint: local))
    #expect(!BridgeOriginGate.accepts(isMainFrame: true, scheme: "http", host: "127.0.0.1", port: 7421, endpoint: local))
    #expect(!BridgeOriginGate.accepts(isMainFrame: true, scheme: "http", host: "127.0.0.1", port: 0, endpoint: local))
    #expect(BridgeOriginGate.accepts(isMainFrame: true, scheme: "http", host: "127.0.0.1", port: 0, endpoint: endpoint(80)))
  }
}

struct UIAppNavigationTests {
  let local = endpoint(7420)

  @Test func framesOnlyLeaveForTheBrowserOnAClick() {
    let external = URL(string: "https://example.com/")!
    #expect(UIAppNavigation.decide(external, endpoint: local, isMainFrame: true, userActivated: false) == .openExternally)
    #expect(UIAppNavigation.decide(external, endpoint: local, isMainFrame: false, userActivated: true) == .openExternally)
    #expect(UIAppNavigation.decide(external, endpoint: local, isMainFrame: false, userActivated: false) == .deny)
    #expect(UIAppNavigation.decide(URL(string: "http://127.0.0.1:7420/#/x")!, endpoint: local, isMainFrame: false, userActivated: false) == .allow)
    #expect(UIAppNavigation.decide(URL(string: "file:///etc/passwd")!, endpoint: local, isMainFrame: true, userActivated: true) == .deny)
  }
}

struct UIAppNoticeTests {
  @Test func roundTripsItsDestinationThroughUserInfo() {
    let notice = UIAppNotice(title: "Ada", body: "hi", tag: "m1", target: "/c/general/t/m1", windowID: "w1")
    #expect(notice.target == "#/c/general/t/m1")
    #expect(notice.identifier() == "hivemind.notice.m1")
    let info: [AnyHashable: Any] = notice.userInfo
    let destination = UIAppNotice.destination(userInfo: info)
    #expect(destination.target == "#/c/general/t/m1")
    #expect(destination.windowID == "w1")
  }

  @Test func untaggedNoticesNeverCollideAndBadTargetsAreDropped() {
    let notice = UIAppNotice(title: "t", body: "", tag: nil, target: "#/a b", windowID: nil)
    #expect(notice.target == nil)
    #expect(notice.userInfo.isEmpty)
    #expect(notice.identifier(fallback: "x") == "hivemind.notice.x")
    #expect(UIAppNotice.destination(userInfo: ["target": "#/a\nb", "window": 3]).target == nil)
    #expect(UIAppNotice.destination(userInfo: ["window": 3]).windowID == nil)
  }

  @Test func deduperDropsCopiesAndForgetsTheOldest() {
    var deduper = NoticeDeduper(capacity: 2)
    func admit(_ tag: String?) -> Bool { deduper.admit(tag: tag) }
    #expect(admit("a"))
    #expect(!admit("a"))
    #expect(admit(nil))
    #expect(admit(nil))
    #expect(admit("b"))
    #expect(admit("c"))
    // "a" fell out of the window of remembered tags.
    #expect(admit("a"))
    #expect(!admit("a"))
  }
}

struct DownloadNamingTests {
  let directory = URL(fileURLWithPath: "/Users/h/Downloads", isDirectory: true)

  @Test func sanitizesSuggestedNames() {
    #expect(DownloadNaming.sanitized("report.pdf") == "report.pdf")
    #expect(DownloadNaming.sanitized("../../etc/passwd") == "_.._etc_passwd")
    #expect(DownloadNaming.sanitized(".hidden") == "hidden")
    #expect(DownloadNaming.sanitized("a\u{0}b:c") == "a_b_c")
    #expect(DownloadNaming.sanitized("  ") == "download")
    #expect(DownloadNaming.sanitized("...") == "download")
    // Cut by UTF-8 bytes (NAME_MAX is 255), at a character, keeping the extension.
    let long = DownloadNaming.sanitized(String(repeating: "é", count: 300) + ".pdf")
    #expect(long.utf8.count <= 200)
    #expect(long.hasSuffix("é.pdf"))
    #expect(DownloadNaming.sanitized(String(repeating: "a", count: 250)).utf8.count == 200)
  }

  @Test func numbersNamesThatAreTaken() {
    let taken: Set<String> = ["/Users/h/Downloads/log.json", "/Users/h/Downloads/log 2.json", "/Users/h/Downloads/notes"]
    let exists: (URL) -> Bool = { taken.contains($0.path) }
    #expect(DownloadNaming.destination(in: directory, suggested: "new.txt", exists: exists).lastPathComponent == "new.txt")
    #expect(DownloadNaming.destination(in: directory, suggested: "log.json", exists: exists).lastPathComponent == "log 3.json")
    #expect(DownloadNaming.destination(in: directory, suggested: "notes", exists: exists).lastPathComponent == "notes 2")
  }
}
