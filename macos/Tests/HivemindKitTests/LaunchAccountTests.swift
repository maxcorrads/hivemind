import Foundation
import Testing
@testable import HivemindKit

// A launch's account (docs/accounts.md): the same path rules and variables as the page
// (src/shared/account-paths.vectors.json), validation and the wire shape. Pure values only.

private struct AccountVectors: Decodable {
  struct Invalid: Decodable {
    let path: String
    let problem: String
  }

  struct Pair: Decodable, Equatable {
    let name: String
    let value: String
  }

  struct Case: Decodable {
    struct Account: Decodable {
      let driver: LaunchAccount.Driver
      let homePath: String
      let shadowPath: String
    }

    let account: Account
    let environment: [Pair]
  }

  let limits: [String: Int]
  let controlledEnv: [String: [String]]
  let validPaths: [String]
  let invalidPaths: [Invalid]
  let environments: [Case]

  static func load() throws -> AccountVectors {
    // macos/Tests/HivemindKitTests/ → the repository's src/shared/.
    let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
      .deletingLastPathComponent().appendingPathComponent("src/shared/account-paths.vectors.json")
    return try JSONDecoder().decode(AccountVectors.self, from: Data(contentsOf: url))
  }
}

private func account(_ driver: LaunchAccount.Driver = .codex, id: String = "00000000-0000-4000-8000-000000000001", label: String = "Work",
                     homePath: String = "", shadowPath: String = "") -> LaunchAccount {
  LaunchAccount(id: id, driver: driver, label: label, homePath: homePath, shadowPath: shadowPath)
}

/// validate()'s message, or nil when it passes.
private func problem(_ account: LaunchAccount) -> String? {
  do {
    try account.validate()
    return nil
  } catch {
    #expect(error.code == .badMessage)
    return error.message
  }
}

struct LaunchAccountTests {
  @Test func followsTheSamePathRulesAsThePage() throws {
    let vectors = try AccountVectors.load()
    #expect(vectors.limits["label"] == LaunchAccount.maxLabelLength)
    #expect(vectors.limits["path"] == LaunchAccount.maxPathBytes)
    #expect(vectors.controlledEnv == Dictionary(uniqueKeysWithValues: LaunchAccount.Driver.allCases.map { ($0.rawValue, $0.controlledNames) }))
    #expect(vectors.validPaths.count >= 20 && vectors.invalidPaths.count >= 25)
    for path in vectors.validPaths {
      #expect(LaunchAccount.pathProblem(path) == nil, "\(path.debugDescription)")
      #expect(problem(account(.claude, homePath: path)) == nil, "\(path.debugDescription)")
    }
    for invalid in vectors.invalidPaths {
      #expect(LaunchAccount.pathProblem(invalid.path) == invalid.problem, "\(invalid.path.debugDescription)")
      #expect(problem(account(homePath: invalid.path)) == "account.homePath: \(invalid.problem)")
      #expect(problem(account(.claude, shadowPath: invalid.path)) == "account.shadowPath: \(invalid.problem)")
    }
  }

  @Test func aPathIsAtMost1024Bytes() {
    let max = LaunchAccount.maxPathBytes
    #expect(LaunchAccount.pathProblem("/" + String(repeating: "a", count: max - 1)) == nil)
    #expect(LaunchAccount.pathProblem("~/" + String(repeating: "a", count: max - 2)) == nil)
    #expect(LaunchAccount.pathProblem("/" + String(repeating: "a", count: max)) == "a path is at most 1024 bytes")
    #expect(LaunchAccount.pathProblem("/" + String(repeating: "é", count: 511) + "a") == nil, "1,024 bytes in 513 characters")
    #expect(LaunchAccount.pathProblem("/" + String(repeating: "é", count: 512)) == "a path is at most 1024 bytes", "bytes, not characters")
  }

