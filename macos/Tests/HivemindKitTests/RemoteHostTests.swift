import Foundation
import Testing
@testable import HivemindKit

// hosts.json and what Add Host takes (docs/remote-hosts.md#hosts), in a temp folder.

@Suite("Remote hosts")
struct RemoteHostTests {
  @Test func addHostTrimsTheFieldsAndStoresEachForwardAsItsFlagAndSpec() throws {
    let host = try RemoteHost.entered(label: "  Build Mac ", ssh: " user@mini.local\n",
                                      forwards: "-R 1080\n-L5432:db.internal:5432  -D 1081")
    #expect(host.label == "Build Mac")
    #expect(host.ssh == "user@mini.local")
    #expect(host.forwards == ["-R 1080", "-L 5432:db.internal:5432", "-D 1081"])
    #expect(host.forwardArguments == ["-R", "1080", "-L", "5432:db.internal:5432", "-D", "1081"])
    #expect(UUID(uuidString: host.id) != nil && host.id == host.id.lowercased())
    #expect(try RemoteHost.entered(label: "Mini", ssh: "mini", forwards: "").forwards == [])
  }

  @Test(arguments: [
    ("", "user@mini.local", "", "A host’s name is 1–80 characters"),
    (String(repeating: "a", count: 81), "user@mini.local", "", "A host’s name is 1–80 characters"),
    ("Mini", "", "", "Enter the SSH destination: user@mini.local, or a Host from ~/.ssh/config"),
    ("Mini", "-oProxyCommand=evil", "", "The SSH destination cannot start with -"),
    ("Mini", "user@mini.local extra", "", "The SSH destination cannot hold spaces or control characters"),
    ("Mini", "mini", "-o ProxyCommand=evil", "“-o” is not a forward: each one starts with -L, -R or -D"),
    ("Mini", "mini", "1080", "“1080” is not a forward: each one starts with -L, -R or -D"),
    ("Mini", "mini", "-R", "-R needs its spec, as ssh takes it (-R 1080)"),
    ("Mini", "mini", "-R -L 1080", "-R needs its spec, as ssh takes it (-R 1080)"),
  ])
  func addHostRefuses(label: String, ssh: String, forwards: String, message: String) {
    #expect(throws: BrokerFiles.Failure(message)) { try RemoteHost.entered(label: label, ssh: ssh, forwards: forwards) }
  }

  @Test func aStoredForwardMustStayOneFlagAndOneSpec() {
    for forward in ["-R", "-R 1080 -L 1", "-o 1080", "-R -1080", "-R  1080"] {
      #expect(throws: BrokerFiles.Failure.self) { try RemoteHost(label: "Mini", ssh: "mini", forwards: [forward]).validate() }
    }
    let many = Array(repeating: "-R 1080", count: RemoteHost.maxForwards + 1)
    #expect(throws: BrokerFiles.Failure("A host has at most 16 extra forwards")) {
      try RemoteHost(label: "Mini", ssh: "mini", forwards: many).validate()
    }
    #expect(throws: BrokerFiles.Failure("The host id is not a lowercase UUID")) {
      try RemoteHost(id: "not-a-uuid", label: "Mini", ssh: "mini").validate()
    }
  }

  @Test func theStoreKeepsHostsInAPrivateFileAndAMissingOneIsNoHost() throws {
    let home = try temporaryHome()
    defer { try? FileManager.default.removeItem(at: home) }
    let paths = HivemindPaths(home: home)
    let store = RemoteHostStore(paths: paths)
    #expect(try store.load() == [])
    #expect(!FileManager.default.fileExists(atPath: paths.hostsFile.path), "loading writes nothing")
    let other = RemoteHost(id: "20000000-0000-4000-8000-000000000002", label: "Other", ssh: "other")
    try store.save([fakeHost, other])
    #expect(try store.load() == [fakeHost, other])
    let mode = try FileManager.default.attributesOfItem(atPath: paths.hostsFile.path)[.posixPermissions] as? Int
    #expect(mode == 0o600)
    let folder = try FileManager.default.attributesOfItem(atPath: paths.appSupport.path)[.posixPermissions] as? Int
    #expect(folder == 0o700)
    let json = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: paths.hostsFile)) as? [String: Any])
    let first = try #require((json["hosts"] as? [[String: Any]])?.first)
    #expect(Set(first.keys) == ["id", "label", "ssh", "forwards"])
  }

  @Test func aFileThatCannotBeReadOrHoldsABadHostIsAnErrorNotNoHost() throws {
    let home = try temporaryHome()
    defer { try? FileManager.default.removeItem(at: home) }
    let paths = HivemindPaths(home: home)
    try FileManager.default.createDirectory(at: paths.appSupport, withIntermediateDirectories: true)
    try Data("{".utf8).write(to: paths.hostsFile)
    #expect(throws: BrokerFiles.Failure("\(paths.hostsFile.path) cannot be read. Move it away to add hosts again.")) {
      try RemoteHostStore(paths: paths).load()
    }
    try Data(#"{"hosts":[{"id":"20000000-0000-4000-8000-000000000001","label":"Mini","ssh":"-oEvil","forwards":[]}]}"#.utf8)
      .write(to: paths.hostsFile)
    #expect(throws: BrokerFiles.Failure.self) { try RemoteHostStore(paths: paths).load() }
  }
}
