import AppKit
import HivemindKit
import WebKit

/// One Hivemind window: a WKWebView on the local server, or the connect
/// screen while none answers. Every web view uses WKWebsiteDataStore.default,
/// so all windows share one Human session cookie.
@MainActor
final class BrowserWindowController: NSWindowController, NSWindowDelegate, NSMenuItemValidation {
  let id = UUID().uuidString
  /// False for a window showing a single same-origin page (an attachment):
  /// it has no connect screen, bridge or restoration.
  let isPrimary: Bool

  private unowned let app: HivemindApp
  private let webView: WKWebView
  private let connectView = ConnectView()
  private var outbox = BridgeOutbox()
  private var connection: UIConnectionState
  /// The hash route to reopen at; follows the page as the user moves around.
  private var route: String?
  /// A resolve is in flight; only the latest one's answer is used.
  private var resolving = false
  private var resolveGeneration = 0
  private var retryTimer: Timer?
  /// While a page shows: watches the discovery file for a stopped,
  /// restarted or replaced server (docs/macos.md#verifying-the-server).
  private var trustTimer: Timer?
  private var trustWatch = ServerTrustWatch()
  /// The server the user chose "Open without terminals" for in this window.
  private var acceptedUnverified: ServerEndpoint?
  /// Terminal messages reach `terminals` only through this.
  private var gate = TerminalTrustGate()
  /// The page load this window started right after verifying the server:
  /// its document may use terminals. Any other document is checked first.
  private var verifiedNavigation: WKNavigation?
  private var observations: [NSKeyValueObservation] = []
  private var isClosed = false
  /// This window's terminals (docs/terminal-broker.md#bridge): its own
  /// broker connection, so its streams end with it. Primary windows only;
  /// the others have no bridge.
  private var terminals: TerminalBridgeRouter?

  static let retryInterval: TimeInterval = 2
  static let windowIdentifier = NSUserInterfaceItemIdentifier("hivemind.browser")

  convenience init(app: HivemindApp, state: UIWindowState) {
    self.init(app: app, primary: true, zoom: state.zoom, connection: .checking(ServerEndpoint(port: app.configuredPort ?? .default)))
    route = state.hash
    connect()
  }

  convenience init(app: HivemindApp, auxiliaryURL: URL, endpoint: ServerEndpoint, zoom: Double) {
    // No bridge in an auxiliary window, so nothing here needs the server verified.
    self.init(app: app, primary: false, zoom: zoom, connection: .connected(endpoint, .unverified))
    showWebView()
    webView.load(URLRequest(url: auxiliaryURL))
  }

