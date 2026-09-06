// Provider capability registry, metadata persistence and credential-store
// contracts. The registry is schema 1.2.0 and contains capability metadata
// only — never model catalog fields or secrets.
import Foundation
import XCTest
@testable import TokenMeterCore

final class ProviderManagementTests: XCTestCase {
    private static let pinnedOMPSHA = "8500092296621a6826b7136e840f8a59ea338958"

    private static let lockedIDs = [
        "alibaba-token-plan",
        "anthropic",
        "cursor",
        "github-copilot",
        "google-antigravity",
        "google-gemini-cli",
        "kimi-code",
        "minimax-code",
        "nekos",
        "ollama",
        "ollama-cloud",
        "openai-codex",
        "opencode-go",
        "synthetic",
        "umans",
        "xai-oauth",
        "zai",
    ]

    // MARK: - Registry 1.2.0 and locked provider set

    func testLockedProviderIDsAreExactlyTheSeventeenLockedEntries() {
        let ids = ProviderCatalog.lockedProviderIds
        XCTAssertEqual(ids.count, 17)
        XCTAssertEqual(Set(ids).count, 17, "provider ids must be unique")
        XCTAssertEqual(ids, ids.sorted(), "provider ids must be stable and sorted")
        XCTAssertEqual(ids, Self.lockedIDs)
    }

    func testBundledRegistryResourceDecodesAsSchema120() throws {
        let decoded = try ProviderCatalog(decoding: Self.registryResourceData())

        XCTAssertEqual(decoded.schemaVersion, "1.2.0")
        XCTAssertEqual(decoded.syncedFromSha, Self.pinnedOMPSHA)
        XCTAssertEqual(decoded.providers.count, 17)
        XCTAssertEqual(decoded.providers.map(\.id), Self.lockedIDs)
        XCTAssertEqual(decoded, ProviderCatalog.locked)
        for provider in decoded.providers {
            XCTAssertFalse(provider.authMethods.isEmpty, "\(provider.id) must offer an auth method")
            XCTAssertFalse(provider.credentialKinds.isEmpty, "\(provider.id) must declare a credential kind")
            XCTAssertTrue(
                provider.connectorTransport.wireValue.hasPrefix("builtin-"),
                "\(provider.id) must use a builtin transport"
            )
        }
    }

    func testPackagedRegistryResourceShipsInsideTheModuleBundle() throws {
        let url = try XCTUnwrap(
            Bundle.module.url(forResource: "provider-capabilities", withExtension: "json"),
            "provider-capabilities.json must be packaged as a TokenMeterCore resource"
        )
        let decoded = try ProviderCatalog(decoding: Data(contentsOf: url))

        XCTAssertEqual(decoded.schemaVersion, ProviderCatalog.registrySchemaVersion)
        XCTAssertEqual(decoded.syncedFromSha, Self.pinnedOMPSHA)
        XCTAssertEqual(decoded.providers.map(\.id), Self.lockedIDs)
        XCTAssertEqual(decoded, ProviderCatalog.locked, "the runtime catalog must decode the packaged resource")
    }

    func testFinalDualMethodProvidersExposeBothMethods() {
        let authMethodsByID = Dictionary(
            uniqueKeysWithValues: ProviderCatalog.locked.providers.map { ($0.id, $0.authMethods) }
        )
        XCTAssertEqual(authMethodsByID["openai-codex"], [.browser, .device])
        XCTAssertEqual(authMethodsByID["github-copilot"], [.apiKey, .device])
        XCTAssertEqual(authMethodsByID["cursor"], [.browser, .apiKey])
        XCTAssertEqual(authMethodsByID["zai"], [.apiKey, .browser])
    }

    func testLockedCatalogPreservesDisplayNameMap() {
        let catalog = ProviderCatalog.locked
        XCTAssertEqual(catalog.providers.count, 17)
        XCTAssertEqual(Set(catalog.providers.map(\.id)), Set(Self.lockedIDs))
        for provider in catalog.providers {
            XCTAssertFalse(provider.displayName.isEmpty)
        }
        XCTAssertEqual(
            catalog.providers.first { $0.id == "github-copilot" }?.displayName,
            "GitHub Copilot"
        )
        XCTAssertEqual(
            catalog.providers.first { $0.id == "xai-oauth" }?.displayName,
            "xAI OAuth"
        )
    }

