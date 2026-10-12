import Foundation
import Testing
@testable import HivemindKit

// The Codex thread check (docs/accounts.md, "Live sessions") over fake folders under the temp dir. An open thread holds
// an exclusive flock, taken here on its own descriptor: two descriptors on one file conflict, as two processes do.

private let thread = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0"

/// Runs `body` with the check for a fresh fake home and its thread-writer-locks folder; the temp folder is removed afterwards.
private func withLocks(_ body: (CodexThreadLock, String) throws -> Void) throws {
  let root = try temporaryHome()
  defer { try? FileManager.default.removeItem(at: root) }
  let home = root.appendingPathComponent("codex").path
  let folder = home + "/thread-writer-locks"
  try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
  try body(CodexThreadLock(home: home), folder)
}

struct CodexThreadLockTests {
  @Test func aThreadHeldByAnotherProcessIsOpen() throws {
    try withLocks { lock, folder in
      let fd = open(folder + "/\(thread).lock", O_RDWR | O_CREAT, 0o600)
      try #require(fd >= 0)
      defer { close(fd) }
      try #require(flock(fd, LOCK_EX) == 0)
      let isOpen = try lock.isOpen(thread)
      #expect(isOpen)
    }
  }

  @Test func aThreadIsNotOpenOnceReleased() throws {
    try withLocks { lock, folder in
      let fd = open(folder + "/\(thread).lock", O_RDWR | O_CREAT, 0o600)
      try #require(fd >= 0)
      defer { close(fd) }
      try #require(flock(fd, LOCK_EX) == 0)
      let heldOpen = try lock.isOpen(thread)
      #expect(heldOpen)
      try #require(flock(fd, LOCK_UN) == 0)
      let releasedOpen = try lock.isOpen(thread)
      #expect(!releasedOpen)
    }
  }

  @Test func aThreadWithoutALockFileIsNotOpen() throws {
    try withLocks { lock, _ in
      let isOpen = try lock.isOpen(thread)
      #expect(!isOpen)
    }
  }

  @Test func aLockFileNobodyHoldsIsNotOpen() throws {
    try withLocks { lock, folder in
      try Data().write(to: URL(fileURLWithPath: folder + "/\(thread).lock"))
      let isOpen = try lock.isOpen(thread)
      #expect(!isOpen)
    }
  }

  @Test func aMissingFolderHasNoOpenThread() throws {
    let root = try temporaryHome()
    defer { try? FileManager.default.removeItem(at: root) }
    let isOpen = try CodexThreadLock(home: root.appendingPathComponent("codex").path).isOpen(thread)
    #expect(!isOpen)
  }

  @Test func aResumeByIdInACodexLaunchIsChecked() {
    #expect(CodexThreadLock.resumedThread(in: "codex resume \(thread)") == thread)
    #expect(CodexThreadLock.resumedThread(in: "codex exec resume \(thread)") == thread)
    #expect(CodexThreadLock.resumedThread(in: "cd '/x' && /opt/homebrew/bin/codex resume  \(thread) --model o3") == thread)
  }

  @Test func resumeByNameOrLastAndForkAreNotChecked() {
    #expect(CodexThreadLock.resumedThread(in: "codex resume --last") == nil)
    #expect(CodexThreadLock.resumedThread(in: "codex resume my-thread") == nil)
    #expect(CodexThreadLock.resumedThread(in: "codex fork \(thread)") == nil)
    #expect(CodexThreadLock.resumedThread(in: "codex") == nil)
  }

  @Test func aCommandThatDoesNotNameCodexIsNotChecked() {
    #expect(CodexThreadLock.resumedThread(in: "claude --resume \(thread)") == nil)
    #expect(CodexThreadLock.resumedThread(in: "resume \(thread)") == nil)
  }

  @Test func theSharedHomeIsTheCodexAccountsHomeOrTheDefault() {
    func account(_ driver: LaunchAccount.Driver, home: String, shadow: String = "") -> LaunchAccount {
      LaunchAccount(id: "a", driver: driver, label: "A", homePath: home, shadowPath: shadow)
    }
    #expect(CodexThreadLock.sharedHome(for: nil, home: "/Users/a") == "/Users/a/.codex")
    #expect(CodexThreadLock.sharedHome(for: account(.codex, home: "", shadow: "~/.codex-work"), home: "/Users/a") == "/Users/a/.codex")
    #expect(CodexThreadLock.sharedHome(for: account(.codex, home: "~/.codex2"), home: "/Users/a") == "/Users/a/.codex2")
    #expect(CodexThreadLock.sharedHome(for: account(.codex, home: "/srv/codex"), home: "/Users/a") == "/srv/codex")
    #expect(CodexThreadLock.sharedHome(for: account(.claude, home: "~/.claude2"), home: "/Users/a") == "/Users/a/.codex")
  }
}

