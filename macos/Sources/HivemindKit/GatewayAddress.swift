import Foundation

// Which network addresses the remote gateway talks to
// (docs/remote-access.md#network-scope). The gateway listens only on
// private interfaces and refuses a connection unless both its local and its
// remote address are private, so a Mac that is also on a public network (or
// has a port forwarded to it) never exposes the gateway there. "Private" is
// decided here, from the address bytes alone: no DNS, no interface flags.

/// An IPv4 or IPv6 address, parsed strictly from its text form.
public enum IPAddress: Hashable, Sendable, CustomStringConvertible {
  case v4([UInt8])
  /// 16 bytes. The zone ("%en0") of a link-local address is kept apart,
  /// since it names an interface of this machine only.
  case v6([UInt8], zone: String?)

  /// Accepts dotted-quad IPv4 (four decimal parts 0–255, no leading zeros)
  /// and RFC 4291 IPv6 text, optionally in brackets and with a `%zone`.
  /// Rejects everything else, including the short and octal IPv4 forms
  /// inet_aton would take, so "0x7f.1" or "010.0.0.1" never mean an address.
  public init?(_ text: String) {
    var text = Substring(text)
    if text.hasPrefix("["), text.hasSuffix("]") { text = text.dropFirst().dropLast() }
    if let v4 = Self.parseV4(text) {
      self = .v4(v4)
    } else if let (bytes, zone) = Self.parseV6(text) {
      self = .v6(bytes, zone: zone)
    } else {
      return nil
    }
  }

  public var bytes: [UInt8] {
    switch self {
    case .v4(let bytes), .v6(let bytes, _): bytes
    }
  }

  /// For an IPv4-mapped IPv6 address (::ffff:a.b.c.d), the IPv4 address it
  /// carries; otherwise self. A dual-stack socket reports IPv4 peers so.
  public var unmapped: IPAddress {
    guard case .v6(let bytes, _) = self, bytes[0..<10].allSatisfy({ $0 == 0 }), bytes[10] == 0xff, bytes[11] == 0xff
    else { return self }
    return .v4(Array(bytes[12..<16]))
  }

  public var isIPv6: Bool {
    if case .v6 = self { return true }
    return false
  }

  /// Canonical text: dotted quad, or RFC 5952 IPv6 (lowercase, longest run
  /// of zero groups as `::`), with the zone when there is one.
  public var description: String {
    switch self {
    case .v4(let b):
      return b.map(String.init).joined(separator: ".")
    case .v6(let b, let zone):
      let groups = (0..<8).map { UInt16(b[$0 * 2]) << 8 | UInt16(b[$0 * 2 + 1]) }
      var best = (start: -1, length: 0), run = (start: -1, length: 0)
      for (index, group) in groups.enumerated() {
        if group == 0 {
          run = run.start < 0 ? (index, 1) : (run.start, run.length + 1)
          if run.length > best.length { best = run }
        } else {
          run = (-1, 0)
        }
      }
      var text: String
      if best.length >= 2 {
        let head = groups[..<best.start].map { String($0, radix: 16) }.joined(separator: ":")
        let tail = groups[(best.start + best.length)...].map { String($0, radix: 16) }.joined(separator: ":")
        text = head + "::" + tail
      } else {
        text = groups.map { String($0, radix: 16) }.joined(separator: ":")
      }
      if let zone { text += "%" + zone }
      return text
    }
  }

  /// The form that goes in a URL's host: IPv6 in brackets, the zone
  /// percent-encoded as RFC 6874 asks.
  public var urlHost: String {
    switch self {
    case .v4: description
    case .v6(_, let zone):
      "[" + IPAddress.v6(bytes, zone: nil).description + (zone.map { "%25" + $0 } ?? "") + "]"
    }
  }

  private static func parseV4(_ text: Substring) -> [UInt8]? {
    let parts = text.split(separator: ".", omittingEmptySubsequences: false)
    guard parts.count == 4 else { return nil }
    var bytes: [UInt8] = []
    for part in parts {
      guard (1...3).contains(part.utf8.count), part.utf8.allSatisfy({ (UInt8(ascii: "0")...UInt8(ascii: "9")).contains($0) }),
            part == "0" || !part.hasPrefix("0"), let value = UInt8(part)
      else { return nil }
      bytes.append(value)
    }
    return bytes
  }