  @Test func buildsTheSameVariablesAsThePageWithTheHomeExpanded() throws {
    let vectors = try AccountVectors.load()
    #expect(vectors.environments.count >= 8)
    for item in vectors.environments {
      let launch = account(item.account.driver, homePath: item.account.homePath, shadowPath: item.account.shadowPath)
      let expected = item.environment.map { pair in
        AccountVectors.Pair(name: pair.name, value: pair.value.hasPrefix("~/") ? "/Users/test" + pair.value.dropFirst() : pair.value)
      }
      for home in ["/Users/test", "/Users/test/"] {
        let pairs = launch.environment(home: home).map { AccountVectors.Pair(name: $0.name, value: $0.value) }
        #expect(pairs == expected, "\(item.account.driver) \(item.account.homePath.debugDescription) \(item.account.shadowPath.debugDescription)")
      }
      for pair in launch.environment(home: "/Users/test") { #expect(launch.controlledNames.contains(pair.name)) }
    }
    // Only a leading "~/" is expanded, scalar by scalar.
    #expect(account(.claude, homePath: "/a/~/b").environment(home: "/h").map { $0.value } == ["/a/~/b"])
    #expect(account(.claude, homePath: "~/\u{301}x").environment(home: "/h").map { $0.value } == ["/h/\u{301}x"])
  }

  @Test func checksTheIdTheLabelAndThatAShadowIsNotTheSharedTree() {
    #expect(problem(account()) == nil)
    #expect(problem(account(id: "")) == "account.id: must be 1–64 bytes")
    #expect(problem(account(id: String(repeating: "a", count: 65))) == "account.id: must be 1–64 bytes")
    #expect(problem(account(label: String(repeating: "x", count: 80))) == nil)
    #expect(problem(account(label: String(repeating: "😀", count: 40))) == nil, "80 UTF-16 code units, as the page counts")
    for label in ["", "   ", String(repeating: "x", count: 81), String(repeating: "😀", count: 41)] {
      #expect(problem(account(label: label)) == "account.label: must be 1–80 characters", "\(label.debugDescription)")
    }
    let shared = "account.shadowPath: a shadow is its own directory, not the shared tree"
    #expect(problem(account(.codex, shadowPath: "~/.codex")) == shared)
    #expect(problem(account(.claude, shadowPath: "~/.claude")) == shared)
    #expect(problem(account(.codex, homePath: "~/.c", shadowPath: "~/.c")) == shared)
    #expect(problem(account(.claude, homePath: "/caf\u{E9}", shadowPath: "/cafe\u{301}")) == shared, "canonically equal")
    #expect(problem(account(.claude, homePath: "~/.claude")) == nil, "a primary may name the default tree")
    #expect(problem(account(.codex, homePath: "~/.codex", shadowPath: "~/.claude")) == nil)
    #expect(problem(account(.codex, shadowPath: "~/.codex_personal")) == nil)
  }

  @Test func controlsItsDriversVariables() {
    for driver in LaunchAccount.Driver.allCases {
      #expect(account(driver).controlledNames == driver.controlledNames)
      #expect(driver.controlledNames.first == driver.variable)
    }
    #expect(LaunchAccount.Driver.codex.controlledNames == ["CODEX_HOME", "CODEX_SQLITE_HOME", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"])
    #expect(LaunchAccount.Driver.claude.controlledNames
      == ["CLAUDE_CONFIG_DIR", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_SECURESTORAGE_CONFIG_DIR"])
  }

  @Test func travelsAsThePageSendsIt() throws {
    let json = #"{"driver":"claude","homePath":"","id":"a1","label":"Claude work","shadowPath":"~/.claude-work"}"#
    let decoded = try JSONDecoder().decode(LaunchAccount.self, from: Data(json.utf8))
    #expect(decoded == account(.claude, id: "a1", label: "Claude work", shadowPath: "~/.claude-work"))
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    #expect(String(decoding: try encoder.encode(decoded), as: UTF8.self) == json)
    for bad in [
      #"{"driver":"opencode","homePath":"","id":"a1","label":"x","shadowPath":""}"#,
      #"{"driver":"codex","id":"a1","label":"x","shadowPath":""}"#,
      #"{"driver":"codex","homePath":null,"id":"a1","label":"x","shadowPath":""}"#,
    ] {
      #expect(throws: DecodingError.self, "\(bad)") { try JSONDecoder().decode(LaunchAccount.self, from: Data(bad.utf8)) }
    }
  }
}
