import Foundation

// A second Mac on the local network, reached with SSH, where Hivemind runs brains and workers (docs/remote-hosts.md).
// Hosts are configured in Hivemind Server.app and stored there only, in hosts.json (0600): the server learns their id,
// label and status from the launcher channel (HostsService), never the SSH destination or the forwards.

/// One configured host, as hosts.json keeps it.
public struct RemoteHost: Codable, Equatable, Sendable, Identifiable {
  /// UTF-16 code units, as the page counts them (LaunchAccount.maxLabelLength).
  public static let maxLabelLength = 80
  /// UTF-8 bytes of the SSH destination.
  public static let maxDestinationBytes = 255
  /// Extra forwards one host may carry.
  public static let maxForwards = 16
  /// UTF-8 bytes of one forward's spec.
  public static let maxForwardBytes = 255
  /// The `ssh` flags a forward may start with: local, remote and dynamic forwarding.
  public static let forwardFlags: Set<String> = ["-L", "-R", "-D"]

  /// A lowercase UUID, stable for the life of the host.
  public let id: String
  /// What the UI shows, for example "Build Mac".
  public let label: String
  /// The destination as `ssh` takes it: `user@mini.local`, or a `Host` alias from `~/.ssh/config`.
  public let ssh: String
  /// Extra forwards added to the host connection, each a flag and its spec as `ssh` takes them (`-R 1080`,
  /// `-L 5432:db.internal:5432`). Hivemind passes them through and does not interpret them.
  public let forwards: [String]

  public init(id: String = UUID().uuidString.lowercased(), label: String, ssh: String, forwards: [String] = []) {
    self.id = id
    self.label = label
    self.ssh = ssh
    self.forwards = forwards
  }

  /// A host from what the user typed in Add Host: the label and destination trimmed, the forwards parsed
  /// (`forwards(from:)`), then validated.
  public static func entered(label: String, ssh: String, forwards: String) throws(BrokerFiles.Failure) -> RemoteHost {
    let host = RemoteHost(label: label.trimmingCharacters(in: .whitespacesAndNewlines),
                          ssh: ssh.trimmingCharacters(in: .whitespacesAndNewlines), forwards: try Self.forwards(from: forwards))
    try host.validate()
    return host
  }

  /// Why this host cannot be saved or connected, as the Add Host dialog shows it.
  public func validate() throws(BrokerFiles.Failure) {
    guard UUID(uuidString: id) != nil, id == id.lowercased() else { throw .init("The host id is not a lowercase UUID") }
    guard !label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, label.utf16.count <= Self.maxLabelLength,
          !Self.hasControl(label) else {
      throw .init("A host’s name is 1–\(Self.maxLabelLength) characters")
    }
    if let problem = Self.destinationProblem(ssh) { throw .init(problem) }
    guard forwards.count <= Self.maxForwards else { throw .init("A host has at most \(Self.maxForwards) extra forwards") }
    for forward in forwards {
      let parts = forward.split(separator: " ", omittingEmptySubsequences: false).map(String.init)
      guard parts.count == 2, Self.forwardFlags.contains(parts[0]) else {
        throw .init("“\(forward)” is not a forward: use -L, -R or -D and its spec, as ssh takes them")
      }
      if let problem = Self.specProblem(parts[1]) { throw .init(problem) }
    }
  }

  /// The forwards' `ssh` arguments, each flag then its spec.
  public var forwardArguments: [String] {
    forwards.flatMap { $0.split(separator: " ", maxSplits: 1).map(String.init) }
  }

  /// The forwards in `text` as Add Host takes them, separated by spaces or new lines: `-R 1080 -L 5432:db.internal:5432`,
  /// or with the spec joined to its flag (`-R1080`). Each is stored as its flag, a space and its spec.
  public static func forwards(from text: String) throws(BrokerFiles.Failure) -> [String] {
    var tokens = text.split(whereSeparator: { $0.isWhitespace }).map(String.init)[...]
    var forwards: [String] = []
    while let token = tokens.popFirst() {
      let flag = String(token.prefix(2))
      guard forwardFlags.contains(flag) else {
        throw .init("“\(token)” is not a forward: each one starts with -L, -R or -D")
      }
      let spec = token.count > 2 ? String(token.dropFirst(2)) : tokens.popFirst()
      guard let spec, !spec.hasPrefix("-") else { throw .init("\(flag) needs its spec, as ssh takes it (\(flag) 1080)") }
      forwards.append("\(flag) \(spec)")
    }
    return forwards
  }