  private static func parseV6(_ text: Substring) -> ([UInt8], String?)? {
    var address = text
    var zone: String?
    if let percent = text.firstIndex(of: "%") {
      let name = text[text.index(after: percent)...]
      // Interface names: short, printable, nothing that could break a URL.
      guard (1...32).contains(name.utf8.count),
            name.utf8.allSatisfy({ Base64URL.isAlphabet($0) || $0 == UInt8(ascii: ".") })
      else { return nil }
      zone = String(name)
      address = text[..<percent]
    }
    guard address.contains(":"), address.utf8.count <= 45 else { return nil }

    // An embedded IPv4 tail (::ffff:1.2.3.4) stands for the last two groups.
    var groupsText = address
    var tail: [UInt8] = []
    if let lastColon = address.lastIndex(of: ":"), address[address.index(after: lastColon)...].contains(".") {
      guard let v4 = parseV4(address[address.index(after: lastColon)...]) else { return nil }
      tail = v4
      groupsText = address[...lastColon]
      // "::1.2.3.4" leaves "::", "a::1.2.3.4" leaves "a::", "a:b:1.2.3.4" leaves "a:b:".
      if !groupsText.hasSuffix("::") { groupsText = groupsText.dropLast() }
    }

    func groups(_ part: Substring) -> [UInt16]? {
      if part.isEmpty { return [] }
      var out: [UInt16] = []
      for group in part.split(separator: ":", omittingEmptySubsequences: false) {
        // Digits only: UInt16(_:radix:) alone would also take a sign.
        guard (1...4).contains(group.utf8.count), group.utf8.allSatisfy(Hex.isDigit),
              let value = UInt16(group, radix: 16)
        else { return nil }
        out.append(value)
      }
      return out
    }

    let wanted = tail.isEmpty ? 8 : 6
    var all: [UInt16]
    let halves = groupsText.components(separatedBy: "::")
    switch halves.count {
    case 1:
      guard let only = groups(groupsText), only.count == wanted else { return nil }
      all = only
    case 2:
      guard let head = groups(Substring(halves[0])), let rest = groups(Substring(halves[1])),
            head.count + rest.count < wanted
      else { return nil }
      all = head + Array(repeating: 0, count: wanted - head.count - rest.count) + rest
    default:
      return nil
    }
    var bytes = all.flatMap { [UInt8($0 >> 8), UInt8(truncatingIfNeeded: $0)] }
    bytes += tail
    return (bytes, zone)
  }
}

/// Where an address sits, as far as the gateway cares.
public enum AddressScope: String, Sendable, CaseIterable {
  /// 127.0.0.0/8, ::1. Never the gateway's: local processes reach the Node
  /// server directly and need no gateway.
  case loopback
  /// RFC 1918: 10/8, 172.16/12, 192.168/16.
  case privateIPv4
  /// 100.64.0.0/10 (RFC 6598), which Tailscale and Headscale use for their
  /// tailnets.
  case sharedAddressSpace
  /// fd00::/8, the locally assigned half of RFC 4193 unique local addresses
  /// (Tailscale's IPv6 too). fc00::/8 is reserved and unassigned, so it is
  /// not treated as private.
  case uniqueLocal
  /// 169.254.0.0/16 and fe80::/10: one link only.
  case linkLocal
  /// Anything else: public, multicast, unspecified, documentation, NAT64…
  case other

  public init(_ address: IPAddress) {
    let b = address.unmapped.bytes
    switch address.unmapped {
    case .v4:
      switch (b[0], b[1]) {
      case (127, _): self = .loopback
      case (10, _): self = .privateIPv4
      case (172, 16...31): self = .privateIPv4
      case (192, 168): self = .privateIPv4
      case (100, 64...127): self = .sharedAddressSpace
      case (169, 254): self = .linkLocal
      default: self = .other
      }
    case .v6:
      if b[0..<15].allSatisfy({ $0 == 0 }) && b[15] == 1 {
        self = .loopback
      } else if b[0] == 0xfd {
        self = .uniqueLocal
      } else if b[0] == 0xfe && (b[1] & 0xc0) == 0x80 {
        self = .linkLocal
      } else {
        self = .other
      }
    }
  }

