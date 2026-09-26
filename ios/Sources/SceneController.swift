import HivemindKit
import Observation
import UIKit
import WebKit

/// One scene (a window on iPad): which Mac it shows, the web view on that
/// Mac's gateway, and the connection screen while the gateway cannot be
/// reached. Like a Hivemind.app window on the Mac, each scene has its own
/// bridge and its own terminal broker connection, so its streams end with it.
@MainActor
@Observable
final class SceneController {
  enum Phase: Equatable {
    /// No Mac chosen (or the chosen one was removed).
    case choosing
    case connecting(UUID)
    case showing(UUID)
    case failed(UUID, RemoteConnectionProblem)
  }

  /// Auto-retry of the connection screen, for problems that can go away.
  static let retryInterval: Duration = .seconds(5)

  let windowID: String
  private(set) var phase = Phase.choosing
  /// Bumped for every new web view, so the view hosting it swaps it in.
  private(set) var webViewGeneration = 0
  var showingMacs = false
  var showingPairing = false
  /// A hivemind-pair:// link opened from outside the app (the Camera, say):
  /// the pairing screen shows it for confirmation, never pairs by itself.
  var pairingLink: String?
  /// A same-origin page the UI opened in a new window (an attachment),
  /// shown in a sheet with a web view of its own.
  var auxiliary: AuxiliaryPage?
  /// The hash route to reopen at; the scene's view keeps it in SceneStorage.
  private(set) var route: String?

  @ObservationIgnored private(set) var webView: WKWebView?
  @ObservationIgnored private weak var model: AppModel?
  @ObservationIgnored private var coordinator: WebCoordinator?
  @ObservationIgnored private var webViewMac: UUID?
  @ObservationIgnored private(set) var endpoint: GatewayEndpoint?
  @ObservationIgnored private var home: String?
  @ObservationIgnored private var terminals: TerminalBridgeRouter?
  @ObservationIgnored private var outbox = BridgeOutbox()
  @ObservationIgnored private var connectTask: Task<Void, Never>?
  @ObservationIgnored private var retryTask: Task<Void, Never>?
  /// One new session and reload per page load when the gateway says 401.
  @ObservationIgnored private var renewedForLoad = false
  @ObservationIgnored private var observations: [NSKeyValueObservation] = []
  @ObservationIgnored var onRouteChange: (String?) -> Void = { _ in }
  @ObservationIgnored private(set) var isClosed = false

  init(windowID: String, route: String?, model: AppModel) {
    self.windowID = windowID
    self.route = route.flatMap(BridgeCommand.validHash)
    self.model = model
    model.register(self)
  }

  var macID: UUID? {
    switch phase {
    case .choosing: nil
    case .connecting(let id), .showing(let id), .failed(let id, _): id
    }
  }

  var isShowingPage: Bool {
    if case .showing = phase { true } else { false }
  }

  // MARK: Connecting

  /// Shows `id`: gets a device session (renewed when due), puts its cookie
  /// into the Mac's data store, then loads the gateway at the saved route.
  func connect(to id: UUID, freshSession: Bool = false) {
    guard let model, model.mac(id) != nil else { return choose() }
    connectTask?.cancel()
    retryTask?.cancel()
    // Another Mac's routes mean nothing here; a restored scene keeps its own.
    if let current = macID, current != id { route = nil }
    model.didUse(id)
    showingMacs = false
    phase = .connecting(id)
    let keeper = model.keeper(for: id)
    if freshSession { keeper.invalidate() }
    connectTask = Task { [weak self] in
      do throws(RemoteClientError) {
        let session = try await keeper.current()
        guard let self, !Task.isCancelled, self.macID == id, let mac = model.mac(id) else { return }
        // The web view first: a data store gets its network session with its
        // first web view, and a cookie set before that can miss the first load.
        let webView = self.ensureWebView(for: mac)
        await model.install(session, for: id)
        guard !Task.isCancelled, self.macID == id, self.webView === webView else { return }
        self.load(session, mac: id)
      } catch {
        guard let self, !Task.isCancelled, self.macID == id else { return }
        self.show(RemoteConnectionProblem(error))
      }
    }
  }

  func retry() {
    guard let macID else { return }
    connect(to: macID)
  }

