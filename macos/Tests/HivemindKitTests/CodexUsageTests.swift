import Foundation
import Testing
@testable import HivemindKit

// The Codex usage parser (docs/accounts.md, "Usage") over the probe of spike 0.3 (#320): the subscriber's replies, the
// exhausted variant and the error variants. Fake values only; pure lines, no process.

private let fakeEmail = "fake.person@example.com"

/// The subscriber's replies as codex 0.162.1 sent them, in arrival order: the initialize reply, a notification, the
/// rate-limit reply, then the account reply. The account reply carries an email the parser must not keep.
private let subscriberLines = [
  #"{"id":1,"result":{"userAgent":"hivemind_usage_probe/0.162.1 (Mac OS 26.5.1; arm64)","codexHome":"/private/var/folders/xx/T/tmp.FAKE","platformFamily":"unix","platformOs":"macos"}}"#,
  #"{"method":"remoteControl/status/changed","params":{"status":"disabled","serverName":"Mac.local","installationId":"00000000-0000-4000-8000-000000000000","environmentId":null},"emittedAtMs":1791802891368}"#,
  #"{"id":3,"result":{"accountId":"acct_fake","ordinaryUsageAllowed":true,"rateLimits":{"limitId":"codex","limitName":null,"normalModelSlug":null,"primary":{"usedPercent":42,"windowDurationMins":300,"resetsAt":1791820800},"secondary":{"usedPercent":17,"windowDurationMins":10080,"resetsAt":1792252800},"credits":{"hasCredits":false,"unlimited":false,"balance":null},"individualLimit":null,"spendControlReached":null,"planType":"plus","rateLimitReachedType":null},"rateLimitsByLimitId":{"codex":{"limitId":"codex","limitName":null,"normalModelSlug":null,"primary":{"usedPercent":42,"windowDurationMins":300,"resetsAt":1791820800},"secondary":{"usedPercent":17,"windowDurationMins":10080,"resetsAt":1792252800},"credits":null,"individualLimit":null,"spendControlReached":null,"planType":"plus","rateLimitReachedType":null},"codex_other":{"limitId":"codex_other","limitName":"codex_other","normalModelSlug":null,"primary":{"usedPercent":88,"windowDurationMins":30,"resetsAt":1791810000},"secondary":null,"credits":null,"individualLimit":null,"spendControlReached":null,"planType":"plus","rateLimitReachedType":null}},"rateLimitResetCredits":{"availableCount":0,"credits":null}}}"#,
  #"{"id":2,"result":{"account":{"type":"chatgpt","email":"\#(fakeEmail)","planType":"plus"},"requiresOpenaiAuth":true,"workspaceRouting":null}}"#,
]

/// The windows of `subscriberLines`: the main bucket, then the extra bucket `codex_other` with no secondary window.
private let subscriberWindows = [
  UsageWindow(key: "codex.primary", label: "5 h", usedPercent: 42, resetsAt: 1_791_820_800_000, windowMs: 18_000_000),
  UsageWindow(key: "codex.secondary", label: "Week", usedPercent: 17, resetsAt: 1_792_252_800_000, windowMs: 604_800_000),
  UsageWindow(key: "codex_other.primary", label: "codex_other 30 min", usedPercent: 88, resetsAt: 1_791_810_000_000, windowMs: 1_800_000),
]

/// The init reply, which the parser never reads.
private let initLine = subscriberLines[0]

/// A rate-limit reply with `primary` and `secondary` as the main bucket's windows and no other bucket.
private func rateLimitsLine(primary: String, secondary: String) -> String {
  #"{"id":3,"result":{"rateLimits":{"limitId":"codex","limitName":null,"primary":\#(primary),"secondary":\#(secondary)}}}"#
}

/// An account reply with the given account object, or `null` for none.
private func accountLine(_ account: String) -> String {
  #"{"id":2,"result":{"account":\#(account),"requiresOpenaiAuth":true,"workspaceRouting":null}}"#
}

/// The parse of `lines`, unwrapped; the test fails when the probe is an error.
private func probe(_ lines: [String]) throws -> CodexUsageProbe {
  try #require(try? CodexUsage.parseCodexProbe(lines: lines).get())
}

struct CodexUsageTests {
  @Test func subscriberRepliesGiveThePlanAndTheWindows() {
    #expect(CodexUsage.parseCodexProbe(lines: subscriberLines) == .success(CodexUsageProbe(plan: "subscription", windows: subscriberWindows)))
  }

  @Test func repliesMatchByIdInAnyOrderAndOtherLinesAreIgnored() {
    let expected = Result<CodexUsageProbe, CodexUsageError>.success(CodexUsageProbe(plan: "subscription", windows: subscriberWindows))
    #expect(CodexUsage.parseCodexProbe(lines: ["not json"] + subscriberLines.reversed()) == expected)
    #expect(CodexUsage.parseCodexProbe(lines: [subscriberLines[3], subscriberLines[2], initLine]) == expected)
  }

