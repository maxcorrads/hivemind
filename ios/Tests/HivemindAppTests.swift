import Foundation
import HivemindKit
import Security
import UIKit
import Testing
@testable import Hivemind

// Hosted in the app, so Bundle.main is Hivemind.app. Runs in CI only
// (xcodebuild test on a Simulator); HivemindKit's own tests, which cover
// pairing, sessions, the broker WebSocket and the scene policies, run with
// `swift test --package-path macos`. Nothing here opens a connection.

struct HivemindAppTests {
  @Test func bundleIdentifierMatchesHivemindKit() {
    #expect(AppInfo.bundleIdentifier == BundleID.ios)
  }

  @Test func gatewayPathsAreReachableFromTheApp() {
    #expect(GatewayPath.pair == "/_hivemind/pair")
  }

  @Test func infoPlistHasWhatPairingNeeds() throws {
    let info = try #require(Bundle.main.infoDictionary)
    #expect((info["NSCameraUsageDescription"] as? String)?.isEmpty == false)
    #expect((info["NSLocalNetworkUsageDescription"] as? String)?.isEmpty == false)
    #expect(info["NSBonjourServices"] as? [String] == [GatewayAdvertisement.serviceType])
    #expect(info["UIBackgroundModes"] == nil)
    let scenes = info["UIApplicationSceneManifest"] as? [String: Any]
    #expect(scenes?["UIApplicationSupportsMultipleScenes"] as? Bool == true)
    let ats = info["NSAppTransportSecurity"] as? [String: Any]
    #expect(ats?["NSAllowsArbitraryLoads"] == nil)
  }
}

/// A self-signed P-256 certificate made for these tests only (openssl req
/// -x509), standing in for a gateway's.
enum TestCertificate {
  static let der = Data(base64Encoded: [
    "MIIBlTCCATugAwIBAgIUc/KpXzv9tnvuuO6gflsK0z8n2LcwCgYIKoZIzj0EAwIwIDEeMBwGA1UEAwwVSGl2ZW1pbmQgVGVzdCBH",
    "YXRld2F5MB4XDTI2MDkyNjEzMDMyNFoXDTM2MDkyMzEzMDMyNFowIDEeMBwGA1UEAwwVSGl2ZW1pbmQgVGVzdCBHYXRld2F5MFkw",
    "EwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEmwPe2k7+TC0geZIIFdPyjfC17EF3DlCzk+oknIHCR9f8SnluBN5XgLCC6ASrpUO9jYEq",
    "kNcx4KO/AQL9dg1msqNTMFEwHQYDVR0OBBYEFCYS7CvwQddWeDtE2F4ZkrdnV3xrMB8GA1UdIwQYMBaAFCYS7CvwQddWeDtE2F4Z",
    "krdnV3xrMA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSAAwRQIgEBRZh3reWDLBENaOiMoflhs105Tx/s/rPDmRZhuNiVQC",
    "IQCb6IPEEG/xLGp7hHOK4qZ8JmgI4VKdI0WasmH1Pnq6og==",
  ].joined())!
  /// shasum -a 256 of the DER.
  static let sha256 = "41d42677fb9fb22e3a4482abfa48e0f6a9fe1da8403203979687c09425903466"

  static func trust() throws -> SecTrust {
    let certificate = try #require(SecCertificateCreateWithData(nil, der as CFData))
    var trust: SecTrust?
    let status = SecTrustCreateWithCertificates(certificate, SecPolicyCreateSSL(true, "192.168.1.20" as CFString), &trust)
    #expect(status == errSecSuccess)
    return try #require(trust)
  }
}

struct PinningTests {
  let pin = CertificateFingerprint(hex: TestCertificate.sha256)!

  @Test func theLeafIsTheCertificateThePinCovers() throws {
    let leaf = try #require(ServerTrustPinning.leafCertificate(try TestCertificate.trust()))
    #expect(leaf == TestCertificate.der)
    #expect(pin.matches(certificateDER: leaf))
    #expect(!CertificateFingerprint(certificateDER: Data("other".utf8)).matches(certificateDER: leaf))
  }

  func challenge(host: String, method: String) -> URLAuthenticationChallenge {
    let space = URLProtectionSpace(host: host, port: 7443, protocol: "https", realm: nil, authenticationMethod: method)
    return URLAuthenticationChallenge(
      protectionSpace: space, proposedCredential: nil, previousFailureCount: 0, failureResponse: nil, error: nil,
      sender: NoSender())
  }