  private init(app: HivemindApp, primary: Bool, zoom: Double, connection: UIConnectionState) {
    self.app = app
    self.isPrimary = primary
    self.connection = connection

    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .default()
    configuration.preferences.isElementFullscreenEnabled = true
    webView = WKWebView(frame: .zero, configuration: configuration)
    webView.pageZoom = PageZoom.clamp(zoom)
    webView.allowsBackForwardNavigationGestures = true
    webView.allowsMagnification = false
    if #available(macOS 13.3, *) { webView.isInspectable = UserDefaults.standard.bool(forKey: UIAppSettingsKey.webInspector) }

    let window = NSWindow(
      contentRect: NSRect(x: 0, y: 0, width: 1200, height: 800),
      styleMask: [.titled, .closable, .miniaturizable, .resizable],
      backing: .buffered, defer: false)
    window.title = "Hivemind"
    window.minSize = NSSize(width: 640, height: 420)
    window.isReleasedWhenClosed = false
    window.tabbingIdentifier = "hivemind"
    window.collectionBehavior.insert(.fullScreenPrimary)
    window.identifier = Self.windowIdentifier
    window.isRestorable = primary
    if primary { window.restorationClass = WindowRestorer.self }
    super.init(window: window)
    window.delegate = self

    let container = NSView()
    for view in [webView, connectView] as [NSView] {
      view.translatesAutoresizingMaskIntoConstraints = false
      view.isHidden = true
      container.addSubview(view)
      NSLayoutConstraint.activate([
        view.leadingAnchor.constraint(equalTo: container.leadingAnchor),
        view.trailingAnchor.constraint(equalTo: container.trailingAnchor),
        view.topAnchor.constraint(equalTo: container.topAnchor),
        view.bottomAnchor.constraint(equalTo: container.bottomAnchor),
      ])
    }
    window.contentView = container

    webView.navigationDelegate = self
    webView.uiDelegate = self
    if primary {
      webView.configuration.userContentController.add(
        WeakScriptMessageHandler(self), contentWorld: .page, name: bridgeHandlerName)
    }
    if primary { terminals = makeTerminalRouter() }
    connectView.onStartServer = { [weak self] in
      self?.app.startServerApp()
      self?.connect()
    }
    connectView.onRetry = { [weak self] text in self?.retry(portText: text) }
    connectView.onOpenWithoutTerminals = { [weak self] in self?.openWithoutTerminals() }
    observations = [
      webView.observe(\.title) { webView, _ in
        MainActor.assumeIsolated {
          let title = webView.title ?? ""
          webView.window?.title = title.isEmpty ? "Hivemind" : title
        }
      },
      webView.observe(\.url) { [weak self] _, _ in
        MainActor.assumeIsolated { self?.urlDidChange() }
      },
    ]
    app.adopt(self)
  }

  required init?(coder: NSCoder) { fatalError("not used") }

  private func makeTerminalRouter() -> TerminalBridgeRouter {
    let paths = app.paths
    let client = BrokerClient(
      configuration: .init(
        connector: UnixSocketBrokerConnector(path: paths.brokerSocket.path),
        token: { BrokerTokenFile.read(paths.brokerToken) },
        clientLabel: "Hivemind.app"),
      scheduler: MainQueueScheduler())
    return TerminalBridgeRouter(client: client, environment: .init(
      home: FileManager.default.homeDirectoryForCurrentUser.path,
      tmuxConfigPath: paths.tmuxConfig.path,
      deliver: { [weak self] event in
        guard let self, !self.isClosed else { return }
        self.webView.evaluateJavaScript(event.javaScript, completionHandler: nil)
      },
      openTerminals: { [weak self] launches in
        guard let self else { return }
        self.app.openTerminals(launches, from: self.window)
      }))
  }

  // MARK: Connection

  private var endpoint: ServerEndpoint? {
    if case .connected(let endpoint, _) = connection { endpoint } else { nil }
  }

  private var trust: ServerTrust? {
    if case .connected(_, let trust) = connection { trust } else { nil }
  }

  static let trustCheckInterval: TimeInterval = 1

  /// Finds a server and verifies it (UIServerLocator), then loads it or
  /// shows the connect screen. The spinner is for checks the user asked
  /// for, not the timer's, which never interrupts a check in flight.
  private func connect(showingProgress: Bool = true, ifIdle: Bool = false) {
    guard isPrimary else { return }
    if ifIdle, resolving { return }
    if showingProgress { refreshConnectScreen(checking: true) }
    resolve { [weak self] result in self?.apply(result) }
  }

  /// One resolve; a newer one supersedes it. The discovery file is read
  /// before, so a change during the resolve is seen by the next watch tick.
  private func resolve(_ handle: @escaping @MainActor (UIConnectionState) -> Void) {
    resolveGeneration += 1
    let generation = resolveGeneration
    resolving = true
    let locator = app.locator
    let port = app.configuredPort
    let basis = locator.liveInstance()
    Task {
      let result = await locator.resolve(configuredPort: port)
      guard generation == resolveGeneration, !isClosed else { return }
      resolving = false
      trustWatch.decided(on: basis)
      handle(result)
    }
  }

