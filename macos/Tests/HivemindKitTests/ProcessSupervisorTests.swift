import Foundation
import Testing
@testable import HivemindKit

/// A preflight answer tests change between starts; a class, since the
/// supervisor's preflight closure is sendable and must not capture a var.
@MainActor
final class PreflightStub {
  var failure: PreflightFailure?
  init(_ failure: PreflightFailure?) { self.failure = failure }
}

@MainActor
struct ProcessSupervisorTests {
  let launcher = FakeLauncher()
  let scheduler = FakeScheduler()

  func supervisor(
    preflight: @escaping @MainActor () -> PreflightFailure? = { nil },
    backoff: BackoffPolicy = BackoffPolicy(initial: 1, multiplier: 2, maximum: 8, stableAfter: 30, maxAttempts: 4)
  ) -> ProcessSupervisor {
    ProcessSupervisor(
      configuration: .init(
        spec: { LaunchSpec(executable: URL(fileURLWithPath: "/fake/node"), arguments: ["serve"], environment: [:]) },
        preflight: preflight,
        isReadyLine: { ServerOutput.listeningPort(in: $0) != nil },
        isFatalLine: ServerOutput.isFatal,
        isErrorLine: ServerOutput.isError,
        backoff: backoff,
        stopTimeout: 10),
      launcher: launcher, scheduler: scheduler)
  }

  @Test func startsThenRunsOnTheReadyLine() {
    let sut = supervisor()
    var seen: [SupervisorState] = []
    sut.onStateChange = { seen.append($0) }
    sut.start()
    #expect(sut.state == .starting(pid: 100))
    launcher.current?.say("hivemind on http://127.0.0.1:7420")
    #expect(sut.state == .running(pid: 100, since: scheduler.clock))
    #expect(seen.count == 2)
    sut.start()
    #expect(launcher.launched.count == 1, "a second start while running is a no-op")
  }

  @Test func forwardsEveryLineToTheLog() {
    let sut = supervisor()
    var lines: [String] = []
    sut.onOutput = { lines.append("\($0 == .stderr ? "err" : "out"):\($1)") }
    sut.start()
    launcher.current?.say("hello", on: .stdout)
    launcher.current?.say("hivemind on http://127.0.0.1:7420")
    #expect(lines == ["out:hello", "err:hivemind on http://127.0.0.1:7420"])
  }

  @Test func stopSendsSigtermAndCompletes() {
    let sut = supervisor()
    sut.start()
    launcher.current?.say("hivemind on http://127.0.0.1:7420")
    var done = false
    sut.stop { done = true }
    #expect(launcher.current?.terminated == 1)
    #expect(launcher.current?.killed == 0)
    #expect(sut.state == .stopped)
    #expect(done)
    scheduler.advance(60)
    #expect(launcher.launched.count == 1, "a requested stop never restarts")
  }

  @Test func stopEscalatesToSigkillAfterTheTimeout() {
    let sut = supervisor()
    sut.start()
    let child = launcher.current!
    child.exitsOnTerminate = false
    var done = false
    sut.stop { done = true }
    #expect(sut.state == .stopping(pid: 100))
    scheduler.advance(9.9)
    #expect(child.killed == 0)
    scheduler.advance(0.2)
    #expect(child.killed == 1)
    #expect(sut.state == .stopped)
    #expect(done)
  }

  @Test func crashRestartsWithExponentialBackoff() {
    let sut = supervisor()
    sut.start()
    launcher.current?.crash()
    #expect(sut.state == .waitingToRestart(attempt: 1, at: scheduler.clock.addingTimeInterval(1)))
    scheduler.advance(1)
    #expect(launcher.launched.count == 2)
    launcher.current?.crash()
    #expect(sut.state == .waitingToRestart(attempt: 2, at: scheduler.clock.addingTimeInterval(2)))
    scheduler.advance(1.9)
    #expect(launcher.launched.count == 2)
    scheduler.advance(0.1)
    #expect(launcher.launched.count == 3)
  }

  @Test func givesUpAfterMaxAttemptsWithTheLastError() {
    let sut = supervisor()
    sut.start()
    for _ in 0..<4 {
      launcher.current?.say("Error: database disk image is malformed")
      launcher.current?.say("    at Hive.open (file:///x.js:1:1)")
      launcher.current?.say("Node.js v24.21.0")
      launcher.current?.crash()
      scheduler.advance(10)
    }
    launcher.current?.crash()
    #expect(sut.state == .failed("Error: database disk image is malformed"))
    #expect(sut.lastErrorLine == "Error: database disk image is malformed")
    scheduler.advance(120)
    #expect(launcher.launched.count == 5)
  }

