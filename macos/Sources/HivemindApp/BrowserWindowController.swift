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
  private var resolving = false
  private var retryTimer: Timer?
  private var observations: [NSKeyValueObservation] = []
  private var isClosed = false
  private var terminalThrottle = TerminalLaunchThrottle()

  static let retryInterval: TimeInterval = 2
  static let windowIdentifier = NSUserInterfaceItemIdentifier("hivemind.browser")

  convenience init(app: HivemindApp, state: UIWindowState) {
    self.init(app: app, primary: true, zoom: state.zoom, connection: .checking(ServerEndpoint(port: app.configuredPort ?? .default)))
    route = state.hash
    connect()
  }

  convenience init(app: HivemindApp, auxiliaryURL: URL, endpoint: ServerEndpoint, zoom: Double) {
    self.init(app: app, primary: false, zoom: zoom, connection: .connected(endpoint))
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
    connectView.onStartServer = { [weak self] in
      self?.app.startServerApp()
      self?.connect()
    }
    connectView.onRetry = { [weak self] text in self?.retry(portText: text) }
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

  // MARK: Connection

  private var endpoint: ServerEndpoint? {
    if case .connected(let endpoint) = connection { endpoint } else { nil }
  }

  /// Finds a server and loads it, or shows the connect screen and keeps
  /// trying. The spinner is for checks the user asked for, not the timer's.
  private func connect(showingProgress: Bool = true) {
    guard isPrimary, !resolving else { return }
    resolving = true
    if showingProgress { refreshConnectScreen(checking: true) }
    let port = app.configuredPort
    let locator = app.locator
    Task {
      let result = await locator.resolve(configuredPort: port)
      resolving = false
      guard !isClosed else { return }
      apply(result)
    }
  }

  private func apply(_ result: UIConnectionState) {
    if case .connected(let endpoint) = result {
      load(endpoint)
    } else {
      showConnectScreen(result)
    }
  }

  private func load(_ endpoint: ServerEndpoint) {
    stopRetrying()
    connection = .connected(endpoint)
    showWebView()
    outbox.pageWillLoad()
    webView.load(URLRequest(url: UIWindowState(hash: route).url(endpoint: endpoint)))
  }

  private func showConnectScreen(_ state: UIConnectionState) {
    connection = state
    outbox.discard()
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
      MainActor.assumeIsolated { self?.connect(showingProgress: false) }
    }
  }

  private func stopRetrying() {
    retryTimer?.invalidate()
    retryTimer = nil
  }

  /// On app activation: if this window's server went away and the discovery
  /// file now names another live one (the server app restarted it on a new
  /// port), follow it. A server that is merely down is left to the page,
  /// which reconnects by itself.
  func revalidate() {
    guard isPrimary, let current = endpoint, !resolving else { return }
    let locator = app.locator
    let port = app.configuredPort
    Task {
      guard await HealthChecker().check(current) != .healthy else { return }
      if case .connected(let found) = await locator.resolve(configuredPort: port), found != current, endpoint == current {
        load(found)
      }
    }
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
    } else if let endpoint {
      // A page without the bridge (an older server) still gets there.
      load(endpoint)
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
    case .launchTerminal(let launches):
      // No confirmation, by the user's choice (docs/macos.md#open-in-terminal).
      guard terminalThrottle.allow(at: Date()) else { return }
      app.openTerminals(launches, from: window)
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
      if endpoint != nil { webView.reload() } else { connect() }
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
    stopRetrying()
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
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
    failed(error)
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) {
    failed(error)
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
    if isPrimary, let endpoint { load(endpoint) } else { webView.reload() }
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