  func choose() {
    connectTask?.cancel()
    retryTask?.cancel()
    releasePage()
    phase = .choosing
  }

  private func load(_ session: RemoteDeviceSession, mac id: UUID) {
    guard let model, let mac = model.mac(id), let webView, webViewMac == id else { return choose() }
    if terminals == nil { terminals = makeTerminals(for: mac, home: session.home) }
    endpoint = session.endpoint
    home = session.home
    coordinator?.endpoint = session.endpoint
    phase = .showing(id)
    outbox.pageWillLoad()
    webView.load(URLRequest(url: RemoteWindowRoute.url(hash: route, endpoint: session.endpoint)))
  }

  /// The connection screen, retrying by itself while the problem can go away.
  func show(_ problem: RemoteConnectionProblem) {
    guard let macID else { return }
    connectTask?.cancel()
    outbox.discard()
    terminals?.pageDidChange()
    model?.clearBadge(scene: windowID)
    webView?.stopLoading()
    phase = .failed(macID, problem)
    retryTask?.cancel()
    switch problem {
    case .revoked, .pinMismatch: return
    case .unreachable, .serverStopped, .serverUnverified, .other: break
    }
    retryTask = Task { [weak self] in
      try? await Task.sleep(for: Self.retryInterval)
      guard let self, !Task.isCancelled, case .failed(macID, problem) = self.phase,
            UIApplication.shared.applicationState == .active else { return }
      self.connect(to: macID)
    }
  }

  /// The scene came to the front: renew the session (which also finds out
  /// whether the device was revoked meanwhile), retry terminals, and try a
  /// failed connection again. After longer away than a session lasts (the
  /// app reopened after days), the session is renewed with the device token
  /// first and the page loaded again after, so it never runs on an expired
  /// session (docs/remote-access.md#device-sessions).
  func sceneDidBecomeActive() {
    guard let model, let macID else { return }
    switch phase {
    case .failed(_, let problem) where problem != .revoked && problem != .pinMismatch:
      connect(to: macID)
    case .showing where model.keeper(for: macID).isExpired(at: Date()):
      connect(to: macID)
    case .showing:
      terminals?.retry()
      let keeper = model.keeper(for: macID)
      Task { [weak self] in
        do throws(RemoteClientError) {
          _ = try await keeper.sceneDidBecomeActive()
        } catch {
          if error.isRevoked { self?.show(.revoked) }
        }
      }
    default:
      break
    }
  }

  /// The Mac was removed on this device: let go of everything of it.
  func macWasRemoved() {
    choose()
  }

  /// Its view went away (the scene was closed or discarded).
  func close() {
    guard !isClosed else { return }
    isClosed = true
    connectTask?.cancel()
    retryTask?.cancel()
    releasePage()
    model?.unregister(self)
  }

  /// Its view came back after close(): SwiftUI may take a scene's view
  /// away and bring it back without the scene ending.
  func reopen(macID: UUID?) {
    guard isClosed, let model else { return }
    isClosed = false
    model.register(self)
    if let macID = macID ?? model.defaultMacID { connect(to: macID) } else { phase = .choosing }
  }

  /// Drops the web view and everything tied to its page and Mac. The
  /// connect and retry tasks are the caller's business.
  private func releasePage() {
    outbox.discard()
    terminals?.close()
    terminals = nil
    model?.clearBadge(scene: windowID)
    observations.removeAll()
    webView?.stopLoading()
    webView?.configuration.userContentController.removeAllScriptMessageHandlers()
    webView = nil
    webViewMac = nil
    coordinator = nil
    endpoint = nil
    home = nil
    webViewGeneration += 1
  }

  // MARK: Web view