  @Test func aServerRequestWithAReplyIdIsNotTakenForTheReply() {
    let serverRequest = #"{"id":3,"method":"item/tool/requestUserInput","params":{}}"#
    let expected = Result<CodexUsageProbe, CodexUsageError>.success(CodexUsageProbe(plan: "subscription", windows: subscriberWindows))
    #expect(CodexUsage.parseCodexProbe(lines: [serverRequest] + subscriberLines) == expected)
  }

  @Test func aMainBucketWithoutALimitIdIsCodex() throws {
    let lines = subscriberLines.map {
      $0.replacingOccurrences(of: #""rateLimits":{"limitId":"codex","#, with: #""rateLimits":{"limitId":null,"#)
    }
    #expect(lines != subscriberLines, "the variant changes the fixture")
    #expect(try probe(lines).windows == subscriberWindows)
  }

  @Test func exhaustedWindowIsKeptAtOneHundredPercent() {
    let exhausted = subscriberLines.map {
      $0.replacingOccurrences(of: #""usedPercent":42,"#, with: #""usedPercent":100,"#)
        .replacingOccurrences(of: #""ordinaryUsageAllowed":true"#, with: #""ordinaryUsageAllowed":false"#)
        .replacingOccurrences(of: #""rateLimitReachedType":null"#, with: #""rateLimitReachedType":"rate_limit_reached""#)
    }
    #expect(exhausted != subscriberLines, "the exhausted variant changes the fixture")
    let parsed = CodexUsage.parseCodexProbe(lines: exhausted)
    #expect(parsed == .success(CodexUsageProbe(plan: "subscription", windows: [
      UsageWindow(key: "codex.primary", label: "5 h", usedPercent: 100, resetsAt: 1_791_820_800_000, windowMs: 18_000_000),
      subscriberWindows[1],
      subscriberWindows[2],
    ])))
  }