    func testGitHubCopilotRegistryCapabilities() throws {
        let github = try XCTUnwrap(
            ProviderCatalog.locked.providers.first { $0.id == "github-copilot" }
        )
        XCTAssertEqual(github.registrySupportTier, .supported)
        XCTAssertEqual(github.connectorTransport, .builtin("github-billing"))
        XCTAssertEqual(github.authMethods, [.apiKey, .device])
        XCTAssertEqual(github.credentialKinds, [.bearer, .apiKey])
        XCTAssertEqual(github.productKind, .billingUsage)
        XCTAssertEqual(github.sourceKind, .documentedApi)
        XCTAssertEqual(github.authorizationBasis, .documentedUserBilling)
        XCTAssertEqual(github.declaredUnit, .requests)
        XCTAssertEqual(github.declaredWindows, [.monthly])
        XCTAssertEqual(github.pollingPolicy, .authorizedDefault)

        for provider in ProviderCatalog.locked.providers where provider.id != "github-copilot" {
            XCTAssertEqual(provider.pollingPolicy, .notPolled)
        }
    }

    // MARK: - No model catalog anywhere

    func testEncodedCatalogContainsNoModelFields() throws {
        let data = try JSONEncoder().encode(ProviderCatalog.locked)
        let keys = collectJSONKeys(try jsonObject(from: data))
        let modelKeys = keys.filter { $0.lowercased().contains("model") }
        XCTAssertEqual(modelKeys, [], "the capability catalog must not carry model fields")
    }

    func testCatalogDecodingRejectsModelFieldsAndUnknownFields() throws {
        var object = try jsonObject(from: Self.registryResourceData())

        object["unexpectedTopLevel"] = "no"
        XCTAssertThrowsError(
            try ProviderCatalog(decoding: JSONSerialization.data(withJSONObject: object))
        )

        object.removeValue(forKey: "unexpectedTopLevel")
        if var providers = object["providers"] as? [[String: Any]], !providers.isEmpty {
            providers[0]["modelList"] = [String]()
            object["providers"] = providers
        }
        XCTAssertThrowsError(
            try ProviderCatalog(decoding: JSONSerialization.data(withJSONObject: object))
        )
    }

    func testCatalogRejectsWrongRegistryVersion() throws {
        var object = try jsonObject(from: Self.registryResourceData())
        object["schemaVersion"] = "1.1.0"
        XCTAssertThrowsError(
            try ProviderCatalog(decoding: JSONSerialization.data(withJSONObject: object))
        )
    }

    func testCatalogRoundTripsThroughCodableWithoutLoss() throws {
        let catalog = ProviderCatalog.locked
        let data = try JSONEncoder().encode(catalog)
        XCTAssertEqual(try ProviderCatalog(decoding: data), catalog)
    }

    // MARK: - Provider management persistence (no secret material)

    func testProviderStorePersistsAccountsAcrossInstancesWithoutSecrets() throws {
        let directory = makeTempDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }

        let account = AccountRecord(
            providerId: "github-copilot",
            accountRef: testAccountRef,
            displayName: "Work PAT",
            credentialRevision: 3
        )
        let other = AccountRecord(
            providerId: "anthropic",
            accountRef: "00000000-0000-4000-8000-000000000003",
            displayName: "Console key",
            credentialRevision: 1
        )

        let store = try ProviderManagementStore(storageDirectory: directory)
        try store.upsert(account: account)
        try store.upsert(account: other)

        let reloaded = try ProviderManagementStore(storageDirectory: directory)
        XCTAssertEqual(Set(try reloaded.accounts(forProvider: "github-copilot")), [account])
        XCTAssertEqual(Set(try reloaded.accounts(forProvider: "anthropic")), [other])

        let persistedFiles = try FileManager.default
            .contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "json" }
        XCTAssertFalse(persistedFiles.isEmpty, "the store must persist to disk")
        let allowedKeys: Set<String> = [
            "accounts", "providerId", "accountRef", "displayName", "credentialRevision",
        ]
        for file in persistedFiles {
            let keys = collectJSONKeys(try jsonObject(from: try Data(contentsOf: file)))
            XCTAssertTrue(
                keys.isSubset(of: allowedKeys),
                "unexpected persisted keys \(keys.subtracting(allowedKeys)) in \(file.lastPathComponent)"
            )
        }
    }

    func testProviderStoreRemovesAccounts() throws {
        let directory = makeTempDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }

        let store = try ProviderManagementStore(storageDirectory: directory)
        try store.upsert(account: AccountRecord(
            providerId: "github-copilot",
            accountRef: testAccountRef,
            displayName: "Work PAT",
            credentialRevision: 3
        ))
        try store.removeAccount(providerId: "github-copilot", accountRef: testAccountRef)

        let reloaded = try ProviderManagementStore(storageDirectory: directory)
        XCTAssertEqual(try reloaded.accounts(forProvider: "github-copilot"), [])
    }

    private static func registryResourceData() throws -> Data {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        return try Data(contentsOf: root.appendingPathComponent(
            "Sources/TokenMeterCore/Resources/provider-capabilities.json"
        ))
    }
}