  @Test func onlyServerTrustIsAnswered() {
    for method in [NSURLAuthenticationMethodHTTPBasic, NSURLAuthenticationMethodClientCertificate] {
      let outcome = ServerTrustPinning.evaluate(challenge(host: "192.168.1.20", method: method), pin: pin)
      #expect(outcome.disposition == .rejectProtectionSpace)
      #expect(!outcome.mismatch)
    }
  }

  @Test func withoutACertificateTheGatewayIsRefused() {
    // A protection space made by hand has no server trust: nothing to match.
    let outcome = ServerTrustPinning.evaluate(challenge(host: "192.168.1.20", method: NSURLAuthenticationMethodServerTrust), pin: pin, host: "192.168.1.20")
    #expect(outcome.disposition == .cancelAuthenticationChallenge)
    #expect(outcome.credential == nil)
    #expect(outcome.mismatch)
  }

  @Test func otherHostsAreLeftToTheSystem() {
    let outcome = ServerTrustPinning.evaluate(challenge(host: "fonts.example", method: NSURLAuthenticationMethodServerTrust), pin: pin, host: "192.168.1.20")
    #expect(outcome.disposition == .performDefaultHandling)
    #expect(!outcome.mismatch)
  }

  @Test func hostsCompareCanonically() {
    #expect(ServerTrustPinning.sameHost("[fd7a:115c:a1e0::5]", "fd7a:115c:a1e0:0:0:0:0:5"))
    #expect(ServerTrustPinning.sameHost("Studio.Local", "studio.local"))
    #expect(!ServerTrustPinning.sameHost("192.168.1.2", "192.168.1.20"))
  }
}

private final class NoSender: NSObject, URLAuthenticationChallengeSender {
  func use(_ credential: URLCredential, for challenge: URLAuthenticationChallenge) {}
  func continueWithoutCredential(for challenge: URLAuthenticationChallenge) {}
  func cancel(_ challenge: URLAuthenticationChallenge) {}
}

/// The Keychain needs a signed app, even on the Simulator (Xcode signs a
/// Simulator build to run locally unless CODE_SIGNING_ALLOWED=NO). Without
/// one every call fails with errSecMissingEntitlement; the tests then have
/// nothing to check.
func keychainAvailable() -> Bool {
  let probe: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrService as String: KeychainTokenStore.service + ".probe",
    kSecAttrAccount as String: "probe",
    kSecValueData as String: Data([1]),
  ]
  SecItemDelete(probe as CFDictionary)
  let status = SecItemAdd(probe as CFDictionary, nil)
  SecItemDelete(probe as CFDictionary)
  return status != errSecMissingEntitlement
}

@MainActor
struct KeychainTokenStoreTests {
  @Test(.enabled(if: keychainAvailable(), "the test host is not signed, so it has no Keychain"))
  func savesReadsReplacesAndDeletes() throws {
    let store = KeychainTokenStore()
    let id = UUID()
    defer { store.delete(for: id) }
    #expect(store.token(for: id) == nil)
    let first = DeviceToken.generate()
    try store.save(first, for: id)
    #expect(store.token(for: id) == first)
    let second = DeviceToken.generate()
    try store.save(second, for: id)
    #expect(store.token(for: id) == second)
    store.delete(for: id)
    #expect(store.token(for: id) == nil)
  }

  @Test(.enabled(if: keychainAvailable(), "the test host is not signed, so it has no Keychain"))
  func itemsStayOnThisDevice() throws {
    let store = KeychainTokenStore()
    let id = UUID()
    defer { store.delete(for: id) }
    try store.save(DeviceToken.generate(), for: id)
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: KeychainTokenStore.service,
      kSecAttrAccount as String: id.uuidString.lowercased(),
      kSecReturnAttributes as String: true,
    ]
    var result: CFTypeRef?
    #expect(SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess)
    let attributes = try #require(result as? [String: Any])
    #expect(attributes[kSecAttrAccessible as String] as? String == kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
  }
}

@MainActor
struct DownloadTests {
  @Test func aSuggestedNameCannotLeaveItsFolder() {
    #expect(DownloadPresenter.fileName("report.pdf") == "report.pdf")
    #expect(DownloadPresenter.fileName("../../etc/passwd") == "passwd")
    #expect(DownloadPresenter.fileName("") == "download")
    #expect(DownloadPresenter.fileName("..") == "download")
    #expect(DownloadPresenter.fileName("/") == "download")
  }
}

@MainActor
struct PlatformTests {
  @Test func thePlatformTheMacIsTold() {
    let expected: DevicePlatform = UIDevice.current.userInterfaceIdiom == .pad ? .ipados : .ios
    #expect(DevicePlatform.current == expected)
  }
}