  private func apply(_ result: UIConnectionState) {
    switch result {
    case .connected(let endpoint, let trust):
      load(endpoint, trust: trust)
    case .unverified(let endpoint, _) where endpoint == acceptedUnverified:
      load(endpoint, trust: .unverified)
    default:
      showConnectScreen(result)
    }
  }

  /// A new document from `endpoint`. Verified: this navigation's document
  /// gets terminals once committed. Unverified: none do.
  private func load(_ endpoint: ServerEndpoint, trust: ServerTrust) {
    stopRetrying()
    connection = .connected(endpoint, trust)
    showWebView()
    outbox.pageWillLoad()
    // Whatever the old page left waiting is refused; the new one starts closed.
    deliverTerminalEvents(gate.close())
    let navigation = webView.load(URLRequest(url: UIWindowState(hash: route).url(endpoint: endpoint)))
    verifiedNavigation = trust.allowsTerminals ? navigation : nil
    startTrustWatch()
  }

  private func openWithoutTerminals() {
    guard case .unverified(let endpoint, _) = connection else { return }
    acceptedUnverified = endpoint
    load(endpoint, trust: .unverified)
  }

  private func showConnectScreen(_ state: UIConnectionState) {
    connection = state
    outbox.discard()
    terminals?.pageDidChange()
    _ = gate.close()
    verifiedNavigation = nil
    stopTrustWatch()
    app.clearBadge(for: id)
    webView.stopLoading()
    webView.isHidden = true
    connectView.isHidden = false
    window?.title = "Hivemind"
    refreshConnectScreen(checking: false)
    startRetrying()
  }

  private func refreshConnectScreen(checking: Bool) {
    guard !connectView.isHidden else { return }
    let content = ConnectScreenContent(state: connection, serverAppInstalled: app.serverAppURL != nil)
    connectView.show(content, port: connection.endpoint.port, checking: checking)
  }

  private func showWebView() {
    connectView.isHidden = true
    webView.isHidden = false
  }

  private func retry(portText: String) {
    let trimmed = portText.trimmingCharacters(in: .whitespaces)
    if !trimmed.isEmpty {
      guard let port = ServerPort(trimmed) else {
        connectView.showPortError("Enter a port from 1 to 65535.")
        return
      }
      app.configuredPort = port
    }
    connectView.showPortError(nil)
    connect()
  }