  @Test func notLoggedInIsAFailure() {
    let lines = [initLine, #"{"id":3,"error":{"code":-32600,"message":"codex account authentication required to read rate limits"}}"#, accountLine("null")]
    #expect(CodexUsage.parseCodexProbe(lines: lines) == .failure(.notLoggedIn))
  }

  @Test func apiKeyLoginHasAnApiKeyPlanAndNoWindows() {
    let lines = [
      initLine,
      #"{"id":3,"error":{"code":-32600,"message":"chatgpt authentication required to read rate limits"}}"#,
      accountLine(#"{"type":"apiKey"}"#),
    ]
    #expect(CodexUsage.parseCodexProbe(lines: lines) == .success(CodexUsageProbe(plan: "api-key", windows: [])))
  }

  @Test func otherErrorsAndAMissingRateLimitReplyAreAReadFailure() {
    let backend = #"{"id":3,"error":{"code":-32603,"message":"failed to fetch codex rate limits: 503"}}"#
    let notInitialized = #"{"id":3,"error":{"code":-32600,"message":"Not initialized"}}"#
    #expect(CodexUsage.parseCodexProbe(lines: [initLine, backend, accountLine("null")]) == .failure(.readFailed))
    #expect(CodexUsage.parseCodexProbe(lines: [initLine, notInitialized]) == .failure(.readFailed))
    #expect(CodexUsage.parseCodexProbe(lines: [initLine, subscriberLines[3]]) == .failure(.readFailed))
    #expect(CodexUsage.parseCodexProbe(lines: []) == .failure(.readFailed))
  }

  @Test func errorMessagesAreFixedText() {
    #expect(CodexUsageError.notLoggedIn.message == "Not logged in")
    #expect(CodexUsageError.readFailed.message == "Usage read failed")
  }

  @Test func planFollowsTheAccountType() throws {
    let rateLimits = subscriberLines[2]
    let plans = [
      (#"{"type":"chatgpt","email":"\#(fakeEmail)"}"#, "subscription"),
      (#"{"type":"apiKey"}"#, "api-key"),
      (#"{"type":"enterprise"}"#, "unknown"),
      (#"{"email":"\#(fakeEmail)"}"#, "unknown"),
      ("null", "unknown"),
    ]
    for (account, plan) in plans {
      #expect(try probe([initLine, rateLimits, accountLine(account)]).plan == plan, "\(account)")
    }
  }

  @Test func windowLengthsGiveTheirLabels() throws {
    let lines = [
      initLine,
      #"{"id":3,"result":{"rateLimits":{"limitId":"codex","limitName":null,"primary":{"usedPercent":1,"windowDurationMins":null,"resetsAt":null},"secondary":{"usedPercent":2,"windowDurationMins":43200,"resetsAt":1792252800}},"rateLimitsByLimitId":{"beta":{"limitId":"beta","limitName":null,"primary":{"usedPercent":3,"windowDurationMins":10080,"resetsAt":1792252800},"secondary":{"usedPercent":4,"windowDurationMins":30,"resetsAt":null}}}}}"#,
      accountLine("null"),
    ]
    #expect(try probe(lines).windows == [
      UsageWindow(key: "codex.primary", label: "Primary", usedPercent: 1, resetsAt: nil),
      UsageWindow(key: "codex.secondary", label: "Month", usedPercent: 2, resetsAt: 1_792_252_800_000, windowMs: 2_592_000_000),
      UsageWindow(key: "beta.primary", label: "beta Week", usedPercent: 3, resetsAt: 1_792_252_800_000, windowMs: 604_800_000),
      UsageWindow(key: "beta.secondary", label: "beta 30 min", usedPercent: 4, resetsAt: nil, windowMs: 1_800_000),
    ])
  }

  @Test func dayLengthIsDay() throws {
    let lines = [initLine, rateLimitsLine(primary: #"{"usedPercent":5,"windowDurationMins":1440,"resetsAt":1792252800}"#, secondary: "null"), accountLine("null")]
    #expect(try probe(lines).windows == [UsageWindow(key: "codex.primary", label: "Day", usedPercent: 5, resetsAt: 1_792_252_800_000, windowMs: 86_400_000)])
  }

  @Test func usedPercentIsClampedAndAMissingResetStaysNil() throws {
    let lines = [initLine, rateLimitsLine(
      primary: #"{"usedPercent":140,"windowDurationMins":300,"resetsAt":null}"#,
      secondary: #"{"usedPercent":-5,"windowDurationMins":10080,"resetsAt":1792252800}"#
    ), accountLine("null")]
    #expect(try probe(lines).windows == [
      UsageWindow(key: "codex.primary", label: "5 h", usedPercent: 100, resetsAt: nil, windowMs: 18_000_000),
      UsageWindow(key: "codex.secondary", label: "Week", usedPercent: 0, resetsAt: 1_792_252_800_000, windowMs: 604_800_000),
    ])
  }

  @Test func windowsAreCappedAtEight() throws {
    let extras = (1...4).map {
      #""b\#($0)":{"limitId":"b\#($0)","limitName":null,"primary":{"usedPercent":\#($0),"windowDurationMins":300,"resetsAt":null},"secondary":{"usedPercent":\#($0),"windowDurationMins":10080,"resetsAt":null}}"#
    }.joined(separator: ",")
    let lines = [
      initLine,
      #"{"id":3,"result":{"rateLimits":{"limitId":"codex","limitName":null,"primary":{"usedPercent":1,"windowDurationMins":300,"resetsAt":null},"secondary":{"usedPercent":2,"windowDurationMins":10080,"resetsAt":null}},"rateLimitsByLimitId":{\#(extras)}}}"#,
      accountLine("null"),
    ]
    #expect(try probe(lines).windows.map(\.key) == [
      "codex.primary", "codex.secondary",
      "b1.primary", "b1.secondary", "b2.primary", "b2.secondary", "b3.primary", "b3.secondary",
    ])
  }

  @Test func aWindowTheSchemaWouldRefuseIsLeftOut() throws {
    let edgeId = String(repeating: "e", count: 56)
    let longId = String(repeating: "x", count: 57)
    let longName = String(repeating: "n", count: 80)
    let lines = [
      initLine,
      #"{"id":3,"result":{"rateLimits":{"limitId":"codex","limitName":null,"primary":{"usedPercent":1,"windowDurationMins":300,"resetsAt":null},"secondary":null},"rateLimitsByLimitId":{"\#(edgeId)":{"limitId":"\#(edgeId)","limitName":"edge","primary":{"usedPercent":4,"windowDurationMins":300,"resetsAt":null},"secondary":null},"\#(longId)":{"limitId":"\#(longId)","limitName":"ok","primary":{"usedPercent":2,"windowDurationMins":300,"resetsAt":null},"secondary":null},"named":{"limitId":"named","limitName":"\#(longName)","primary":{"usedPercent":3,"windowDurationMins":300,"resetsAt":null},"secondary":null}}}}"#,
      accountLine("null"),
    ]
    #expect(try probe(lines).windows == [
      UsageWindow(key: "codex.primary", label: "5 h", usedPercent: 1, resetsAt: nil, windowMs: 18_000_000),
      UsageWindow(key: "\(edgeId).primary", label: "edge 5 h", usedPercent: 4, resetsAt: nil, windowMs: 18_000_000),
    ])
  }

  @Test func parsedResultHoldsNoEmail() {
    let output = String(describing: CodexUsage.parseCodexProbe(lines: subscriberLines))
    #expect(!output.isEmpty)
    #expect(!output.contains(fakeEmail), "the email reached the parsed result")
  }
}