  private func ensureWebView(for mac: PairedMac) -> WKWebView {
    if let webView, webViewMac == mac.id { return webView }
    releasePage()
    guard let model else { fatalError("no model") }
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = model.dataStore(for: mac.id)
    configuration.allowsInlineMediaPlayback = true
    configuration.preferences.isElementFullscreenEnabled = true
    let coordinator = WebCoordinator(scene: self, pin: mac.fingerprint)
    configuration.userContentController.add(WeakScriptMessageHandler(coordinator), contentWorld: .page, name: bridgeHandlerName)
    let webView = WKWebView(frame: .zero, configuration: configuration)
    webView.navigationDelegate = coordinator
    webView.uiDelegate = coordinator
    webView.allowsBackForwardNavigationGestures = true
    // The page does not opt into viewport-fit=cover, so WebKit keeps it
    // inside the safe areas and above the keyboard itself.
    webView.scrollView.contentInsetAdjustmentBehavior = .automatic
    #if DEBUG
    webView.isInspectable = true
    #endif
    observations = [
      webView.observe(\.url) { [weak self] _, _ in
        MainActor.assumeIsolated { self?.urlDidChange() }
      },
      webView.observe(\.title) { [weak self] webView, _ in
        MainActor.assumeIsolated {
          let title = webView.title ?? ""
          webView.window?.windowScene?.title = title.isEmpty ? self?.model?.mac(self?.macID)?.name : title
        }
      },
    ]
    self.webView = webView
    self.coordinator = coordinator
    webViewMac = mac.id
    webViewGeneration += 1
    return webView
  }

  private func makeTerminals(for mac: PairedMac, home: String?) -> TerminalBridgeRouter? {
    guard let model else { return nil }
    let keeper = model.keeper(for: mac.id)
    let configuration = RemoteBrokerConnection.configuration(
      session: { try await keeper.current() },
      invalidate: { keeper.invalidate() },
      makeTask: URLSessionWebSocketTasking.maker(authenticate: ServerTrustPinning.authenticator(pin: mac.fingerprint)))
    let client = BrokerClient(configuration: configuration, scheduler: MainQueueScheduler())
    return TerminalBridgeRouter(client: client, environment: .init(
      home: home ?? RemoteTerminalPolicy.placeholderHome,
      // There is no Terminal.app on the device: RemoteTerminalPolicy turns
      // every launch into one without it, so this is never asked to open one.
      tmuxConfigPath: "",
      deliver: { [weak self] event in self?.evaluate(RemoteClientBridge.javaScript(for: event)) },
      openTerminals: { _ in }))
  }

  private func urlDidChange() {
    guard let endpoint, let url = webView?.url, endpoint.isSameOrigin(url) else { return }
    route = RemoteWindowRoute.route(of: url, endpoint: endpoint)
    onRouteChange(route)
  }

  private func evaluate(_ script: String) {
    webView?.evaluateJavaScript(script, completionHandler: nil)
  }

  /// Sends a command to the page now, or once it says it is ready.
  func send(_ command: BridgeCommand) {
    for ready in outbox.send(command) { evaluate(ready.javaScript) }
  }

  func navigate(to hash: String) {
    guard let hash = BridgeCommand.validHash(hash) else { return }
    route = hash
    onRouteChange(route)
    if outbox.isReady {
      send(.navigate(hash: hash))
    } else if case .showing = phase, let endpoint {
      // A page without the bridge yet (still loading) gets there by URL.
      outbox.pageWillLoad()
      webView?.load(URLRequest(url: RemoteWindowRoute.url(hash: hash, endpoint: endpoint)))
    }
  }

  /// "Start Hivemind Server" from the page: the device cannot start the
  /// Mac's server, but the broker may be back already.
  func retryTerminals() {
    terminals?.retry()
  }

  /// A hivemind-pair:// link: the pairing screen, with the link to confirm.
  func openPairingLink(_ url: URL) {
    pairingLink = url.absoluteString
    showingMacs = false
    // With no Mac yet, the scene shows the pairing screen already.
    if model?.macs.isEmpty == false { showingPairing = true }
  }

  /// Whether this scene's window is in front and showing its page: what a
  /// notice about its conversation would repeat.
  var isInFront: Bool {
    isShowingPage && webView?.window?.windowScene?.activationState == .foregroundActive
  }

  /// Brings this scene's window to the front (a notification was tapped).
  func activate() {
    guard let session = webView?.window?.windowScene?.session else { return }
    UIApplication.shared.requestSceneSessionActivation(session, userActivity: nil, options: nil)
  }

  // MARK: Commands

