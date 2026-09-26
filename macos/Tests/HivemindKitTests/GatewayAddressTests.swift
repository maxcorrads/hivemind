import Foundation
import Testing
@testable import HivemindKit

struct IPAddressTests {
  @Test func parsesIPv4Strictly() {
    #expect(IPAddress("192.168.1.20") == .v4([192, 168, 1, 20]))
    #expect(IPAddress("0.0.0.0") == .v4([0, 0, 0, 0]))
    for bad in ["192.168.1", "192.168.1.256", "010.0.0.1", "1.2.3.4.5", "0x7f.0.0.1", "127.1", " 1.2.3.4", "1.2.3.4 ", "+1.2.3.4", "1..2.3", ""] {
      #expect(IPAddress(bad) == nil, "\(bad)")
    }
  }

  @Test func parsesIPv6() {
    #expect(IPAddress("::1") == .v6([UInt8](repeating: 0, count: 15) + [1], zone: nil))
    #expect(IPAddress("::")?.bytes == [UInt8](repeating: 0, count: 16))
    #expect(IPAddress("fd7a:115c:a1e0::1")?.description == "fd7a:115c:a1e0::1")
    #expect(IPAddress("FD7A:115C:A1E0:0:0:0:0:1")?.description == "fd7a:115c:a1e0::1")
    #expect(IPAddress("[fe80::1%en0]") == .v6([0xfe, 0x80] + [UInt8](repeating: 0, count: 13) + [1], zone: "en0"))
    #expect(IPAddress("1:2:3:4:5:6:7:8")?.description == "1:2:3:4:5:6:7:8")
    #expect(IPAddress("1:0:0:2:0:0:0:3")?.description == "1:0:0:2::3")
    #expect(IPAddress("1:0:2:3:4:5:6:7")?.description == "1:0:2:3:4:5:6:7")
    #expect(IPAddress("::ffff:192.168.1.2")?.unmapped == .v4([192, 168, 1, 2]))
    #expect(IPAddress("64:ff9b::1.2.3.4")?.bytes.suffix(4) == [1, 2, 3, 4])
    #expect(IPAddress("1:2:3:4:5:6:1.2.3.4") != nil)
    for bad in [":", ":::", "1::2::3", "1:2:3:4:5:6:7:8:9", "1:2:3:4:5:6:7", "12345::1", "g::1", "+1::", "::1%", "fe80::1%en 0",
                "::ffff:1.2.3", "1:2:3:4:5:6:7:1.2.3.4", "[::1", "::1]"] {
      #expect(IPAddress(bad) == nil, "\(bad)")
    }
  }

  @Test func urlHostBracketsIPv6() {
    #expect(IPAddress("10.0.0.1")!.urlHost == "10.0.0.1")
    #expect(IPAddress("fd00::1")!.urlHost == "[fd00::1]")
    #expect(IPAddress("fe80::1%en0")!.urlHost == "[fe80::1%25en0]")
  }
}

struct AddressScopeTests {
  @Test(arguments: [
    ("10.0.0.1", AddressScope.privateIPv4), ("10.255.255.255", .privateIPv4),
    ("172.16.0.1", .privateIPv4), ("172.31.255.255", .privateIPv4), ("172.15.0.1", .other), ("172.32.0.1", .other),
    ("192.168.0.1", .privateIPv4), ("192.169.0.1", .other),
    ("100.64.0.1", .sharedAddressSpace), ("100.127.255.255", .sharedAddressSpace), ("100.63.255.255", .other), ("100.128.0.1", .other),
    ("169.254.1.1", .linkLocal), ("127.0.0.1", .loopback), ("127.9.9.9", .loopback),
    ("8.8.8.8", .other), ("0.0.0.0", .other), ("255.255.255.255", .other), ("224.0.0.251", .other),
    ("::1", .loopback), ("::", .other), ("fd7a:115c:a1e0::1", .uniqueLocal), ("fc00::1", .other),
    ("fe80::1", .linkLocal), ("febf::1", .linkLocal), ("fec0::1", .other), ("2001:db8::1", .other), ("ff02::fb", .other),
    ("::ffff:192.168.1.2", .privateIPv4), ("::ffff:8.8.8.8", .other), ("64:ff9b::a00:1", .other),
  ])
  func classifies(text: String, scope: AddressScope) {
    #expect(AddressScope(IPAddress(text)!) == scope, "\(text)")
  }

  @Test func privateScopes() {
    #expect(AddressScope.allCases.filter(\.isPrivate) == [.privateIPv4, .sharedAddressSpace, .uniqueLocal, .linkLocal])
  }
}

struct RemoteAddressPolicyTests {
  func ip(_ text: String) -> IPAddress { IPAddress(text)! }

  @Test func needsBothEndsPrivate() {
    #expect(RemoteAddressPolicy.accepts(local: ip("192.168.1.20"), remote: ip("192.168.1.30")))
    #expect(RemoteAddressPolicy.accepts(local: ip("100.100.1.1"), remote: ip("100.64.0.9")))
    #expect(RemoteAddressPolicy.accepts(local: ip("fd7a::1"), remote: ip("fe80::2%en0")))
    #expect(!RemoteAddressPolicy.accepts(local: ip("203.0.113.5"), remote: ip("192.168.1.30")))
    #expect(!RemoteAddressPolicy.accepts(local: ip("192.168.1.20"), remote: ip("203.0.113.5")))
    #expect(!RemoteAddressPolicy.accepts(local: ip("127.0.0.1"), remote: ip("127.0.0.1")))
    #expect(!RemoteAddressPolicy.accepts(local: ip("::ffff:192.168.1.2"), remote: ip("::ffff:1.1.1.1")))
  }

  let interfaces = [
    InterfaceAddress(interface: "lo0", address: IPAddress("127.0.0.1")!),
    InterfaceAddress(interface: "en0", address: IPAddress("fe80::1c%en0")!),
    InterfaceAddress(interface: "utun4", address: IPAddress("fd7a:115c:a1e0::5")!),
    InterfaceAddress(interface: "utun4", address: IPAddress("100.101.102.103")!),
    InterfaceAddress(interface: "en0", address: IPAddress("2a02:1234::5")!),
    InterfaceAddress(interface: "en0", address: IPAddress("192.168.1.20")!),
    InterfaceAddress(interface: "en1", address: IPAddress("169.254.3.4")!),
    InterfaceAddress(interface: "en5", address: IPAddress("192.168.1.20")!),
  ]

  @Test func listensOnPrivateAddressesOnly() {
    let listen = RemoteAddressPolicy.listenAddresses(interfaces).map { "\($0.interface) \($0.address)" }
    #expect(listen == ["en0 192.168.1.20", "en5 192.168.1.20", "utun4 100.101.102.103", "utun4 fd7a:115c:a1e0::5", "en1 169.254.3.4", "en0 fe80::1c%en0"])
  }

  @Test func pairingHostsAreUsableElsewhere() {
    let hosts = RemoteAddressPolicy.pairingHosts(interfaces).map(\.description)
    #expect(hosts == ["192.168.1.20", "100.101.102.103", "fd7a:115c:a1e0::5", "169.254.3.4"])
    #expect(RemoteAddressPolicy.pairingHosts(interfaces, limit: 2).count == 2)
    #expect(RemoteAddressPolicy.pairingHosts([]).isEmpty)
  }
}
