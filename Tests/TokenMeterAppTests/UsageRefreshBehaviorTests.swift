import Foundation
import XCTest
import TokenMeterCore
@testable import TokenMeterApp

/// Usage refresh behavior: credential writeback happens before an error is
/// surfaced, nil fractions render without a progress bar, and noQuota
/// providers render an honest empty note instead of a failure.
@MainActor
final class UsageRefreshBehaviorTests: XCTestCase {
    private func makeModel(
        credentials: AppTestCredentialStore = AppTestCredentialStore(),
        bridge: AppTestBridge = AppTestBridge(),
        metadata: ProviderManagementStore? = nil
    ) -> TokenMeterViewModel {
        TokenMeterViewModel(
            credentialStore: credentials,
            bridge: bridge,
            providerManagementStore: metadata
        )
    }

    // MARK: - Error writeback ordering

    func testUsageErrorWithRefreshedCredentialPersistsFirstThenShowsUnderlyingError() async throws {
        let directory = temporaryStoreDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let metadata = try ProviderManagementStore(storageDirectory: directory)
        let credentials = AppTestCredentialStore()
        let bridge = AppTestBridge()
        bridge.stubLoginOutcome { request in
            .success(LoginSuccess(
                providerId: request.providerId,
                completedAtMs: 21,
                credential: .staticCredential(kind: .bearer, secret: "bridge-minted-github")
            ))
        }
        let rotated = BridgeCredential.oauth(access: "rotated-access", refresh: "rotated-refresh")
        bridge.usageHandler = { _ in
            .failure(.credentialUpdated(rotated, underlying: .rateLimited(retryAfterMs: 4_000)))
        }
        let model = makeModel(credentials: credentials, bridge: bridge, metadata: metadata)

        await model.register(
            providerId: "github-copilot",
            method: .apiKey,
            inputs: LoginInputs(apiKey: "github-token")
        )

        let accountRef = try XCTUnwrap(model.accountRef(for: "github-copilot"))
        XCTAssertTrue(
            credentials.stored(for: accountRef)?.credential == rotated,
            "refreshed credential is persisted before the error is shown"
        )
        XCTAssertEqual(credentials.stored(for: accountRef)?.revision, 2)
        XCTAssertEqual(model.credentialRevision(for: "github-copilot"), 2)
        XCTAssertEqual(
            try metadata.accounts(forProvider: "github-copilot").first?.credentialRevision,
            2
        )
        XCTAssertEqual(model.card(for: "github-copilot")?.error, .rateLimited(retryAfterMs: 4_000))
    }

    func testUsageSuccessWithRefreshedCredentialPersistsAndProjectsReport() async throws {
        let credentials = AppTestCredentialStore()
        let bridge = AppTestBridge()
        bridge.stubLoginOutcome { request in
            .success(LoginSuccess(
                providerId: request.providerId,
                completedAtMs: 22,
                credential: .oauth(access: "bridge-minted-anthropic", refresh: "bridge-minted-refresh")
            ))
        }
        let rotated = BridgeCredential.oauth(access: "rotated-access-2", refresh: "rotated-refresh-2")
        bridge.usageHandler = { request in
            .report(testReport(
                for: request,
                limits: [
                    QuotaLimit(
                        limitId: "five-hour",
                        productKind: .quota,
                        unit: .percent,
                        utilization: Utilization(fraction: 0.42),
                        windowSeconds: 18_000
                    ),
                ],
                refreshedCredential: rotated
            ))
        }
        let model = makeModel(credentials: credentials, bridge: bridge)

        await model.register(providerId: "anthropic", method: .browser)

        let accountRef = try XCTUnwrap(model.accountRef(for: "anthropic"))
        XCTAssertTrue(credentials.stored(for: accountRef)?.credential == rotated)
        XCTAssertEqual(model.card(for: "anthropic")?.rows.first?.limitId, "five-hour")
        XCTAssertEqual(model.card(for: "anthropic")?.error, nil)
    }

    func testRefreshWithoutStoredCredentialSurfacesMissingCredential() async throws {
        let credentials = AppTestCredentialStore()
        let bridge = AppTestBridge()
        bridge.stubLoginOutcome { request in
            .success(LoginSuccess(
                providerId: request.providerId,
                completedAtMs: 23,
                credential: .staticCredential(kind: .apiKey, secret: "bridge-minted-minimax")
            ))
        }
        let model = makeModel(credentials: credentials, bridge: bridge)
        await model.register(providerId: "minimax-code", method: .apiKey, inputs: LoginInputs(apiKey: "k"))

        try credentials.delete(for: XCTUnwrap(model.accountRef(for: "minimax-code")))
        await model.refresh(providerId: "minimax-code")

        XCTAssertEqual(model.card(for: "minimax-code")?.error, .missingCredential)
        XCTAssertEqual(bridge.usageRequests.count, 1, "the missing credential refresh never reaches the bridge")
    }

