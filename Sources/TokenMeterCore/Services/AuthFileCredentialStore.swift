// File-owned credential storage behind `~/Library/Application Support/TokenMeter/auth.json`.
//
// One JSON document holds every logical credential. Each account's value is
// a versioned storage envelope holding the complete TokenMeter credential
// union and its revision counter. Provider and account display metadata —
// and the credential revision mirrored into `AccountRecord` — live outside
// this file; nothing secret-derived is ever used as an identifier or
// included in an error.
import Foundation

public struct StoredCredential: Equatable, Sendable {
    public let credential: BridgeCredential
    public let revision: Int

    public init(credential: BridgeCredential, revision: Int) {
        self.credential = credential
        self.revision = revision
    }

    /// The credential's primary secret: the static secret, or the access
    /// token the oauth `secret` mirrors. Kept for current app call sites;
    /// new code should forward `credential` so oauth metadata is preserved.
    public var secret: String {
        credential.secret
    }

    /// Compatibility constructor for the 1.0.0-era secret-only API. The
    /// bare secret is represented as the static bearer credential the old
    /// app built at fetch time.
    @available(*, deprecated, message: "use init(credential:revision:)")
    public init(secret: String, revision: Int) {
        self.init(
            credential: .staticCredential(kind: .bearer, secret: secret),
            revision: revision
        )
    }
}

public struct AuthFileCredentialStoreError: Error, Equatable, Sendable {
    public let message: String

    public init(message: String) {
        self.message = message
    }
}

public final class AuthFileCredentialStore: @unchecked Sendable {
    // Per-entry storage schema is independent from the TokenMeter wire
    // version. The 1.2.0 `none` arm is never persisted, so existing 1.1.0
    // items remain readable without migration.
    public static let envelopeSchemaVersion = "1.1.0"
    public static let documentSchemaVersion = "1.0.0"

    public let fileURL: URL
    private let lock = NSLock()

    public init(fileURL: URL) {
        self.fileURL = fileURL
    }

    public init() {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        self.fileURL = base
            .appendingPathComponent("TokenMeter", isDirectory: true)
            .appendingPathComponent("auth.json", isDirectory: false)
    }

    private struct Document: Codable, Equatable {
        let schemaVersion: String
        var credentials: [String: Envelope]
    }

    private struct Envelope: Codable, Equatable {
        let schemaVersion: String
        let credential: BridgeCredential
        let revision: Int
    }

    /// Compatibility API: stores the bare secret as a static bearer
    /// credential and bumps the revision atomically.
    @discardableResult
    public func save(secret: String, for accountRef: String) throws -> Int {
        try save(
            credential: .staticCredential(kind: .bearer, secret: secret),
            for: accountRef
        )
    }

    /// Stores the full credential union and bumps the revision atomically,
    /// returning the new revision (1 for a fresh item). The `none` arm
    /// removes any prior entry and returns metadata revision 0.
    @discardableResult
    public func save(credential: BridgeCredential, for accountRef: String) throws -> Int {
        lock.lock()
        defer { lock.unlock() }
        // An explicit save is the recovery path: a missing or unreadable file
        // becomes a fresh document. Load never overwrites on its own.
        var document = (try? loadDocument()) ?? Document(
            schemaVersion: Self.documentSchemaVersion,
            credentials: [:]
        )
        if credential == .none {
            document.credentials.removeValue(forKey: accountRef)
            try persist(document)
            return 0
        }
        let revision = (document.credentials[accountRef]?.revision ?? 0) + 1
        document.credentials[accountRef] = Envelope(
            schemaVersion: Self.envelopeSchemaVersion,
            credential: credential,
            revision: revision
        )
        try persist(document)
        return revision
    }

    /// Loads the complete decoded credential union and its revision.
    public func load(for accountRef: String) throws -> StoredCredential? {
        lock.lock()
        defer { lock.unlock() }
        guard let envelope = try loadDocument().credentials[accountRef] else { return nil }
        return StoredCredential(
            credential: envelope.credential,
            revision: envelope.revision
        )
    }

    /// Idempotent: deleting a missing item succeeds.
    public func delete(for accountRef: String) throws {
        lock.lock()
        defer { lock.unlock() }
        var document = try loadDocument()
        guard document.credentials.removeValue(forKey: accountRef) != nil else { return }
        try persist(document)
    }

    // MARK: - Internals

    private func loadDocument() throws -> Document {
        let path = fileURL.path
        guard FileManager.default.fileExists(atPath: path) else {
            return Document(schemaVersion: Self.documentSchemaVersion, credentials: [:])
        }
        let data: Data
        do {
            data = try Data(contentsOf: fileURL)
        } catch {
            throw AuthFileCredentialStoreError(message: "failed to read credential store")
        }
        let document: Document
        do {
            document = try JSONDecoder().decode(Document.self, from: data)
        } catch {
            // Never forward JSONDecoder diagnostics: stored credential bytes
            // must not appear in logs or errors.
            throw AuthFileCredentialStoreError(message: "corrupt credential store")
        }
        guard document.schemaVersion == Self.documentSchemaVersion else {
            throw AuthFileCredentialStoreError(message: "unsupported credential store schema")
        }
        for envelope in document.credentials.values {
            guard envelope.schemaVersion == Self.envelopeSchemaVersion else {
                throw AuthFileCredentialStoreError(message: "unsupported credential envelope schema")
            }
        }
        return document
    }

    private func persist(_ document: Document) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let data: Data
        do {
            data = try encoder.encode(document)
        } catch {
            // Never forward the encoding error: it may quote encoded input.
            throw AuthFileCredentialStoreError(message: "failed to encode credential store")
        }

        let fileManager = FileManager.default
        let directory = fileURL.deletingLastPathComponent()
        do {
            if !fileManager.fileExists(atPath: directory.path) {
                try fileManager.createDirectory(
                    at: directory,
                    withIntermediateDirectories: true,
                    attributes: [.posixPermissions: NSNumber(value: Int16(0o700))]
                )
            }
        } catch {
            throw AuthFileCredentialStoreError(message: "failed to prepare credential store directory")
        }

        let temporary = directory
            .appendingPathComponent(".\(fileURL.lastPathComponent).tmp-\(UUID().uuidString)")
        do {
            try data.write(to: temporary, options: .withoutOverwriting)
            try fileManager.setAttributes(
                [.posixPermissions: NSNumber(value: Int16(0o600))],
                ofItemAtPath: temporary.path
            )
            if fileManager.fileExists(atPath: fileURL.path) {
                _ = try fileManager.replaceItemAt(fileURL, withItemAt: temporary)
            } else {
                try fileManager.moveItem(at: temporary, to: fileURL)
            }
            try fileManager.setAttributes(
                [.posixPermissions: NSNumber(value: Int16(0o600))],
                ofItemAtPath: fileURL.path
            )
        } catch {
            try? fileManager.removeItem(at: temporary)
            throw AuthFileCredentialStoreError(message: "failed to persist credential store")
        }
    }
}