  func perform(_ command: UIMenuCommand) {
    switch command {
    case .reload:
      if isShowingPage { webView?.reload() } else { retry() }
    case .back: webView?.goBack()
    case .forward: webView?.goForward()
    case .actualSize: setZoom(PageZoom.actualSize)
    case .zoomIn: setZoom(PageZoom.zoomIn(from: Double(webView?.pageZoom ?? 1)))
    case .zoomOut: setZoom(PageZoom.zoomOut(from: Double(webView?.pageZoom ?? 1)))
    case .settings, .newChannel, .toggleTheme, .jump, .forYou:
      guard isShowingPage, let bridge = command.bridgeCommand else { return }
      send(bridge)
    case .newWindow, .closeWindow, .help:
      break
    }
  }

  func canPerform(_ command: UIMenuCommand) -> Bool {
    switch command {
    case .reload: macID != nil
    // Back and Forward are not tracked for the menu; with nowhere to go they do nothing.
    default: isShowingPage
    }
  }

  private func setZoom(_ zoom: Double) {
    webView?.pageZoom = CGFloat(PageZoom.clamp(zoom))
  }

  // MARK: From the web view

  fileprivate func receive(_ message: WKScriptMessage) {
    guard let endpoint, let macID, let model else { return }
    let origin = message.frameInfo.securityOrigin
    guard RemoteBridgeOriginGate.accepts(
      isMainFrame: message.frameInfo.isMainFrame, scheme: origin.protocol, host: origin.host, port: origin.port, endpoint: endpoint),
      let parsed = BridgeMessage(body: message.body) else { return }
    switch parsed {
    case .ready:
      // Which app this is first, so the page knows before any command.
      evaluate(RemoteClientBridge.readyReplyJavaScript())
      for command in outbox.ready() { evaluate(command.javaScript) }
    case .badge(let count):
      model.setBadge(count, scene: windowID, mac: macID)
    case .notify(let title, let body, let tag, let target):
      model.post(UIAppNotice(title: title, body: body, tag: tag, target: target, windowID: windowID), mac: macID)
    case .switchMac:
      // The Settings menu's "Switch Mac…" (shown only in this app).
      showingPairing = false
      showingMacs = true
    case .deviceSessionExpired:
      // The gateway forgot the session (Hivemind Server restarted): a new one
      // now, so the page's own retries find a live cookie.
      let keeper = model.keeper(for: macID)
      Task { await keeper.pageReportedExpiry() }
    default:
      // Terminals, on the Mac's broker through the gateway. No confirmation
      // for a launch, as on the Mac (docs/remote-access.md#threat-model);
      // the router throttles launch, open and kill.
      switch RemoteTerminalPolicy.decide(parsed, home: home) {
      case .forward(let message): terminals?.handle(message)
      case .answer(let event): evaluate(RemoteClientBridge.javaScript(for: event))
      }
    }
  }

  fileprivate func pageDidCommit() {
    // A new document: its bridge listener is not up until it says `ready`,
    // and the old page's terminals go with it.
    outbox.pageWillLoad()
    terminals?.pageDidChange()
  }

  fileprivate func pageDidFinish() {
    renewedForLoad = false
  }

  fileprivate func mainFrameStatus(_ status: Int) -> Bool {
    switch RemoteClientNavigation.mainFrameStatus(status) {
    case .show:
      return true
    case .renewSession:
      guard !renewedForLoad, let macID else { return true }
      renewedForLoad = true
      connect(to: macID, freshSession: true)
      return false
    case .serverStopped:
      show(.serverStopped)
      return false
    case .serverUnverified:
      show(.serverUnverified)
      return false
    }
  }

  fileprivate func loadFailed(_ error: any Error, pinMismatch: Bool) {
    guard case .showing = phase else { return }
    if pinMismatch { return show(.pinMismatch) }
    let error = error as NSError
    // Only the network failing counts. -999 is a cancel (ours, or a newer
    // load); WebKit's own errors (a navigation that became a download) are
    // not in this domain.
    guard error.domain == NSURLErrorDomain, error.code != NSURLErrorCancelled else { return }
    // The session is bound to the host that issued it, which just did not
    // answer: the next attempt asks every host (and Bonjour, resolved
    // afresh in case the Mac's port changed) for a new one.
    if let macID, let model {
      model.keeper(for: macID).invalidate()
      model.connectionFailed(macID)
    }
    show(.unreachable(error.localizedDescription))
  }