  /// Why `destination` cannot be an SSH destination, or nil. It goes to `ssh` as one argument, never through a shell,
  /// so the rules only keep it one destination: not empty, no space or control character, and no leading `-`, which
  /// `ssh` would read as an option.
  public static func destinationProblem(_ destination: String) -> String? {
    guard !destination.isEmpty else { return "Enter the SSH destination: user@mini.local, or a Host from ~/.ssh/config" }
    guard destination.utf8.count <= maxDestinationBytes else { return "The SSH destination is at most \(maxDestinationBytes) bytes" }
    guard !destination.hasPrefix("-") else { return "The SSH destination cannot start with -" }
    guard !destination.unicodeScalars.contains(where: { $0.properties.isWhitespace }), !hasControl(destination) else {
      return "The SSH destination cannot hold spaces or control characters"
    }
    return nil
  }

  /// Why `spec` cannot follow a forward's flag, or nil: one argument with no leading `-`.
  static func specProblem(_ spec: String) -> String? {
    guard !spec.isEmpty, !spec.hasPrefix("-"), spec.utf8.count <= maxForwardBytes,
          !spec.unicodeScalars.contains(where: { $0.properties.isWhitespace }), !hasControl(spec) else {
      return "A forward’s spec is one word of at most \(maxForwardBytes) bytes, as ssh takes it (1080, 5432:db.internal:5432)"
    }
    return nil
  }

  private static func hasControl(_ text: String) -> Bool {
    text.unicodeScalars.contains { $0.value < 0x20 || (0x7F...0x9F).contains($0.value) }
  }
}

extension HivemindPaths {
  /// The hosts Server.app connects to (RemoteHostStore), 0600 in the app-support folder.
  public var hostsFile: URL { appSupport.appendingPathComponent("hosts.json") }

  /// Where the host connections' control sockets live, 0700 (SSHTransport.controlFolder).
  public var hostSockets: URL { appSupport.appendingPathComponent("ssh", isDirectory: true) }

  /// The host connections' log: each master's output and what Server.app did with it.
  public var hostsLog: URL { logsDirectory.appendingPathComponent("hosts.log") }
}

/// hosts.json: `{"hosts": [RemoteHost…]}`, written whole (BrokerFiles.writePrivately) on every change. A missing file is
/// no host. A file that cannot be read or holds an invalid host is an error, and is never overwritten by a save: the
/// menu says to move it away.
public struct RemoteHostStore: Sendable {
  public let file: URL

  public init(file: URL) { self.file = file }
  public init(paths: HivemindPaths) { self.init(file: paths.hostsFile) }

  private struct Contents: Codable { let hosts: [RemoteHost] }

  public func load() throws(BrokerFiles.Failure) -> [RemoteHost] {
    guard FileManager.default.fileExists(atPath: file.path) else { return [] }
    let hosts: [RemoteHost]
    do {
      hosts = try JSONDecoder().decode(Contents.self, from: Data(contentsOf: file)).hosts
    } catch {
      throw .init("\(file.path) cannot be read. Move it away to add hosts again.")
    }
    for host in hosts {
      do { try host.validate() } catch { throw .init("\(file.path) holds an invalid host (\(error.message)). Move it away to add hosts again.") }
    }
    guard Set(hosts.map(\.id)).count == hosts.count else { throw .init("\(file.path) holds a host twice. Move it away to add hosts again.") }
    return hosts
  }

  public func save(_ hosts: [RemoteHost]) throws(BrokerFiles.Failure) {
    try BrokerFiles.preparePrivateFolder(file.deletingLastPathComponent())
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    let data: Data
    do { data = try encoder.encode(Contents(hosts: hosts)) } catch { throw .init("Cannot encode the hosts") }
    try BrokerFiles.writePrivately(data + Data("\n".utf8), to: file)
  }
}