    // MARK: - Nil fraction renders no progress bar

    func testNilFractionQuotaRowRendersNoProgressBar() {
        let nowMs: Int64 = 1_000_000
        let report = UsageReport(
            schemaVersion: "1.1.0",
            requestId: "request-1",
            providerId: "opencode-go",
            connectorId: "opencode-go",
            accountRef: "account-1",
            fetchedAtMs: nowMs,
            limits: [
                QuotaLimit(
                    limitId: "opaque-window",
                    productKind: .quota,
                    unit: .tokens,
                    utilization: Utilization(used: 3, limit: 10)
                ),
                QuotaLimit(
                    limitId: "five-hour",
                    productKind: .quota,
                    unit: .percent,
                    utilization: Utilization(fraction: 0.42),
                    windowSeconds: 18_000
                ),
            ]
        )
        let rows = QuotaProjector().rows(for: report, nowMs: nowMs)
        XCTAssertEqual(rows.map(\.limitId), ["opaque-window", "five-hour"])
        XCTAssertEqual(rows[0].showsProgressBar, false, "nil fraction renders no bar")
        XCTAssertEqual(rows[1].showsProgressBar, true)
    }

    func testCardCarriesNilFractionRowThroughProjectionWithoutInventingAFraction() async throws {
        let credentials = AppTestCredentialStore()
        let bridge = AppTestBridge()
        bridge.stubLoginOutcome { request in
            .success(LoginSuccess(
                providerId: request.providerId,
                completedAtMs: 24,
                credential: .staticCredential(kind: .apiKey, secret: "bridge-minted-opencode")
            ))
        }
        bridge.usageHandler = { request in
            .report(testReport(for: request, limits: [
                QuotaLimit(
                    limitId: "opaque-window",
                    productKind: .quota,
                    unit: .tokens,
                    utilization: Utilization(used: 120, limit: nil),
                    windowSeconds: nil,
                    resetsAtMs: nil
                ),
            ]))
        }
        let model = makeModel(credentials: credentials, bridge: bridge)

        await model.register(providerId: "opencode-go", method: .apiKey, inputs: LoginInputs(apiKey: "k"))

        let row = try XCTUnwrap(model.card(for: "opencode-go")?.rows.first)
        XCTAssertNil(row.fraction, "no fraction is invented for a count-only limit")
        XCTAssertEqual(row.showsProgressBar, false)
    }

    // MARK: - noQuota honest empty state

    func testOllamaCloudEmptyReportRendersHonestNoteWithoutError() async throws {
        let bridge = AppTestBridge()
        bridge.stubLoginOutcome { request in
            .success(LoginSuccess(
                providerId: request.providerId,
                completedAtMs: 25,
                credential: .staticCredential(kind: .apiKey, secret: "bridge-minted-ollama-cloud")
            ))
        }
        bridge.usageHandler = { request in .report(testReport(for: request)) }
        let model = makeModel(bridge: bridge)

        await model.register(
            providerId: "ollama-cloud",
            method: .apiKey,
            inputs: LoginInputs(apiKey: "ollama-cloud-key")
        )

        let card = try XCTUnwrap(model.card(for: "ollama-cloud"))
        XCTAssertEqual(card.rows, [])
        XCTAssertEqual(card.error, nil, "the honest empty report is not an error")
        XCTAssertEqual(card.showsNoStandaloneUsageAPI, true)
    }

    // MARK: - Authorized default auto-refresh

    func testAuthorizedDefaultProviderRestoresWithAutomaticRefresh() async throws {
        let directory = temporaryStoreDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let metadata = try ProviderManagementStore(storageDirectory: directory)
        let accountRef = UUID().uuidString
        try metadata.upsert(account: AccountRecord(
            providerId: "github-copilot",
            accountRef: accountRef,
            displayName: "GitHub",
            credentialRevision: 1
        ))
        let credentials = AppTestCredentialStore()
        try credentials.save(
            credential: .staticCredential(kind: .bearer, secret: "restored-github-token"),
            for: accountRef
        )
        let bridge = AppTestBridge()
        let fetched = expectation(description: "authorizedDefault usage fetch")
        bridge.onUsage = { fetched.fulfill() }

        let model = makeModel(credentials: credentials, bridge: bridge, metadata: metadata)
        await fulfillment(of: [fetched], timeout: 2)

        XCTAssertEqual(model.isRegistered("github-copilot"), true)

        XCTAssertEqual(bridge.usageRequests.first?.providerId, "github-copilot")
        XCTAssertEqual(bridge.usageRequests.first?.connectorId, "github-copilot")
        XCTAssertEqual(
            ProviderCatalog.locked.providers.filter(\.allowsAutomaticRefresh).map(\.id),
            ["github-copilot"]
        )
    }
}
