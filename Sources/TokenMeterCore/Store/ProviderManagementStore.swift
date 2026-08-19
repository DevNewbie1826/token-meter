// Provider/account management persistence (plan criterion 3).
//
// One JSON document per provider holds non-secret account metadata only:
// providerId, accountRef, displayName, credentialRevision. Secrets live
// exclusively in the credential file `auth.json` managed by
// `AuthFileCredentialStore` under `Application Support/TokenMeter`; nothing in
// this store is secret or secret-derived. Documents are written atomically
// (temporary file + rename).
import Foundation

public struct AccountRecord: Equatable, Hashable, Codable, Sendable {
    public let providerId: String
    public let accountRef: String
    public let displayName: String
    public let credentialRevision: Int

    public init(providerId: String, accountRef: String, displayName: String, credentialRevision: Int) {
        self.providerId = providerId
        self.accountRef = accountRef
        self.displayName = displayName
        self.credentialRevision = credentialRevision
    }
}

public struct ProviderManagementStoreError: Error, Equatable, Sendable {
    public let message: String

    public init(message: String) {
        self.message = message
    }
}

public final class ProviderManagementStore: @unchecked Sendable {
    private let storageDirectory: URL
    private let lock = NSLock()
    private var accountsByProvider: [String: [AccountRecord]]

    private struct ProviderAccountsDocument: Codable {
        let accounts: [AccountRecord]
    }

    public init(storageDirectory: URL) throws {
        self.storageDirectory = storageDirectory
        try FileManager.default.createDirectory(at: storageDirectory, withIntermediateDirectories: true)
        self.accountsByProvider = try Self.loadAccounts(from: storageDirectory)
    }

    // MARK: - Accounts

    public func upsert(account: AccountRecord) throws {
        lock.lock()
        defer { lock.unlock() }
        var accounts = accountsByProvider[account.providerId] ?? []
        if let index = accounts.firstIndex(where: { $0.accountRef == account.accountRef }) {
            accounts[index] = account
        } else {
            accounts.append(account)
        }
        accounts.sort { $0.accountRef < $1.accountRef }
        accountsByProvider[account.providerId] = accounts
        try persist(providerId: account.providerId, accounts: accounts)
    }

    public func removeAccount(providerId: String, accountRef: String) throws {
        lock.lock()
        defer { lock.unlock() }
        var accounts = accountsByProvider[providerId] ?? []
        accounts.removeAll { $0.accountRef == accountRef }
        accountsByProvider[providerId] = accounts
        if accounts.isEmpty {
            accountsByProvider.removeValue(forKey: providerId)
            // Idempotent cleanup: the file may never have existed.
            try? FileManager.default.removeItem(at: fileURL(forProvider: providerId))
        } else {
            try persist(providerId: providerId, accounts: accounts)
        }
    }

    public func accounts(forProvider providerId: String) throws -> [AccountRecord] {
        lock.lock()
        defer { lock.unlock() }
        return accountsByProvider[providerId] ?? []
    }

    // MARK: - Registry

    /// Strictly decodes a capability registry document synchronized by the
    /// bridge's OMP sync. The packaged resource is the shipped source of
    /// truth; an on-disk override is honored when present for development.
    public func loadRegistry(from url: URL) throws -> ProviderCatalog {
        guard FileManager.default.fileExists(atPath: url.path) else {
            return .locked
        }
        return try ProviderCatalog(decoding: try Data(contentsOf: url))
    }

    // MARK: - Persistence

    private func persist(providerId: String, accounts: [AccountRecord]) throws {
        let document = ProviderAccountsDocument(accounts: accounts)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data: Data
        do {
            data = try encoder.encode(document)
        } catch {
            throw ProviderManagementStoreError(message: "failed to encode accounts for \(providerId)")
        }
        let destination = fileURL(forProvider: providerId)
        let temporary = storageDirectory
            .appendingPathComponent(".\(destination.lastPathComponent).tmp-\(UUID().uuidString)")
        do {
            try data.write(to: temporary)
            if FileManager.default.fileExists(atPath: destination.path) {
                _ = try FileManager.default.replaceItemAt(destination, withItemAt: temporary)
            } else {
                try FileManager.default.moveItem(at: temporary, to: destination)
            }
        } catch {
            throw ProviderManagementStoreError(
                message: "failed to persist accounts for \(providerId): \(error.localizedDescription)"
            )
        }
    }

    private func fileURL(forProvider providerId: String) -> URL {
        storageDirectory.appendingPathComponent("\(Self.fileNameSafe(providerId)).json")
    }

    /// Percent-encodes anything outside a conservative filename alphabet so
    /// arbitrary provider ids never traverse the storage directory.
    private static func fileNameSafe(_ providerId: String) -> String {
        let allowed = CharacterSet(
            charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-"
        )
        return providerId.addingPercentEncoding(withAllowedCharacters: allowed) ?? providerId
    }

    private static func loadAccounts(from directory: URL) throws -> [String: [AccountRecord]] {
        let files = (try? FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: nil
        )) ?? []
        var result: [String: [AccountRecord]] = [:]
        for file in files where file.pathExtension == "json" {
            let data: Data
            let document: ProviderAccountsDocument
            do {
                data = try Data(contentsOf: file)
                document = try JSONDecoder().decode(ProviderAccountsDocument.self, from: data)
            } catch {
                throw ProviderManagementStoreError(
                    message: "corrupt provider store file \(file.lastPathComponent): \(error.localizedDescription)"
                )
            }
            for account in document.accounts {
                result[account.providerId, default: []].append(account)
            }
        }
        for providerId in result.keys {
            result[providerId]?.sort { $0.accountRef < $1.accountRef }
        }
        return result
    }
}