  private func startRetrying() {
    guard retryTimer == nil else { return }
    retryTimer = Timer.scheduledTimer(withTimeInterval: Self.retryInterval, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.connect(showingProgress: false, ifIdle: true) }
    }
  }

  private func stopRetrying() {
    retryTimer?.invalidate()
    retryTimer = nil
  }

  // MARK: Trust

  private func startTrustWatch() {
    guard isPrimary, trustTimer == nil else { return }
    trustTimer = Timer.scheduledTimer(withTimeInterval: Self.trustCheckInterval, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.checkTrust() }
    }
  }

  private func stopTrustWatch() {
    trustTimer?.invalidate()
    trustTimer = nil
  }

  /// A watch tick: the discovery file against what this window decided on.
  private func checkTrust() {
    guard isPrimary, let trust, !resolving else { return }
    switch trustWatch.observe(app.locator.liveInstance(), trust: trust) {
    case .lapse: holdTerminals()
    case .reverify: reverify()
    case .none:
      // Held terminals keep looking until a check decides: the server is
      // back (a new document), something unverified answers (the connect
      // screen), or it is still away.
      if trust.allowsTerminals, gate.mode == .held { reverify() }
    }
  }

  /// Resolves again while a page shows, and acts on it (UITrustAction).
  private func reverify() {
    guard isPrimary, endpoint != nil else { return }
    resolve { [weak self] result in
      guard let self, endpoint != nil else { return }
      switch UITrustAction.decide(current: connection, result: result, acceptedUnverified: acceptedUnverified) {
      case .keep:
        if trust?.allowsTerminals == true {
          for message in gate.open() { terminals?.handle(message) }
        } else {
          deliverTerminalEvents(gate.close())
        }
      case .load(let endpoint, let trust):
        load(endpoint, trust: trust)
      case .hold:
        holdTerminals()
      case .connectScreen(let state):
        showConnectScreen(state)
      }
    }
  }

  /// Nothing proves who answers on the port now: the page's streams end and
  /// its terminal messages wait for the next decision.
  private func holdTerminals() {
    guard gate.mode != .held else { return }
    gate.hold()
    terminals?.pageDidChange()
  }

  private func deliverTerminalEvents(_ events: [BridgeTerminalEvent]) {
    for event in events { webView.evaluateJavaScript(event.javaScript, completionHandler: nil) }
  }

  /// On app activation: retry the broker, and look at the discovery file now
  /// rather than at the next tick. A server that is merely down is left to
  /// the page, which reconnects by itself.
  func revalidate() {
    terminals?.retry()
    checkTrust()
  }

  // MARK: Page

  private func urlDidChange() {
    guard let endpoint, let url = webView.url, endpoint.isSameOrigin(url) else { return }
    route = UIWindowState.route(of: url, endpoint: endpoint)
    window?.invalidateRestorableState()
  }

  /// Sends a command to the page now, or once it says it is ready.
  func send(_ command: BridgeCommand) {
    for ready in outbox.send(command) {
      webView.evaluateJavaScript(ready.javaScript, completionHandler: nil)
    }
  }

  func navigate(to hash: String) {
    guard let hash = BridgeCommand.validHash(hash) else { return }
    route = hash
    if outbox.isReady {
      send(.navigate(hash: hash))
    } else if endpoint != nil {
      // A page without the bridge (an older server) still gets there, on a
      // server verified again.
      connect(showingProgress: false)
    }
  }

  fileprivate func receive(_ message: WKScriptMessage) {
    guard let endpoint else { return }
    let origin = message.frameInfo.securityOrigin
    guard BridgeOriginGate.accepts(
      isMainFrame: message.frameInfo.isMainFrame, scheme: origin.protocol, host: origin.host,
      port: origin.port, endpoint: endpoint),
      let parsed = BridgeMessage(body: message.body) else { return }
    switch parsed {
    case .ready:
      for command in outbox.ready() { webView.evaluateJavaScript(command.javaScript, completionHandler: nil) }
    case .badge(let count):
      app.setBadge(count, for: id)
    case .notify(let title, let body, let tag, let target):
      app.notifier.post(UIAppNotice(title: title, body: body, tag: tag, target: target, windowID: id))
    default:
      // Terminals (docs/terminal-broker.md#bridge), only for a page from a
      // verified server (TerminalTrustGate). No confirmation for a launch,
      // by the user's choice (docs/macos.md#security-note); the router
      // throttles launch, open and kill.
      guard terminals != nil else { return }
      for route in gate.route(parsed) {
        switch route {
        case .relay(let message): terminals?.handle(message)
        case .answer(let event): deliverTerminalEvents([event])
        case .drop: break
        }
      }
    }
  }

  // MARK: Menu

  @objc func hivemindCommand(_ sender: NSMenuItem) {
    guard let command = UIMenuCommand(tag: sender.tag) else { return }
    perform(command)
  }

  func perform(_ command: UIMenuCommand) {
    switch command {
    case .newWindow, .help, .closeWindow:
      app.perform(command)
    case .reload:
      // Every reload verifies the server again.
      if isPrimary { connect() } else { webView.reload() }
    case .actualSize: setZoom(PageZoom.actualSize)
    case .zoomIn: setZoom(PageZoom.zoomIn(from: webView.pageZoom))
    case .zoomOut: setZoom(PageZoom.zoomOut(from: webView.pageZoom))
    case .back: webView.goBack()
    case .forward: webView.goForward()
    case .settings where endpoint == nil:
      connectView.focusPort()
    case .settings, .newChannel, .toggleTheme, .jump, .forYou:
      guard isPrimary else { return app.perform(command) }
      if let bridge = command.bridgeCommand { send(bridge) }
    }
  }

  func validateMenuItem(_ item: NSMenuItem) -> Bool {
    guard item.action == #selector(hivemindCommand(_:)), let command = UIMenuCommand(tag: item.tag) else { return true }
    let showingPage = !webView.isHidden
    switch command {
    case .newWindow, .help, .closeWindow, .reload: return true
    case .actualSize: return showingPage && abs(webView.pageZoom - PageZoom.actualSize) > 0.001
    case .zoomIn: return showingPage && webView.pageZoom < PageZoom.levels.last!
    case .zoomOut: return showingPage && webView.pageZoom > PageZoom.levels.first!
    case .back: return showingPage && webView.canGoBack
    case .forward: return showingPage && webView.canGoForward
    case .settings: return true
    // Auxiliary windows hand these to a primary window via the app.
    case .newChannel, .toggleTheme, .jump, .forYou: return !isPrimary || endpoint != nil
    }
  }

  private func setZoom(_ zoom: Double) {
    webView.pageZoom = PageZoom.clamp(zoom)
    app.pageZoom = webView.pageZoom
    window?.invalidateRestorableState()
  }

  // MARK: NSWindowDelegate

  func windowWillClose(_ notification: Notification) {
    isClosed = true
    terminals?.close()
    stopRetrying()
    stopTrustWatch()
    observations.removeAll()
    webView.stopLoading()
    webView.configuration.userContentController.removeAllScriptMessageHandlers()
    app.windowDidClose(self)
  }

  func window(_ window: NSWindow, willEncodeRestorableState state: NSCoder) {
    if let route { state.encode(route as NSString, forKey: WindowRestorer.routeKey) }
    state.encode(webView.pageZoom, forKey: WindowRestorer.zoomKey)
  }
}

