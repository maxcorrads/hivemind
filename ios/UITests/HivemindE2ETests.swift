import XCTest

/// End-to-end tests against a real Mac: Hivemind Server with Remote Access on
/// (docs/ios.md#end-to-end-tests). Each test is skipped unless its
/// environment is set; `xcodebuild test` passes `TEST_RUNNER_<NAME>` to the
/// runner as `<NAME>`. They never run in CI (the HivemindE2E scheme only).
final class HivemindE2ETests: XCTestCase {
  private var environment: [String: String] { ProcessInfo.processInfo.environment }

  override func setUp() {
    continueAfterFailure = false
  }

  /// `HIVEMIND_E2E_PAIRING_LINK`: opens the pairing link as the Camera app
  /// would, checks the confirmation screen, taps **Pair** and waits for the
  /// Mac's page.
  func testPairWithLink() throws {
    guard let link = environment["HIVEMIND_E2E_PAIRING_LINK"], let url = URL(string: link) else {
      throw XCTSkip("set TEST_RUNNER_HIVEMIND_E2E_PAIRING_LINK to a hivemind-pair:// link")
    }
    let app = XCUIApplication()
    app.launch()
    app.open(url)
    let pair = app.buttons["Pair"]
    XCTAssertTrue(pair.waitForExistence(timeout: 20), "the link opens the confirmation screen")
    XCTAssertTrue(app.staticTexts["Check that the Mac’s pairing window shows the same fingerprint."].exists)
    pair.tap()
    XCTAssertTrue(page(app).waitForExistence(timeout: 30), "the Mac's page loads once paired")
    XCTAssertTrue(pageText(app, "Terminal sessions").waitForExistence(timeout: 30), "and it has terminals")
  }

  /// `HIVEMIND_E2E_SESSION` (a running `hm-…` session): opens it from
  /// **Terminal sessions** in the in-app terminal and types
  /// `echo before-restart-<run>-$((6*7))`, holds for `HIVEMIND_E2E_HOLD`
  /// seconds (default 0) while the Mac restarts its Node server, then types
  /// `echo after-restart-<run>-…`. The Mac side checks that both outputs
  /// reached the tmux session (`<run>` is `HIVEMIND_E2E_RUN`).
  func testTerminalAcrossServerRestart() throws {
    let app = try openTerminal()
    let hold = TimeInterval(environment["HIVEMIND_E2E_HOLD"] ?? "") ?? 0
    try type(app, "echo before-restart-\(run)-$((6*7))\n")
    if hold > 0 {
      // The Mac restarts its Node server meanwhile (and takes screenshots).
      Thread.sleep(forTimeInterval: hold)
    }
    try waitUntilLive(app)
    try type(app, "echo after-restart-\(run)-$((6*7))\n")
  }

  /// The row of keys a phone keyboard lacks, above the keyboard: ^C stops a
  /// `sleep 100`, Up recalls the last command, Left moves the cursor, Esc
  /// reaches `cat -v` as `^[`. The Mac side checks the tmux session for
  /// `rc-130-<run>`, `keys-<run>-42` twice, `aZb-<run>` and `^[`; `HIVEMIND_E2E_HOLD` seconds
  /// at the end leave time for a screenshot.
  func testTerminalTouchKeys() throws {
    let app = try openTerminal()
    let web = app.webViews.firstMatch
    try type(app, "sleep 100\n")
    try tap(web, "Ctrl+C", above: app.keyboards.firstMatch)
    // 130: the shell saw sleep end by SIGINT.
    try type(app, "echo rc-$?-\(run)\n")
    try type(app, "echo keys-\(run)-$((6*7))\n")
    try tap(web, "Up", above: app.keyboards.firstMatch)
    try type(app, "\n")
    try type(app, "echo ab-\(run)")
    for _ in 0..<("-" + run).count + 1 { try tap(web, "Left", above: app.keyboards.firstMatch) }
    try type(app, "Z\n")
    try type(app, "cat -v\n")
    try tap(web, "Esc", above: app.keyboards.firstMatch)
    try type(app, "\n")
    try tap(web, "Ctrl+C", above: app.keyboards.firstMatch)
    let hold = TimeInterval(environment["HIVEMIND_E2E_HOLD"] ?? "") ?? 0
    if hold > 0 { Thread.sleep(forTimeInterval: hold) }
  }

