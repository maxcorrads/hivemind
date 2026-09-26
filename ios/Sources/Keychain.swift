import Foundation
import HivemindKit
import Security

/// Device tokens in the Keychain, one generic password per paired Mac
/// (account: the device id the Mac gave this device). Readable after first
/// unlock, on this device only: never synced to iCloud and never restored
/// onto another device from a backup, so a copy of the phone's backup cannot
/// pair itself with the Mac.
@MainActor
final class KeychainTokenStore: DeviceTokenStoring {
  nonisolated static let service = BundleID.ios + ".device-token"

  func token(for id: UUID) -> DeviceToken? {
    var query = baseQuery(id)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return nil }
    return DeviceToken(String(decoding: data, as: UTF8.self))
  }

  func save(_ token: DeviceToken, for id: UUID) throws {
    delete(for: id)
    var item = baseQuery(id)
    item[kSecValueData as String] = Data(token.value.utf8)
    item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    let status = SecItemAdd(item as CFDictionary, nil)
    guard status == errSecSuccess else { throw KeychainError(status: status) }
  }

  func delete(for id: UUID) {
    SecItemDelete(baseQuery(id) as CFDictionary)
  }

  private func baseQuery(_ id: UUID) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: Self.service,
      kSecAttrAccount as String: id.uuidString.lowercased(),
      kSecAttrSynchronizable as String: kCFBooleanFalse as Any,
    ]
  }
}

struct KeychainError: Error, LocalizedError {
  let status: OSStatus
  var errorDescription: String? {
    let message = SecCopyErrorMessageString(status, nil) as String? ?? "error \(status)"
    return "The Keychain could not save this pairing (\(message))."
  }
}