  fileprivate func contentProcessDidTerminate() {
    guard let macID, case .showing = phase else { return }
    connect(to: macID)
  }
}

/// A page shown in a sheet: an attachment the UI opened with target=_blank.
struct AuxiliaryPage: Identifiable {
  let id = UUID()
  let url: URL
  let macID: UUID
  let pin: CertificateFingerprint
  let endpoint: GatewayEndpoint
}

// MARK: - Delegates

/// The web view's delegates for one scene: pinning, the navigation policy,
/// downloads, dialogs and the bridge. Kept apart from SceneController so
/// WebKit's retained handlers never keep the scene alive.
@MainActor
final class WebCoordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, BridgeReceiving {
  weak var scene: SceneController?
  let pin: CertificateFingerprint
  var endpoint: GatewayEndpoint?
  /// A challenge for the gateway's host failed the pin during this load.
  private var pinMismatch = false
  private let downloads = DownloadPresenter()

  init(scene: SceneController, pin: CertificateFingerprint) {
    self.scene = scene
    self.pin = pin
  }

  func receive(_ message: WKScriptMessage) {
    scene?.receive(message)
  }

  func webView(
    _ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping @MainActor @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    guard let endpoint else { return completionHandler(.cancelAuthenticationChallenge, nil) }
    let outcome = ServerTrustPinning.evaluate(challenge, pin: pin, host: endpoint.host)
    if outcome.mismatch { pinMismatch = true }
    completionHandler(outcome.disposition, outcome.credential)
  }

  func webView(
    _ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
    decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
  ) {
    if action.shouldPerformDownload { return decisionHandler(.download) }
    guard let url = action.request.url, let endpoint else { return decisionHandler(.cancel) }
    // "Start Hivemind Server" from a terminal notice: a device cannot start
    // the Mac's server; try the broker again instead.
    if ServerAppURLCommand(url: url) == .start {
      scene?.retryTerminals()
      return decisionHandler(.cancel)
    }
    let decision = RemoteClientNavigation.decide(
      url, endpoint: endpoint, isMainFrame: action.targetFrame?.isMainFrame ?? true,
      userActivated: action.navigationType == .linkActivated)
    switch decision {
    case .allow:
      if action.targetFrame?.isMainFrame ?? true { pinMismatch = false }
      decisionHandler(.allow)
    case .openExternally:
      UIApplication.shared.open(url)
      decisionHandler(.cancel)
    case .deny:
      decisionHandler(.cancel)
    }
  }

  func webView(
    _ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
    decisionHandler: @escaping @MainActor @Sendable (WKNavigationResponsePolicy) -> Void
  ) {
    let http = response.response as? HTTPURLResponse
    if response.isForMainFrame, let http, let scene, !scene.mainFrameStatus(http.statusCode) {
      return decisionHandler(.cancel)
    }
    let disposition = http?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
    let attachment = disposition.lowercased().hasPrefix("attachment")
    decisionHandler(response.canShowMIMEType && !attachment ? .allow : .download)
  }

