import HivemindKit
import SwiftUI
import WebKit

/// One scene's content. It keeps which Mac the scene shows and where in the
/// UI it was (SceneStorage), so iPadOS and iOS restore every window where
/// it left off.
struct SceneRoot: View {
  @Environment(AppModel.self) private var model
  @Environment(\.scenePhase) private var scenePhase
  @SceneStorage("windowID") private var windowID: String?
  @SceneStorage("macID") private var storedMacID: String?
  @SceneStorage("route") private var storedRoute: String?
  @State private var controller: SceneController?

  var body: some View {
    Group {
      if let controller {
        SceneContent(controller: controller)
      } else {
        Color(uiColor: .systemBackground)
      }
    }
    .focusedSceneValue(\.sceneController, controller)
    .onAppear(perform: start)
    // hivemind-pair:// (the Camera app reading the Mac's QR code): the
    // pairing screen, for confirmation. Never paired without the Pair button.
    .onOpenURL { url in
      guard url.scheme?.lowercased() == PairingPayload.scheme else { return }
      controller?.openPairingLink(url)
    }
    .onDisappear { controller?.close() }
    .onChange(of: scenePhase) { _, phase in
      if phase == .active { controller?.sceneDidBecomeActive() }
    }
    .onChange(of: controller?.macID) { _, id in
      storedMacID = id?.uuidString
    }
  }

  private func start() {
    let saved = storedMacID.flatMap(UUID.init(uuidString:)).flatMap { model.mac($0)?.id }
    if let controller { return controller.reopen(macID: saved) }
    let id = windowID ?? UUID().uuidString
    windowID = id
    let controller = SceneController(windowID: id, route: storedRoute, model: model)
    controller.onRouteChange = { storedRoute = $0 }
    self.controller = controller
    if let mac = saved ?? model.defaultMacID { controller.connect(to: mac) }
  }
}

private struct SceneContent: View {
  @Environment(AppModel.self) private var model
  @Bindable var controller: SceneController

  var body: some View {
    content
      .sheet(isPresented: $controller.showingMacs) {
        NavigationStack {
          MacListView(current: controller.macID, onSelect: { controller.connect(to: $0) }, onPair: {
            controller.showingMacs = false
            controller.showingPairing = true
          })
          .toolbar {
            ToolbarItem(placement: .cancellationAction) { Button("Done") { controller.showingMacs = false } }
          }
        }
      }
      .sheet(isPresented: $controller.showingPairing) {
        PairingView(onPaired: { mac in
          controller.showingPairing = false
          controller.pairingLink = nil
          controller.connect(to: mac.id)
        }, onCancel: {
          controller.showingPairing = false
          controller.pairingLink = nil
        }, initialLink: controller.pairingLink)
      }
      .sheet(item: $controller.auxiliary) { page in
        AuxiliaryPageView(page: page, dataStore: model.dataStore(for: page.macID))
      }
  }

  @ViewBuilder private var content: some View {
    if model.macs.isEmpty {
      // First launch, or every Mac removed: pairing is the only thing to do.
      PairingView(onPaired: {
        controller.pairingLink = nil
        controller.connect(to: $0.id)
      }, onCancel: nil, initialLink: controller.pairingLink)
    } else {
      switch controller.phase {
      case .choosing:
        NavigationStack {
          MacListView(current: nil, onSelect: { controller.connect(to: $0) }, onPair: { controller.showingPairing = true })
        }
      case .connecting(let id):
        ConnectionView(content: RemoteConnectScreenContent(problem: nil, macName: model.mac(id)?.name ?? "your Mac"), controller: controller)
      case .failed(let id, let problem):
        ConnectionView(content: RemoteConnectScreenContent(problem: problem, macName: model.mac(id)?.name ?? "your Mac"), controller: controller)
      case .showing:
        if let webView = controller.webView {
          WebViewHost(webView: webView, generation: controller.webViewGeneration)
            // WebKit lays out the page inside the safe areas and above the
            // keyboard itself; SwiftUI must not shrink the view as well.
            .ignoresSafeArea()
        }
      }
    }
  }
}

/// Hosts a web view the scene controller owns, so it survives SwiftUI
/// rebuilding the view tree.
struct WebViewHost: UIViewRepresentable {
  let webView: WKWebView
  let generation: Int

  func makeUIView(context: Context) -> UIView {
    let container = UIView()
    container.backgroundColor = .systemBackground
    attach(to: container)
    return container
  }

  func updateUIView(_ container: UIView, context: Context) {
    if webView.superview !== container {
      container.subviews.forEach { $0.removeFromSuperview() }
      attach(to: container)
    }
  }

  private func attach(to container: UIView) {
    webView.removeFromSuperview()
    webView.translatesAutoresizingMaskIntoConstraints = false
    container.addSubview(webView)
    NSLayoutConstraint.activate([
      webView.leadingAnchor.constraint(equalTo: container.leadingAnchor),
      webView.trailingAnchor.constraint(equalTo: container.trailingAnchor),
      webView.topAnchor.constraint(equalTo: container.topAnchor),
      webView.bottomAnchor.constraint(equalTo: container.bottomAnchor),
    ])
  }
}

/// A same-origin page the UI opened in a new window (an attachment): its
/// own web view in the Mac's data store, pinned like the scene's, kept on
/// the gateway's origin; links elsewhere go to Safari.
struct AuxiliaryPageView: View {
  let page: AuxiliaryPage
  let dataStore: WKWebsiteDataStore
  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      AuxiliaryWebView(page: page, dataStore: dataStore)
        .ignoresSafeArea(edges: .bottom)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
        }
    }
  }
}

private struct AuxiliaryWebView: UIViewRepresentable {
  let page: AuxiliaryPage
  let dataStore: WKWebsiteDataStore

  func makeCoordinator() -> AuxiliaryCoordinator { AuxiliaryCoordinator(page: page) }

  func makeUIView(context: Context) -> WKWebView {
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = dataStore
    let webView = WKWebView(frame: .zero, configuration: configuration)
    webView.navigationDelegate = context.coordinator
    webView.load(URLRequest(url: page.url))
    return webView
  }

  func updateUIView(_ webView: WKWebView, context: Context) {}
}

@MainActor
private final class AuxiliaryCoordinator: NSObject, WKNavigationDelegate {
  let page: AuxiliaryPage

  init(page: AuxiliaryPage) { self.page = page }

  func webView(
    _ webView: WKWebView, didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping @MainActor @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    let outcome = ServerTrustPinning.evaluate(challenge, pin: page.pin, host: page.endpoint.host)
    completionHandler(outcome.disposition, outcome.credential)
  }

  func webView(
    _ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
    decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void
  ) {
    guard let url = action.request.url else { return decisionHandler(.cancel) }
    switch RemoteClientNavigation.decide(url, endpoint: page.endpoint, isMainFrame: action.targetFrame?.isMainFrame ?? true,
                                         userActivated: action.navigationType == .linkActivated) {
    case .allow: decisionHandler(.allow)
    case .openExternally:
      UIApplication.shared.open(url)
      decisionHandler(.cancel)
    case .deny: decisionHandler(.cancel)
    }
  }
}