  @Test func aStableRunResetsTheBackoff() {
    let sut = supervisor()
    sut.start()
    launcher.current?.crash()
    scheduler.advance(1)
    launcher.current?.crash()
    scheduler.advance(2)
    #expect(launcher.launched.count == 3)
    scheduler.advance(31)
    launcher.current?.crash()
    #expect(sut.state == .waitingToRestart(attempt: 1, at: scheduler.clock.addingTimeInterval(1)))
  }

  @Test func aFatalLineStopsRetrying() {
    let sut = supervisor()
    sut.start()
    launcher.current?.say("Another Hivemind server (pid 42) is already running for HIVEMIND_HOME /x. Stop it first.")
    launcher.current?.crash()
    #expect(sut.state == .failed("Another Hivemind server (pid 42) is already running for HIVEMIND_HOME /x. Stop it first."))
    scheduler.advance(60)
    #expect(launcher.launched.count == 1)
  }

  @Test func readyClearsTheLastError() {
    let sut = supervisor()
    sut.start()
    launcher.current?.say("Error: boom")
    launcher.current?.crash()
    #expect(sut.lastErrorLine == "Error: boom")
    scheduler.advance(1)
    launcher.current?.say("hivemind on http://127.0.0.1:7420")
    #expect(sut.lastErrorLine == nil)
  }

  @Test func preflightRefusesToLaunch() {
    let preflight = PreflightStub(.dataFolderInUse(pid: 7, dataHome: "/data"))
    let sut = supervisor(preflight: { preflight.failure })
    sut.start()
    #expect(launcher.launched.isEmpty)
    #expect(sut.state == .failed("Another Hivemind server (pid 7) is already using /data"))
    preflight.failure = nil
    sut.start()
    #expect(sut.state == .starting(pid: 100))
  }

  @Test func preflightAlsoGuardsRestarts() {
    let preflight = PreflightStub(nil)
    let sut = supervisor(preflight: { preflight.failure })
    sut.start()
    preflight.failure = .portInUse(ServerPort(7420)!)
    launcher.current?.crash()
    scheduler.advance(1)
    #expect(sut.state == .failed("Port 7420 is already in use"))
    #expect(launcher.launched.count == 1)
  }

  @Test func launchFailureIsReported() {
    launcher.fail = true
    let sut = supervisor()
    sut.start()
    #expect(sut.state == .failed("Could not launch: no such file"))
  }

  @Test func stopWhileWaitingCancelsTheRestart() {
    let sut = supervisor()
    sut.start()
    launcher.current?.crash()
    var done = false
    sut.stop { done = true }
    #expect(done)
    #expect(sut.state == .stopped)
    scheduler.advance(60)
    #expect(launcher.launched.count == 1)
  }

  @Test func userStartWhileWaitingLaunchesNowAndResetsAttempts() {
    let sut = supervisor()
    sut.start()
    launcher.current?.crash()
    scheduler.advance(1)
    launcher.current?.crash()
    sut.start()
    #expect(launcher.launched.count == 3)
    scheduler.advance(60)
    #expect(launcher.launched.count == 3, "the cancelled restart never fires")
    launcher.current?.crash()
    #expect(sut.state == .waitingToRestart(attempt: 1, at: scheduler.clock.addingTimeInterval(1)))
  }

  @Test func restartStopsThenStartsAgain() {
    let sut = supervisor()
    sut.start()
    launcher.current?.say("hivemind on http://127.0.0.1:7420")
    sut.restart()
    #expect(launcher.launched.count == 2)
    #expect(launcher.launched[0].terminated == 1)
    #expect(sut.state == .starting(pid: 101))
  }

  @Test func restartWaitsForASlowStop() {
    let sut = supervisor()
    sut.start()
    launcher.current?.exitsOnTerminate = false
    sut.restart()
    #expect(sut.state == .stopping(pid: 100))
    #expect(launcher.launched.count == 1)
    scheduler.advance(10)
    #expect(launcher.launched.count == 2)
  }

  @Test func lateCallbacksFromAnOldChildAreIgnored() {
    let sut = supervisor()
    sut.start()
    let old = launcher.current!
    old.crash()
    scheduler.advance(1)
    old.say("hivemind on http://127.0.0.1:7420")
    old.crash()
    #expect(sut.state == .starting(pid: 101))
  }

  @Test func exitStatusIsTheReasonWithoutAnErrorLine() {
    let sut = supervisor(backoff: BackoffPolicy(maxAttempts: 0))
    sut.start()
    launcher.current?.crash(status: 3)
    #expect(sut.state == .failed("Server exited with status 3"))
  }
}