// MARK: - WKNavigationDelegate

extension BrowserWindowController: WKNavigationDelegate {
  func webView(
    _ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
    decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void
  ) {
    if action.shouldPerformDownload { return decisionHandler(.download) }
    guard let url = action.request.url, let endpoint else { return decisionHandler(.cancel) }
    if startsServerApp(url, isMainFrame: action.targetFrame?.isMainFrame ?? true) { return decisionHandler(.cancel) }
    let decision = UIAppNavigation.decide(
      url, endpoint: endpoint, isMainFrame: action.targetFrame?.isMainFrame ?? true,
      userActivated: action.navigationType == .linkActivated)
    switch decision {
    case .allow:
      decisionHandler(.allow)
    case .openExternally:
      NSWorkspace.shared.open(url)
      decisionHandler(.cancel)
    case .deny:
      decisionHandler(.cancel)
    }
  }

  func webView(
    _ webView: WKWebView, decidePolicyFor response: WKNavigationResponse,
    decisionHandler: @escaping @MainActor (WKNavigationResponsePolicy) -> Void
  ) {
    let disposition = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
    let attachment = disposition.lowercased().hasPrefix("attachment")
    decisionHandler(response.canShowMIMEType && !attachment ? .allow : .download)
  }

  func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
    // A new document: its bridge listener is not up until it says `ready`.
    // The badge stays: the page resends it once it has a snapshot, and
    // clearing it here would blink the Dock on every reload.
    outbox.pageWillLoad()
    // The old page's in-app terminals go with it.
    terminals?.pageDidChange()
    gate.pageDidChange()
    guard isPrimary, let trust else { return }
    if trust.allowsTerminals, let verified = verifiedNavigation, navigation === verified {
      verifiedNavigation = nil
      _ = gate.open()
    } else if trust.allowsTerminals {
      // A document this window did not load right after verifying (the page
      // reloaded itself, back/forward): its terminal messages wait until the
      // server is verified again as the same process.
      verifiedNavigation = nil
      holdTerminals()
      reverify()
    } else {
      _ = gate.close()
    }
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
    failed(error)
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) {
    failed(error)
  }

  /// hivemind-server://start from the page ("Start Hivemind Server to use
  /// terminals"): the same as the connect screen's button, then terminals
  /// retry at once. It only ever starts the server, so it needs no gate
  /// beyond coming from the main frame of this window.
  private func startsServerApp(_ url: URL, isMainFrame: Bool) -> Bool {
    guard ServerAppURLCommand(url: url) == .start else { return false }
    if isPrimary, isMainFrame {
      app.startServerApp()
      terminals?.retry()
    }
    return true
  }

  private func failed(_ error: any Error) {
    let error = error as NSError
    // Only the network failing counts. -999 is a cancel (ours, or a newer
    // load); WebKit's own errors (a navigation that became a download) are
    // not in this domain.
    guard error.domain == NSURLErrorDomain, error.code != NSURLErrorCancelled else { return }
    guard isPrimary, let endpoint else { return }
    showConnectScreen(.unreachable(endpoint, reason: error.localizedDescription))
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    if isPrimary, endpoint != nil { connect(showingProgress: false) } else { webView.reload() }
  }

  func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
    app.downloads.adopt(download)
  }

  func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
    app.downloads.adopt(download)
    // An attachment opened in its own window that turned out to be a file:
    // nothing is left to show.
    if !isPrimary, webView.backForwardList.currentItem == nil { window?.close() }
  }
}