  func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
    scene?.pageDidCommit()
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    scene?.pageDidFinish()
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
    scene?.loadFailed(error, pinMismatch: pinMismatch)
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) {
    scene?.loadFailed(error, pinMismatch: pinMismatch)
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    scene?.contentProcessDidTerminate()
  }

  func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
    download.delegate = self
  }

  func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
    download.delegate = self
  }

  // MARK: WKUIDelegate

  /// target=_blank and window.open: the UI itself stays in this scene (at
  /// that route); another page of the gateway opens in a sheet; anything
  /// else goes to Safari.
  func webView(
    _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
    for action: WKNavigationAction, windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    guard let url = action.request.url, let endpoint, let scene, let macID = scene.macID else { return nil }
    if endpoint.isSameOrigin(url), url.scheme?.lowercased() == "https" {
      if url.path.isEmpty || url.path == "/" {
        if let route = RemoteWindowRoute.route(of: url, endpoint: endpoint) { scene.navigate(to: route) }
      } else {
        scene.auxiliary = AuxiliaryPage(url: url, macID: macID, pin: pin, endpoint: endpoint)
      }
    } else if RemoteClientNavigation.decide(url, endpoint: endpoint, isMainFrame: true, userActivated: true) == .openExternally {
      UIApplication.shared.open(url)
    }
    return nil
  }

  func webView(
    _ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
    completionHandler: @escaping @MainActor @Sendable () -> Void
  ) {
    let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
    alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
    guard Presenter.present(alert, from: webView) else { return completionHandler() }
  }

  func webView(
    _ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
    completionHandler: @escaping @MainActor @Sendable (Bool) -> Void
  ) {
    let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
    alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(false) })
    alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
    guard Presenter.present(alert, from: webView) else { return completionHandler(false) }
  }

  func webView(
    _ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
    initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor @Sendable (String?) -> Void
  ) {
    let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
    alert.addTextField { $0.text = defaultText }
    alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in completionHandler(nil) })
    alert.addAction(UIAlertAction(title: "OK", style: .default) { [weak alert] _ in completionHandler(alert?.textFields?.first?.text ?? "") })
    guard Presenter.present(alert, from: webView) else { return completionHandler(nil) }
  }

  // MARK: WKDownloadDelegate

  func download(
    _ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String,
    completionHandler: @escaping @MainActor @Sendable (URL?) -> Void
  ) {
    completionHandler(downloads.destination(for: download, suggestedFilename: suggestedFilename))
  }

  func download(
    _ download: WKDownload, didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping @MainActor @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    guard let endpoint else { return completionHandler(.cancelAuthenticationChallenge, nil) }
    let outcome = ServerTrustPinning.evaluate(challenge, pin: pin, host: endpoint.host)
    completionHandler(outcome.disposition, outcome.credential)
  }

  func downloadDidFinish(_ download: WKDownload) {
    guard let webView = download.webView else { return }
    downloads.finished(download, from: webView)
  }

  func download(_ download: WKDownload, didFailWithError error: any Error, resumeData: Data?) {
    downloads.failed(download)
  }
}

/// What WeakScriptMessageHandler forwards to.
@MainActor
protocol BridgeReceiving: AnyObject {
  func receive(_ message: WKScriptMessage)
}

/// WKUserContentController retains its handlers; this keeps it from
/// retaining the coordinator (and the scene) in a cycle.
final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
  weak var owner: (any BridgeReceiving)?

  init(_ owner: any BridgeReceiving) { self.owner = owner }

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    MainActor.assumeIsolated { owner?.receive(message) }
  }
}

/// Presents UIKit controllers over whatever the web view's window shows.
@MainActor
enum Presenter {
  @discardableResult
  static func present(_ controller: UIViewController, from view: UIView) -> Bool {
    guard var top = view.window?.rootViewController else { return false }
    while let presented = top.presentedViewController, !presented.isBeingDismissed { top = presented }
    if let popover = controller.popoverPresentationController {
      popover.sourceView = view
      popover.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
      popover.permittedArrowDirections = []
    }
    top.present(controller, animated: true)
    return true
  }
}

/// Downloads land in a private temporary folder, then go to the share
/// sheet (Save to Files, AirDrop, another app). The file is deleted when
/// the sheet closes.
@MainActor
final class DownloadPresenter {
  private var destinations: [ObjectIdentifier: URL] = [:]

  func destination(for download: WKDownload, suggestedFilename: String) -> URL? {
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("Downloads/\(UUID().uuidString)", isDirectory: true)
    guard (try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)) != nil else { return nil }
    let url = folder.appendingPathComponent(Self.fileName(suggestedFilename))
    destinations[ObjectIdentifier(download)] = url
    return url
  }

  /// The server's suggested name, kept inside its folder.
  static func fileName(_ suggested: String) -> String {
    let name = (suggested as NSString).lastPathComponent
    return name.isEmpty || name == "." || name == ".." || name == "/" ? "download" : name
  }

  func finished(_ download: WKDownload, from view: UIView) {
    guard let url = destinations.removeValue(forKey: ObjectIdentifier(download)) else { return }
    let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
    sheet.completionWithItemsHandler = { _, _, _, _ in
      try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
    }
    if !Presenter.present(sheet, from: view) { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
  }

  func failed(_ download: WKDownload) {
    guard let url = destinations.removeValue(forKey: ObjectIdentifier(download)) else { return }
    try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
  }
}
