import Foundation
import Testing
@testable import HivemindKit

// The broker's files, environment, menu line and tmux results. The files
// are written under a temporary home only; nothing binds a socket.

private func mode(_ url: URL) -> mode_t {
  var info = stat()
  _ = stat(url.path, &info)
  return info.st_mode & 0o7777
}

struct BrokerFilesTests {
  @Test func writesAPrivateFolderConfigAndToken() throws {
    let paths = HivemindPaths(home: try temporaryHome())
    let token = try BrokerFiles(paths: paths).start(listen: {}, unlisten: {})
    #expect(mode(paths.appSupport) == 0o700)
    #expect(mode(paths.tmuxConfig) == 0o600)
    #expect(mode(paths.brokerToken) == 0o600)
    #expect(try String(contentsOf: paths.tmuxConfig, encoding: .utf8) == TmuxCommand.configText)
    let written = try String(contentsOf: paths.brokerToken, encoding: .utf8)
    #expect(BrokerToken(written) == token)
    // No temporary file is left next to them.
    let names = try FileManager.default.contentsOfDirectory(atPath: paths.appSupport.path)
    #expect(Set(names) == ["tmux.conf", "broker.token"])
  }

  @Test func everyStartRotatesTheTokenAndTightensTheFolder() throws {
    let paths = HivemindPaths(home: try temporaryHome())
    try FileManager.default.createDirectory(at: paths.appSupport, withIntermediateDirectories: true)
    chmod(paths.appSupport.path, 0o755)
    try Data("old".utf8).write(to: paths.brokerToken)
    chmod(paths.brokerToken.path, 0o644)
    let first = try BrokerFiles(paths: paths).start(listen: {}, unlisten: {})
    #expect(mode(paths.appSupport) == 0o700)
    #expect(mode(paths.brokerToken) == 0o600)
    let second = try BrokerFiles(paths: paths).start(listen: {}, unlisten: {})
    #expect(first != second)
    #expect(BrokerToken(try String(contentsOf: paths.brokerToken, encoding: .utf8)) == second)
  }

  @Test func aStartThatCannotListenLeavesTheRunningBrokersTokenAndConfig() throws {
    let paths = HivemindPaths(home: try temporaryHome())
    let running = try BrokerFiles(paths: paths).start(listen: {}, unlisten: {})
    try Data("# edited\n".utf8).write(to: paths.tmuxConfig)
    struct Taken: Error {}
    var unlistened = 0
    #expect(throws: Taken.self) {
      try BrokerFiles(paths: paths).start(listen: { throw Taken() }, unlisten: { unlistened += 1 })
    }
    #expect(BrokerToken(try String(contentsOf: paths.brokerToken, encoding: .utf8)) == running)
    #expect(try String(contentsOf: paths.tmuxConfig, encoding: .utf8) == "# edited\n")
    #expect(unlistened == 0, "nothing to give back")
  }

  @Test func theTokenIsWrittenOnlyAfterTheSocketIsOurs() throws {
    let paths = HivemindPaths(home: try temporaryHome())
    var existedAtListen: Bool?
    var folderAtListen: mode_t?
    let token = try BrokerFiles(paths: paths).start(listen: {
      existedAtListen = FileManager.default.fileExists(atPath: paths.brokerToken.path)
      folderAtListen = mode(paths.appSupport)
    }, unlisten: {})
    #expect(existedAtListen == false)
    #expect(folderAtListen == 0o700, "the socket's folder is private before it binds")
    #expect(BrokerToken(try String(contentsOf: paths.brokerToken, encoding: .utf8)) == token)
  }

  @Test func aTokenThatCannotBeWrittenGivesTheSocketBack() throws {
    let paths = HivemindPaths(home: try temporaryHome())
    var unlistened = 0
    // A folder where the token file should be: the rename over it fails.
    #expect(throws: BrokerFiles.Failure.self) {
      try BrokerFiles(paths: paths).start(listen: {
        try FileManager.default.createDirectory(at: paths.brokerToken.appendingPathComponent("x"), withIntermediateDirectories: true)
      }, unlisten: { unlistened += 1 })
    }
    #expect(unlistened == 1)
  }

  @Test func refusesASocketPathTooLongForAUnixSocket() throws {
    let long = try temporaryHome().appendingPathComponent(String(repeating: "h", count: 80), isDirectory: true)
    let files = BrokerFiles(paths: HivemindPaths(home: long))
    #expect(throws: BrokerFiles.Failure.self) { try files.checkSocketPath() }
    #expect(throws: Never.self) { try BrokerFiles(paths: HivemindPaths(home: URL(fileURLWithPath: "/Users/me"))).checkSocketPath() }
  }

  @Test func refusesAFileWhereTheFolderShouldBe() throws {
    let paths = HivemindPaths(home: try temporaryHome())
    try FileManager.default.createDirectory(at: paths.appSupport.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data().write(to: paths.appSupport)
    #expect(throws: BrokerFiles.Failure.self) { try BrokerFiles(paths: paths).start(listen: {}, unlisten: {}) }
  }
}