  /// Whether the gateway may listen on, or talk to, an address of this scope.
  public var isPrivate: Bool {
    switch self {
    case .privateIPv4, .sharedAddressSpace, .uniqueLocal, .linkLocal: true
    case .loopback, .other: false
    }
  }
}

/// One address of one interface of this Mac (from getifaddrs in the app).
public struct InterfaceAddress: Hashable, Sendable {
  public let interface: String
  public let address: IPAddress

  public init(interface: String, address: IPAddress) {
    self.interface = interface
    self.address = address
  }
}

public enum RemoteAddressPolicy {
  public static func isPrivate(_ address: IPAddress) -> Bool { AddressScope(address).isPrivate }

  /// A connection is served only when both ends are private. The remote
  /// check alone is not enough: a public interface can still deliver a
  /// packet from a private source (a forwarded port, a spoofing neighbour).
  public static func accepts(local: IPAddress, remote: IPAddress) -> Bool {
    isPrivate(local) && isPrivate(remote)
  }

  /// The addresses to listen on: every private one, in a stable order,
  /// each once. Apple's peer-to-peer Wi-Fi links (`awdl*` for AirDrop and
  /// `llw*`, which share one link-local address) are left out: no paired
  /// device reaches the Mac there, and the second of two listeners on one
  /// address only fails with "address in use", again every 30 s. The same
  /// address on two interfaces is listened on once, for the same reason.
  public static func listenAddresses(_ interfaces: [InterfaceAddress]) -> [InterfaceAddress] {
    var seen = Set<IPAddress>()
    return interfaces
      .filter { isPrivate($0.address) && !isPeerToPeer($0.interface) }
      .sorted(by: order)
      .filter { seen.insert($0.address).inserted }
  }

  /// AWDL (AirDrop, Sidecar) and low-latency WLAN interfaces.
  public static func isPeerToPeer(_ interface: String) -> Bool {
    interface.hasPrefix("awdl") || interface.hasPrefix("llw")
  }

  /// The hosts put in a pairing QR code: private addresses another device
  /// can use as they are. IPv6 link-local ones are left out, since their
  /// zone names an interface of this Mac and means nothing on the phone
  /// (Bonjour still finds the Mac over them). LAN first, then the tailnet,
  /// then IPv6, at most `limit`, without duplicates.
  public static func pairingHosts(_ interfaces: [InterfaceAddress], limit: Int = GatewayLimits.maxPairingHosts) -> [IPAddress] {
    var seen = Set<IPAddress>()
    var hosts: [IPAddress] = []
    for entry in interfaces.sorted(by: order) {
      let address = entry.address.unmapped
      let scope = AddressScope(address)
      guard scope.isPrivate, !(scope == .linkLocal && address.isIPv6) else { continue }
      let bare: IPAddress = if case .v6(let bytes, _) = address { .v6(bytes, zone: nil) } else { address }
      if seen.insert(bare).inserted { hosts.append(bare) }
    }
    return Array(hosts.prefix(limit))
  }

  private static func rank(_ address: IPAddress) -> Int {
    switch AddressScope(address) {
    case .privateIPv4: 0
    case .sharedAddressSpace: 1
    case .uniqueLocal: 2
    case .linkLocal: address.unmapped.isIPv6 ? 4 : 3
    case .loopback, .other: 5
    }
  }

  private static func order(_ a: InterfaceAddress, _ b: InterfaceAddress) -> Bool {
    let (ra, rb) = (rank(a.address), rank(b.address))
    if ra != rb { return ra < rb }
    if a.interface != b.interface { return a.interface < b.interface }
    return a.address.bytes.lexicographicallyPrecedes(b.address.bytes)
  }
}