// MARK: - WKUIDelegate

extension BrowserWindowController: WKUIDelegate {
  /// target=_blank and window.open. Same-origin pages open in a new window
  /// here (they need the session); anything else goes to the browser.
  func webView(
    _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
    for action: WKNavigationAction, windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    guard let url = action.request.url, let endpoint else { return nil }
    if startsServerApp(url, isMainFrame: action.sourceFrame.isMainFrame) { return nil }
    if endpoint.isSameOrigin(url) {
      if url.path.isEmpty || url.path == "/" {
        // The UI itself: a full window at that route.
        app.openWindow(state: UIWindowState(hash: UIWindowState.route(of: url, endpoint: endpoint), zoom: webView.pageZoom))
      } else {
        app.openAuxiliaryWindow(url: url, endpoint: endpoint)
      }
    } else if NavigationPolicy.decide(url, endpoint: endpoint) == .openExternally {
      NSWorkspace.shared.open(url)
    }
    return nil
  }

  func webView(
    _ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo,
    completionHandler: @escaping @MainActor ([URL]?) -> Void
  ) {
    guard let window else { return completionHandler(nil) }
    let panel = NSOpenPanel()
    panel.allowsMultipleSelection = parameters.allowsMultipleSelection
    panel.canChooseDirectories = parameters.allowsDirectories
    panel.canChooseFiles = true
    panel.beginSheetModal(for: window) { response in
      completionHandler(response == .OK ? panel.urls : nil)
    }
  }

  func webView(
    _ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
    completionHandler: @escaping @MainActor () -> Void
  ) {
    guard let window else { return completionHandler() }
    let alert = NSAlert()
    alert.messageText = message
    alert.beginSheetModal(for: window) { _ in completionHandler() }
  }

  func webView(
    _ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo,
    completionHandler: @escaping @MainActor (Bool) -> Void
  ) {
    guard let window else { return completionHandler(false) }
    let alert = NSAlert()
    alert.messageText = message
    alert.addButton(withTitle: "OK")
    alert.addButton(withTitle: "Cancel")
    alert.beginSheetModal(for: window) { response in completionHandler(response == .alertFirstButtonReturn) }
  }
}

/// WKUserContentController retains its handlers; this keeps it from
/// retaining the window controller in a cycle.
private final class WeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
  weak var owner: BrowserWindowController?

  init(_ owner: BrowserWindowController) { self.owner = owner }

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    MainActor.assumeIsolated { owner?.receive(message) }
  }
}
