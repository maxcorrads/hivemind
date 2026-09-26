import Foundation
import HivemindKit
import Security

/// The remote gateway's TLS identity (docs/remote-access.md#tls-and-pinning):
/// an ECDSA P-256 key made once in the login Keychain, and a self-signed
/// certificate for it. Devices pin the certificate's SHA-256, taken from the
/// pairing QR code, so there is no CA and the certificate's name and dates
/// carry no trust. The private key never leaves the Keychain; TLS signs with
/// it there.
struct GatewayIdentity {
  let identity: SecIdentity
  let certificateDER: Data

  var fingerprint: CertificateFingerprint { CertificateFingerprint(certificateDER: certificateDER) }
}

enum GatewayIdentityStore {
  /// The Keychain label of the key and the certificate (what Keychain
  /// Access shows).
  static let label = "Hivemind Server remote access"
  static let keyTag = Data("\(BundleID.server).gateway".utf8)

  struct Failure: Error, LocalizedError {
    let message: String
    var errorDescription: String? { message }

    static func status(_ what: String, _ status: OSStatus) -> Failure {
      let text = SecCopyErrorMessageString(status, nil) as String? ?? "OSStatus \(status)"
      return Failure(message: "\(what): \(text)")
    }

    static func cf(_ what: String, _ error: Unmanaged<CFError>?) -> Failure {
      Failure(message: "\(what): \(error.map { ($0.takeRetainedValue() as Error).localizedDescription } ?? "unknown error")")
    }
  }

  /// The identity made earlier, or a new one.
  static func loadOrCreate(macName: String) throws -> GatewayIdentity {
    if let existing = try load() { return existing }
    return try create(macName: macName)
  }

  /// Nil when there is none yet. The certificate is found through the key:
  /// by the key's application label, which is the hash of its public key
  /// that the certificate carries as kSecAttrPublicKeyHash. (The login
  /// Keychain stores a certificate under its subject name whatever label
  /// SecItemAdd was given, so a lookup by our label found nothing, and every
  /// launch made a new identity: a new fingerprint that no paired device
  /// pins.) A key whose certificate is gone (deleted in Keychain Access,
  /// say) is removed so a new pair can be made.
  static func load() throws -> GatewayIdentity? {
    guard let publicKeyHash = try keyPublicKeyHash() else { return nil }
    var item: CFTypeRef?
    let status = SecItemCopyMatching([
      kSecClass: kSecClassCertificate,
      kSecAttrPublicKeyHash: publicKeyHash,
      kSecReturnRef: true,
      kSecMatchLimit: kSecMatchLimitOne,
    ] as CFDictionary, &item)
    if status == errSecItemNotFound {
      delete()
      return nil
    }
    guard status == errSecSuccess, let item, CFGetTypeID(item) == SecCertificateGetTypeID() else {
      throw Failure.status("Cannot read the remote access certificate", status)
    }
    let certificate = item as! SecCertificate
    var identity: SecIdentity?
    guard SecIdentityCreateWithCertificate(nil, certificate, &identity) == errSecSuccess, let identity else {
      delete()
      return nil
    }
    return GatewayIdentity(identity: identity, certificateDER: SecCertificateCopyData(certificate) as Data)
  }

  /// The private key's application label (the SHA-1 of its public key), or
  /// nil when there is no key. Reads attributes only, never the key.
  private static func keyPublicKeyHash() throws -> Data? {
    var item: CFTypeRef?
    let status = SecItemCopyMatching([
      kSecClass: kSecClassKey,
      kSecAttrApplicationTag: keyTag,
      kSecAttrKeyClass: kSecAttrKeyClassPrivate,
      kSecReturnAttributes: true,
      kSecMatchLimit: kSecMatchLimitOne,
    ] as CFDictionary, &item)
    if status == errSecItemNotFound { return nil }
    guard status == errSecSuccess, let attributes = item as? [CFString: Any],
          let hash = attributes[kSecAttrApplicationLabel] as? Data, !hash.isEmpty
    else { throw Failure.status("Cannot read the remote access key", status) }
    return hash
  }

  static func create(macName: String) throws -> GatewayIdentity {
    delete()
    var error: Unmanaged<CFError>?
    guard let privateKey = SecKeyCreateRandomKey([
      kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeySizeInBits: 256,
      kSecPrivateKeyAttrs: [
        kSecAttrIsPermanent: true,
        kSecAttrApplicationTag: keyTag,
        kSecAttrLabel: label,
      ] as CFDictionary,
    ] as CFDictionary, &error) else { throw Failure.cf("Cannot create the remote access key", error) }
    guard let publicKey = SecKeyCopyPublicKey(privateKey),
          let x963 = SecKeyCopyExternalRepresentation(publicKey, &error) as Data?
    else { throw Failure.cf("Cannot read the remote access key", error) }

    let der = try GatewayCertificate.make(publicKeyX963: x963, commonName: "Hivemind Server on \(macName)", now: Date()) { tbs in
      var error: Unmanaged<CFError>?
      guard let signature = SecKeyCreateSignature(privateKey, .ecdsaSignatureMessageX962SHA256, tbs as CFData, &error) as Data? else {
        throw Failure.cf("Cannot sign the remote access certificate", error)
      }
      return signature
    }
    guard let certificate = SecCertificateCreateWithData(nil, der as CFData) else {
      throw Failure(message: "The remote access certificate is malformed")
    }
    let added = SecItemAdd([
      kSecClass: kSecClassCertificate,
      kSecValueRef: certificate,
      kSecAttrLabel: label,
    ] as CFDictionary, nil)
    guard added == errSecSuccess else { throw Failure.status("Cannot save the remote access certificate", added) }
    // The label SecItemAdd was given is not kept; set it so Keychain Access
    // shows the certificate as "Hivemind Server remote access" (load() finds
    // it through the key either way).
    SecItemUpdate([kSecClass: kSecClassCertificate, kSecValueRef: certificate] as CFDictionary,
                  [kSecAttrLabel: label] as CFDictionary)
    var identity: SecIdentity?
    let status = SecIdentityCreateWithCertificate(nil, certificate, &identity)
    guard status == errSecSuccess, let identity else { throw Failure.status("Cannot use the remote access key", status) }
    return GatewayIdentity(identity: identity, certificateDER: der)
  }

  /// Removes the key and the certificate ("Reset Identity…").
  static func delete() {
    if let publicKeyHash = try? keyPublicKeyHash() {
      SecItemDelete([kSecClass: kSecClassCertificate, kSecAttrPublicKeyHash: publicKeyHash] as CFDictionary)
    }
    SecItemDelete([kSecClass: kSecClassCertificate, kSecAttrLabel: label] as CFDictionary)
    SecItemDelete([kSecClass: kSecClassKey, kSecAttrApplicationTag: keyTag] as CFDictionary)
  }
}
