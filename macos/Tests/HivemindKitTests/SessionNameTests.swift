import Foundation
import Testing
@testable import HivemindKit

struct SessionNameTests {
  @Test func acceptsOnlyThePattern() {
    for good in ["hm-a", "hm-acme-atlas", "hm-0", "hm-acme-new-1", "hm-" + String(repeating: "a", count: 79), "hm-a-"] {
      #expect(SessionName(good)?.rawValue == good, "\(good)")
    }
    for bad in ["", "hm-", "hm--a", "hm-A", "HM-a", "hm_a", "hm-a b", "hm-a.b", "hm-a;", "hm-a\n", "xhm-a", " hm-a",
                "hm-" + String(repeating: "a", count: 80), "hm-é", "hm-a\0", "=hm-a", "hm-ａ"] {
      #expect(SessionName(bad) == nil, "\(bad)")
    }
    #expect(SessionName.maxLength == 82)
  }

  @Test func namesAnAgentsSession() {
    #expect(SessionName(project: "acme", agent: "Atlas").rawValue == "hm-acme-atlas")
    #expect(SessionName(project: "my-app", agent: "Anne Marie").rawValue == "hm-my-app-anne-marie")
    #expect(SessionName(project: "acme", agent: "Änne_Marie!!").rawValue == "hm-acme-anne-marie")
    #expect(SessionName(project: "acme", agent: "  --Bea--  ").rawValue == "hm-acme-bea")
    #expect(SessionName(project: "acme", agent: "日本").rawValue == "hm-acme-agent")
    #expect(SessionName(project: "", agent: "").rawValue == "hm-project-agent")
    #expect(SessionName(project: "Acme Corp", agent: "x").rawValue == "hm-acme-corp-x")
    #expect(SessionName(project: "acme", agent: "Worker12").rawValue == "hm-acme-worker12")
  }

  @Test func anAgentCalledNewNCannotTakeANewAgentsName() {
    #expect(SessionName(project: "acme", agent: "new-1").rawValue == "hm-acme-a-new-1")
    #expect(SessionName(project: "acme", agent: "New 2").rawValue == "hm-acme-a-new-2")
    #expect(SessionName(project: "acme", agent: "newt").rawValue == "hm-acme-newt")
    #expect(SessionName(project: "acme", agent: "new-x").rawValue == "hm-acme-new-x")
  }

  @Test func everyNameIsValidAndFits() {
    let long = String(repeating: "Ab-", count: 60)
    for (project, agent) in [(long, long), ("a", long), (long, "b"), ("x", String(repeating: "é", count: 200)), ("-", "-")] {
      let name = SessionName(project: project, agent: agent)
      #expect(SessionName.isValid(name.rawValue), "\(name)")
      #expect(!name.rawValue.hasSuffix("-"))
      #expect(SessionName(project: project, newAgent: 999_999).rawValue.utf8.count <= SessionName.maxLength)
    }
    let longest = SessionName(project: String(repeating: "p", count: 40), agent: String(repeating: "a", count: 90))
    #expect(longest.rawValue == "hm-" + String(repeating: "p", count: 32) + "-" + String(repeating: "a", count: 46))
    #expect(longest.rawValue.count == SessionName.maxLength)
  }

  @Test func allocatesTheFirstFreeNewAgentName() {
    #expect(SessionName(project: "acme", newAgent: 3).rawValue == "hm-acme-new-3")
    #expect(SessionName(project: "acme", newAgent: 0).rawValue == "hm-acme-new-1")
    #expect(SessionName.newAgent(project: "acme", existing: []).rawValue == "hm-acme-new-1")
    let existing = ["hm-acme-new-1", "hm-acme-new-2", "hm-acme-new-4", "hm-other-new-3"].compactMap(SessionName.init)
    #expect(SessionName.newAgent(project: "acme", existing: existing).rawValue == "hm-acme-new-3")
  }

  @Test func targetsAreExact() {
    #expect(SessionName("hm-acme")!.target == "=hm-acme")
  }

  @Test func codableValidates() throws {
    let name = SessionName("hm-acme-atlas")!
    #expect(try JSONDecoder().decode(SessionName.self, from: JSONEncoder().encode(name)) == name)
    #expect(throws: DecodingError.self) { try JSONDecoder().decode(SessionName.self, from: Data(#""hm-A""#.utf8)) }
  }
}
