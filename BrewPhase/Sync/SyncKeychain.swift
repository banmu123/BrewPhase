import Foundation
import Security

/// 同步凭据的 Keychain 存储（沿用 BrewPing `KeychainStore` 的结构）：
/// 通用密码项 + service 隔离。**Token 永远不进 UserDefaults。**
enum SyncKeychain {
    private static let service = "com.brewphase.ios.sync"

    static func string(forKey key: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    @discardableResult
    static func set(_ value: String?, forKey key: String) -> Bool {
        if let value {
            let data = Data(value.utf8)
            let update: [String: Any] = [kSecValueData as String: data]
            let query: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: key
            ]
            let status = SecItemUpdate(query as CFDictionary, update as CFDictionary)
            if status == errSecSuccess { return true }
            if status == errSecItemNotFound {
                var attributes = query
                attributes[kSecValueData as String] = data
                attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
                return SecItemAdd(attributes as CFDictionary, nil) == errSecSuccess
            }
            return false
        }
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key
        ]
        SecItemDelete(query as CFDictionary)
        return true
    }
}
