import Foundation
import HivemindKit
import Security

/// Worker template secrets in the login Keychain: one generic password per
/// secret, service `<server bundle id>.template-secrets`, account
/// `<template id>/<NAME>`. The broker only lists names and writes values
/// (TemplateSecretVault); nothing here returns a value over the broker, and
/// no error or log line holds one.
@MainActor
final class KeychainTemplateSecretVault: TemplateSecretVault {
  static let service = "\(BundleID.server).template-secrets"

  private static func account(_ template: TemplateID, _ name: String) -> String { "\(template.rawValue)/\(name)" }

  func names(for template: TemplateID) throws(BrokerFiles.Failure) -> [String] {
    var result: CFTypeRef?
    let status = SecItemCopyMatching([
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: Self.service,
      kSecReturnAttributes: true,
      kSecMatchLimit: kSecMatchLimitAll,
    ] as CFDictionary, &result)
    if status == errSecItemNotFound { return [] }
    guard status == errSecSuccess, let items = result as? [[CFString: Any]] else { throw Self.failure("read", status) }
    let prefix = "\(template.rawValue)/"
    return items.compactMap { item in
      guard let account = item[kSecAttrAccount] as? String, account.hasPrefix(prefix) else { return nil }
      let name = String(account.dropFirst(prefix.count))
      return TemplateSecrets.isValidName(name) ? name : nil
    }.sorted()
  }

  func set(_ value: TemplateSecretValue, name: String, for template: TemplateID) throws(BrokerFiles.Failure) {
    let query: [CFString: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: Self.service,
      kSecAttrAccount: Self.account(template, name),
    ]
    let data = Data(value.value.utf8)
    let updated = SecItemUpdate(query as CFDictionary, [kSecValueData: data] as CFDictionary)
    if updated == errSecSuccess { return }
    guard updated == errSecItemNotFound else { throw Self.failure("save \(name)", updated) }
    var item = query
    item[kSecValueData] = data
    item[kSecAttrLabel] = "Hivemind worker template secret \(name)"
    let added = SecItemAdd(item as CFDictionary, nil)
    guard added == errSecSuccess else { throw Self.failure("save \(name)", added) }
  }

  func delete(name: String?, for template: TemplateID) throws(BrokerFiles.Failure) {
    let secrets: [String]
    if let name { secrets = [name] } else { secrets = try names(for: template) }
    for secret in secrets {
      let status = SecItemDelete([
        kSecClass: kSecClassGenericPassword,
        kSecAttrService: Self.service,
        kSecAttrAccount: Self.account(template, secret),
      ] as CFDictionary)
      guard status == errSecSuccess || status == errSecItemNotFound else { throw Self.failure("delete \(secret)", status) }
    }
  }

  func values(for template: TemplateID) throws(BrokerFiles.Failure) -> [String: String] {
    var values: [String: String] = [:]
    for name in try names(for: template) {
      var result: CFTypeRef?
      let status = SecItemCopyMatching([
        kSecClass: kSecClassGenericPassword,
        kSecAttrService: Self.service,
        kSecAttrAccount: Self.account(template, name),
        kSecReturnData: true,
        kSecMatchLimit: kSecMatchLimitOne,
      ] as CFDictionary, &result)
      if status == errSecItemNotFound { continue }
      guard status == errSecSuccess, let data = result as? Data else { throw Self.failure("read \(name)", status) }
      // A value that no longer meets the rule (edited outside Hivemind) is left out rather than handed on.
      if let value = String(data: data, encoding: .utf8), TemplateSecrets.isValidValue(value) { values[name] = value }
    }
    return values
  }

  private static func failure(_ action: String, _ status: OSStatus) -> BrokerFiles.Failure {
    let reason = SecCopyErrorMessageString(status, nil) as String? ?? "OSStatus \(status)"
    return BrokerFiles.Failure("Cannot \(action) in the Keychain: \(reason)")
  }
}