/// The broker's side: an item that resumes an open thread fails before any of it runs, and the other items start.
@MainActor
struct CodexThreadLockBrokerTests {
  /// A broker whose Mac home is a fake under the temp dir, with `<home>/.codex/thread-writer-locks` in it.
  func harness() throws -> (BrokerHarness, root: URL, folder: String) {
    let root = try temporaryHome()
    let folder = root.appendingPathComponent(".codex/thread-writer-locks").path
    try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
    let h = BrokerHarness()
    h.home = root.path
    return (h, root, folder)
  }

  @Test func resumingAnOpenThreadFailsOnlyItsItemAndRunsNothingOfIt() async throws {
    let (h, root, folder) = try harness()
    defer { try? FileManager.default.removeItem(at: root) }
    let fd = open(folder + "/\(thread).lock", O_RDWR | O_CREAT, 0o600)
    try #require(fd >= 0)
    defer { close(fd) }
    try #require(flock(fd, LOCK_EX) == 0)
    await h.start()
    let (transport, connection) = await h.client()
    let primary = LaunchAccount(id: "a0", driver: .codex, label: "Codex", homePath: "", shadowPath: "")
    let resume = try BrokerLaunch(project: "acme", agent: "Atlas", title: "Acme - Atlas", cwd: "/Users/me/acme",
                                  command: "codex resume \(thread)", account: primary)
    await h.send(connection, .launch([resume, brokerLaunch(nil)]))
    let second = SessionName("hm-acme-new-1")!
    let message = "launches[0].command: Codex thread `\(thread)` is already open in another process. Close it there, or start a new session."
    #expect(transport.events().first == .launched(
      names: [nil, second], created: [second], errors: [BrokerLaunchFailure(index: 0, code: .internal, message: message)]))
    #expect(h.tmux.calls("new-session").count == 1)
  }

  @Test func withoutAnAccountAResumeOfAnOpenThreadRunsAsBefore() async throws {
    let (h, root, folder) = try harness()
    defer { try? FileManager.default.removeItem(at: root) }
    let fd = open(folder + "/\(thread).lock", O_RDWR | O_CREAT, 0o600)
    try #require(fd >= 0)
    defer { close(fd) }
    try #require(flock(fd, LOCK_EX) == 0)
    await h.start()
    let (transport, connection) = await h.client()
    await h.send(connection, .launch([brokerLaunch("Atlas", command: "codex resume \(thread)")]))
    let atlas = SessionName("hm-acme-atlas")!
    #expect(transport.events().first == .launched(names: [atlas], created: [atlas], errors: []), "no account, no check: Codex decides")
    #expect(h.tmux.calls("new-session").count == 1)
  }

  @Test func aShadowAccountIsCheckedInItsSharedHomeBeforeItsShadow() async throws {
    let (h, root, folder) = try harness()
    defer { try? FileManager.default.removeItem(at: root) }
    let fd = open(folder + "/\(thread).lock", O_RDWR | O_CREAT, 0o600)
    try #require(fd >= 0)
    defer { close(fd) }
    try #require(flock(fd, LOCK_EX) == 0)
    await h.start()
    let (transport, connection) = await h.client()
    let shadow = LaunchAccount(id: "a1", driver: .codex, label: "Codex work", homePath: "", shadowPath: "~/.codex_work")
    let launch = try BrokerLaunch(project: "acme", agent: "Atlas", title: "Acme - Atlas", cwd: "/Users/me/acme",
                                  command: "codex exec resume \(thread)", account: shadow)
    await h.send(connection, .launch([launch]))
    let message = "launches[0].command: Codex thread `\(thread)` is already open in another process. Close it there, or start a new session."
    #expect(transport.events().first == .launched(
      names: [nil], created: [], errors: [BrokerLaunchFailure(index: 0, code: .internal, message: message)]))
    #expect(h.tmux.calls("new-session").isEmpty)
  }

  @Test func resumingAThreadNobodyHoldsStarts() async throws {
    let (h, root, folder) = try harness()
    defer { try? FileManager.default.removeItem(at: root) }
    try Data().write(to: URL(fileURLWithPath: folder + "/\(thread).lock"))
    await h.start()
    let (transport, connection) = await h.client()
    await h.send(connection, .launch([brokerLaunch("Atlas", command: "codex resume \(thread)")]))
    let atlas = SessionName("hm-acme-atlas")!
    #expect(transport.events().first == .launched(names: [atlas], created: [atlas], errors: []))
  }
}