  // MARK: Helpers

  private var run: String { environment["HIVEMIND_E2E_RUN"] ?? "0" }

  private func page(_ app: XCUIApplication) -> XCUIElement { app.webViews.firstMatch }

  private func pageText(_ app: XCUIApplication, _ text: String) -> XCUIElement {
    app.webViews.firstMatch.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", text)).firstMatch
  }

  /// Launches the app and opens `HIVEMIND_E2E_SESSION` from **Terminal sessions**.
  private func openTerminal() throws -> XCUIApplication {
    guard let session = environment["HIVEMIND_E2E_SESSION"] else {
      throw XCTSkip("set TEST_RUNNER_HIVEMIND_E2E_SESSION to a running hm-… session")
    }
    let app = XCUIApplication()
    app.launch()
    XCTAssertTrue(page(app).waitForExistence(timeout: 30))
    let sessions = pageText(app, "Terminal sessions")
    XCTAssertTrue(sessions.waitForExistence(timeout: 30))
    sessions.tap()
    let open = app.webViews.firstMatch.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Open'")).firstMatch
    if !open.waitForExistence(timeout: 20) { print(app.webViews.firstMatch.debugDescription) }
    XCTAssertTrue(open.exists, "\(session) is listed with Open")
    open.tap()
    // Keys typed while it says "Connecting to …" are dropped by design
    // (web/use-terminal.ts): wait until the stream is live.
    XCTAssertTrue(app.webViews.firstMatch.textViews.firstMatch.waitForExistence(timeout: 30))
    try waitUntilLive(app)
    return app
  }

  private func waitUntilLive(_ app: XCUIApplication) throws {
    let note = app.webViews.firstMatch.descendants(matching: .any)
      .matching(NSPredicate(format: "label BEGINSWITH 'Connecting to' OR label BEGINSWITH 'Reconnecting'")).firstMatch
    let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: note)
    wait(for: [gone], timeout: 30)
    Thread.sleep(forTimeInterval: 0.5)
  }

  /// Types into the in-app terminal. xterm.js draws on a canvas, so its
  /// output is not in the accessibility tree: the Mac side reads it from
  /// the tmux session (`tmux capture-pane`).
  private func type(_ app: XCUIApplication, _ text: String) throws {
    let terminal = app.webViews.firstMatch.textViews.firstMatch
    if !terminal.waitForExistence(timeout: 30) { print(app.webViews.firstMatch.debugDescription) }
    XCTAssertTrue(terminal.exists, "the in-app terminal shows")
    XCTAssertFalse(pageText(app, "Session ended").exists, "the session did not end")
    // The page focuses xterm itself, but iOS shows the keyboard (and takes keys) only after a tap.
    if !app.keyboards.firstMatch.exists { terminal.tap() }
    terminal.typeText(text)
    Thread.sleep(forTimeInterval: 1.5)
  }

  /// Taps one of the terminal's own keys, which must be visible above the
  /// on-screen keyboard (WebKit's form bar is gone: HivemindWebView).
  private func tap(_ web: XCUIElement, _ key: String, above keyboard: XCUIElement) throws {
    let button = web.buttons[key]
    XCTAssertTrue(button.waitForExistence(timeout: 10), "the terminal has a \(key) key")
    if keyboard.exists {
      XCTAssertLessThanOrEqual(button.frame.maxY, keyboard.frame.minY + 1, "\(key) is above the keyboard, not under it")
    }
    button.tap()
    Thread.sleep(forTimeInterval: 1)
  }
}
