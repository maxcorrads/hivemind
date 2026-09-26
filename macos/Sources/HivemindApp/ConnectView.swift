import AppKit
import HivemindKit

/// Shown in place of the web view while no server answers: start the server
/// app, change the port, retry. The window keeps retrying on its own too.
@MainActor
final class ConnectView: NSView {
  var onStartServer: () -> Void = {}
  /// "Open without terminals", offered for a server that could not be verified.
  var onOpenWithoutTerminals: () -> Void = {}
  /// Called with the port field's text; the owner validates it.
  var onRetry: (String) -> Void = { _ in }

  private let titleLabel = NSTextField(labelWithString: "")
  private let detailLabel = NSTextField(wrappingLabelWithString: "")
  private let startButton = NSButton(title: "Start Hivemind Server", target: nil, action: nil)
  private let openButton = NSButton(title: ConnectScreenContent.openWithoutTerminals, target: nil, action: nil)
  private let portField = NSTextField(string: "")
  private let retryButton = NSButton(title: "Retry", target: nil, action: nil)
  private let errorLabel = NSTextField(labelWithString: "")
  private let spinner = NSProgressIndicator()

  override init(frame: NSRect) {
    super.init(frame: frame)
    build()
  }

  required init?(coder: NSCoder) { fatalError("not used") }

  private func build() {
    let icon = NSImageView(image: NSApp.applicationIconImage)
    icon.imageScaling = .scaleProportionallyUpOrDown
    icon.widthAnchor.constraint(equalToConstant: 96).isActive = true
    icon.heightAnchor.constraint(equalToConstant: 96).isActive = true

    titleLabel.font = .systemFont(ofSize: 22, weight: .semibold)
    titleLabel.alignment = .center
    detailLabel.alignment = .center
    detailLabel.textColor = .secondaryLabelColor
    detailLabel.preferredMaxLayoutWidth = 420
    detailLabel.isSelectable = true

    startButton.bezelStyle = .rounded
    startButton.controlSize = .large
    startButton.target = self
    startButton.action = #selector(startServer)
    openButton.bezelStyle = .rounded
    openButton.controlSize = .large
    openButton.target = self
    openButton.action = #selector(openWithoutTerminals)
    let buttons = NSStackView(views: [openButton, startButton])
    buttons.orientation = .horizontal
    buttons.spacing = 10

    let portLabel = NSTextField(labelWithString: "Port")
    portField.placeholderString = ServerPort.default.description
    portField.alignment = .right
    portField.widthAnchor.constraint(equalToConstant: 72).isActive = true
    // Return in the field presses Retry, the default button.
    retryButton.bezelStyle = .rounded
    retryButton.keyEquivalent = "\r"
    retryButton.target = self
    retryButton.action = #selector(retry)
    spinner.style = .spinning
    spinner.controlSize = .small
    spinner.isDisplayedWhenStopped = false
    let portRow = NSStackView(views: [portLabel, portField, retryButton, spinner])
    portRow.orientation = .horizontal
    portRow.spacing = 8

    errorLabel.textColor = .systemRed
    errorLabel.font = .systemFont(ofSize: NSFont.smallSystemFontSize)
    errorLabel.isHidden = true

    let stack = NSStackView(views: [icon, titleLabel, detailLabel, buttons, portRow, errorLabel])
    stack.orientation = .vertical
    stack.alignment = .centerX
    stack.spacing = 14
    stack.setCustomSpacing(20, after: icon)
    stack.setCustomSpacing(22, after: detailLabel)
    stack.translatesAutoresizingMaskIntoConstraints = false
    addSubview(stack)
    NSLayoutConstraint.activate([
      stack.centerXAnchor.constraint(equalTo: centerXAnchor),
      stack.centerYAnchor.constraint(equalTo: centerYAnchor),
      stack.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: 24),
      stack.topAnchor.constraint(greaterThanOrEqualTo: topAnchor, constant: 24),
    ])
  }

  func show(_ content: ConnectScreenContent, port: ServerPort, checking: Bool) {
    titleLabel.stringValue = content.title
    detailLabel.stringValue = content.detail
    startButton.isHidden = !content.offersServerApp
    openButton.isHidden = !content.offersOpenWithoutTerminals
    // Never overwrite what the user is typing; an automatic retry may land mid-edit.
    if portField.currentEditor() == nil { portField.stringValue = port.description }
    if checking { spinner.startAnimation(nil) } else { spinner.stopAnimation(nil) }
  }

  func showPortError(_ message: String?) {
    errorLabel.stringValue = message ?? ""
    errorLabel.isHidden = message == nil
  }

  func focusPort() {
    window?.makeFirstResponder(portField)
  }

  @objc private func startServer() { onStartServer() }

  @objc private func openWithoutTerminals() { onOpenWithoutTerminals() }

  @objc private func retry() { onRetry(portField.stringValue) }
}