struct BrokerEnvironmentTests {
  @Test func dropsTheAppsTerminalAndTmuxVariables() {
    let environment = BrokerEnvironment.tmux(from: [
      "TMUX": "/private/tmp/tmux-501/default,1,0", "TMUX_PANE": "%1", "HIVEMIND_TMUX_SESSION": "hm-x-y",
      "TERM": "dumb", "TERM_PROGRAM": "Apple_Terminal", "HOME": "/Users/me", "USER": "me",
      "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
    ])
    #expect(environment == [
      "HOME": "/Users/me", "USER": "me", "LANG": "en_US.UTF-8",
      "PATH": "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    ])
  }

  @Test func keepsTheUsersOwnPathOrderAndLanguage() {
    let environment = BrokerEnvironment.tmux(from: ["PATH": "/usr/local/bin:/Users/me/bin:/opt/homebrew/bin", "LANG": "it_IT.UTF-8"])
    #expect(environment["PATH"] == "/usr/local/bin:/Users/me/bin:/opt/homebrew/bin")
    #expect(environment["LANG"] == "it_IT.UTF-8")
    #expect(BrokerEnvironment.tmux(from: [:])["PATH"] == "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")
  }

  @Test func attachClientsAreXterm256Color() {
    let environment = BrokerEnvironment.attach(from: ["TERM": "dumb", "TMUX": "x"])
    #expect(environment["TERM"] == "xterm-256color")
    #expect(environment["COLORTERM"] == "truecolor")
    #expect(environment["TMUX"] == nil)
  }
}

struct BrokerStatusTests {
  @Test func saysWhatTheMenuShows() {
    let tmux = "/opt/homebrew/bin/tmux"
    #expect(BrokerStatus(state: .stopped, tmuxPath: nil, sessionCount: nil).title == "Terminals: stopped")
    #expect(BrokerStatus(state: .listening, tmuxPath: nil, sessionCount: 0).title == "Terminals: tmux not found (brew install tmux)")
    #expect(BrokerStatus(state: .listening, tmuxPath: tmux, sessionCount: nil).title == "Terminals: tmux found")
    #expect(BrokerStatus(state: .listening, tmuxPath: tmux, sessionCount: 0).title == "Terminals: no sessions")
    #expect(BrokerStatus(state: .listening, tmuxPath: tmux, sessionCount: 1).title == "Terminals: 1 session")
    #expect(BrokerStatus(state: .listening, tmuxPath: tmux, sessionCount: 3, streamCount: 2).title
      == "Terminals: 3 sessions, 2 open in Hivemind")
    #expect(BrokerStatus(state: .failed("Another Hivemind Server is already serving terminals"), tmuxPath: tmux, sessionCount: 1).title
      == "Terminals: unavailable (Another Hivemind Server is already serving terminals)")
  }

  @Test func aLongFailureStaysOneMenuLine() {
    let title = BrokerStatus(state: .failed(String(repeating: "x", count: 500) + "\nmore"), tmuxPath: nil, sessionCount: nil).title
    #expect(title.count <= ServerAppStatus.maxLineLength)
    #expect(!title.contains("\n"))
  }
}

struct TmuxResultTests {
  @Test func theFirstErrorLineIsWhatAClientSees() {
    #expect(TmuxResult(status: 1, stderr: "  no server running on /tmp/x  \nmore\n").firstErrorLine == "no server running on /tmp/x")
    #expect(TmuxResult(status: 2).firstErrorLine == "tmux exited with status 2")
    #expect(TmuxResult(status: 1, stderr: String(repeating: "e", count: 500)).firstErrorLine.count == 200)
    #expect(TmuxResult(status: 0).succeeded)
  }
}

struct PTYReadGateTests {
  @Test func pausesAboveTheHighWaterMarkAndResumesAtTheLowOne() {
    var gate = PTYReadGate(highWater: 100, lowWater: 25)
    #expect(gate.reading)
    #expect(gate.read(60) == nil)
    #expect(gate.read(40) == nil, "at the mark, not above it")
    #expect(gate.read(1) == false)
    #expect(gate.undelivered == 101)
    #expect(gate.delivered(60) == nil, "41 is still above the low mark")
    #expect(gate.delivered(16) == true)
    #expect(gate.reading)
    #expect(gate.delivered(1_000) == nil)
    #expect(gate.undelivered == 0, "never below zero")
  }

  @Test func theBrokersPauseAndTheQueuesAreIndependent() {
    var gate = PTYReadGate(highWater: 100, lowWater: 25)
    #expect(gate.setWanted(false) == false)
    #expect(gate.setWanted(false) == nil)
    #expect(gate.read(200) == nil, "already paused")
    #expect(gate.setWanted(true) == nil, "the queue is still full")
    #expect(!gate.reading)
    #expect(gate.delivered(200) == true)
    #expect(gate.read(200) == false)
    #expect(gate.setWanted(false) == nil)
    #expect(gate.delivered(200) == nil, "the broker still wants a pause")
    #expect(gate.setWanted(true) == true)
  }

  @Test func theDefaultsMatchTheBrokersOwnBackpressure() {
    #expect(PTYReadGate.highWater == BrokerLimits.maxOutboundBytes)
    #expect(PTYReadGate.lowWater == BrokerLimits.resumeOutboundBytes)
  }
}
