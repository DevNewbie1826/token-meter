import Combine
import Foundation
import XCTest
import TokenMeterCore
@testable import TokenMeterApp

private final class SaveOnlyCredentialStore: CredentialStoreProtocol, @unchecked Sendable {
    func save(credential: BridgeCredential, for accountRef: String) throws -> Int {
        credential == .none ? 0 : 1
    }

    func load(for accountRef: String) throws -> StoredCredential? {
        throw NSError(domain: "SaveOnlyCredentialStore", code: 1)
    }

    func delete(for accountRef: String) throws {}
}

/// Every registration — API key included — must start a bridge LoginSession
/// with structured inputs, and only ever store the credential the bridge
/// returns. No UI path constructs or persists a credential locally.
@MainActor
final class BridgeRoutedRegistrationTests: XCTestCase {
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

    // MARK: - Method families

    func testAPIKeyFamilyRoutesThroughBridgeLoginAndStoresOnlyMintedCredential() async throws {
        let credentials = AppTestCredentialStore()
        let bridge = AppTestBridge()
        bridge.stubLoginOutcome { request in
            .success(LoginSuccess(
                providerId: request.providerId,
                completedAtMs: 11,
                credential: .staticCredential(kind: .apiKey, secret: "bridge-minted-minimax")
            ))
        }
        let model = makeModel(credentials: credentials, bridge: bridge)

        await model.register(
            providerId: "minimax-code",
            method: .apiKey,
            inputs: LoginInputs(apiKey: "user-typed-minimax-key"),
            accountLabel: "Team"
        )

        XCTAssertEqual(bridge.loginRequests.map(\.method), [.apiKey])
        XCTAssertEqual(bridge.loginRequests.map(\.providerId), ["minimax-code"])
        let input = try XCTUnwrap(bridge.loginRequests.first?.inputs)
        XCTAssertTrue(input.apiKey == "user-typed-minimax-key", "the typed key travels to the helper verbatim")

        let accountRef = try XCTUnwrap(model.accountRef(for: "minimax-code"))
        let stored = try XCTUnwrap(credentials.stored(for: accountRef))
        XCTAssertTrue(
            stored.credential == .staticCredential(kind: .apiKey, secret: "bridge-minted-minimax"),
            "stored credential is the bridge-minted one, never the typed key wrapped locally"
        )
        XCTAssertEqual(model.credentialRevision(for: "minimax-code"), stored.revision)
        XCTAssertEqual(bridge.usageRequests.count, 1, "registration completes with a real usage refresh")
        XCTAssertEqual(bridge.usageRequests.first?.providerId, "minimax-code")
    }

    func testInitialRefreshUsesMintedCredentialWithoutReloadingCredentialFile() async throws {
        let bridge = AppTestBridge()
        bridge.stubLoginOutcome { request in
            .success(LoginSuccess(
                providerId: request.providerId,
                completedAtMs: 11,
                credential: .staticCredential(kind: .apiKey, secret: "bridge-minted-kimi")
            ))
        }
        bridge.usageHandler = { request in
            .report(testReport(
                for: request,
                limits: [
                    QuotaLimit(
                        limitId: "kimi:5h",
                        productKind: .quota,
                        unit: .unknown,
                        utilization: Utilization(fraction: 1),
                        windowSeconds: 18_000
                    ),
                ]
            ))
        }
        let model = TokenMeterViewModel(
            credentialStore: SaveOnlyCredentialStore(),
            bridge: bridge
        )

        await model.register(
            providerId: "kimi-code",
            method: .apiKey,
            inputs: LoginInputs(apiKey: "typed-kimi-key")
        )

        XCTAssertEqual(
            bridge.usageRequests.count,
            1,
            "registration must refresh with the minted credential without a credential-file reload"
        )
        XCTAssertEqual(model.card(for: "kimi-code")?.rows.map(\.limitId), ["kimi:5h"])
        XCTAssertNil(model.card(for: "kimi-code")?.error)
    }

    func testBrowserFamilyRoutesThroughBridgeLoginAndOpensAuthorizationURL() async throws {
        let credentials = AppTestCredentialStore()
        let bridge = AppTestBridge()
        bridge.initialLoginEvents = { _ in
            [.openUrl(url: "https://login.example/authorize")]
        }
        bridge.stubLoginOutcome { request in
            .success(LoginSuccess(
                providerId: request.providerId,
                completedAtMs: 12,
                credential: .oauth(access: "bridge-minted-anthropic", refresh: "bridge-minted-refresh"),
                accountLabel: "Anthropic user"
            ))
        }
        var openedURLs: [URL] = []
        let model = TokenMeterViewModel(
            credentialStore: credentials,
            bridge: bridge,
            openURL: { openedURLs.append($0) }
        )

        await model.register(providerId: "anthropic", method: .browser)

        XCTAssertEqual(bridge.loginRequests.map(\.method), [.browser])
        XCTAssertEqual(openedURLs.map(\.absoluteString), ["https://login.example/authorize"])
        let accountRef = try XCTUnwrap(model.accountRef(for: "anthropic"))
        XCTAssertTrue(
            credentials.stored(for: accountRef)?.credential
                == .oauth(access: "bridge-minted-anthropic", refresh: "bridge-minted-refresh"),
            "browser credential minted by the bridge is stored verbatim"
        )
        XCTAssertEqual(bridge.usageRequests.count, 1)
    }

    func testDeviceFamilySurfacesCodeAndVerificationURL() async throws {
        let bridge = AppTestBridge()
        bridge.initialLoginEvents = { _ in
            [
                .openUrl(url: "https://device.example/verify?user_code=ABCD-EFGH"),
                .code(code: "ABCD-EFGH", verificationUrl: "https://device.example/verify"),
                .waiting(detail: "승인을 기다리는 중"),
            ]
        }
        bridge.stubLoginOutcome { request in
            .success(LoginSuccess(
                providerId: request.providerId,
                completedAtMs: 13,
                credential: .oauth(access: "bridge-minted-kimi")
            ))
        }
        var openedURLs: [URL] = []
        let model = TokenMeterViewModel(
            credentialStore: AppTestCredentialStore(),
            bridge: bridge,
            openURL: { openedURLs.append($0) }
        )

        await model.register(providerId: "kimi-code", method: .device)

        XCTAssertEqual(bridge.loginRequests.map(\.method), [.device])
        XCTAssertEqual(model.progress(for: "kimi-code")?.code, "ABCD-EFGH")
        XCTAssertEqual(model.progress(for: "kimi-code")?.verificationURL, "https://device.example/verify")
        XCTAssertEqual(model.progress(for: "kimi-code")?.isActive, false)
        XCTAssertEqual(
            openedURLs.map(\.absoluteString),
            ["https://device.example/verify?user_code=ABCD-EFGH"]
        )
        XCTAssertTrue(model.isRegistered("kimi-code"))
    }

    // MARK: - Provider-specific structured inputs

    func testAlibabaRegistrationSendsKeyCookieAndBaseURLInputs() async throws {
        let bridge = AppTestBridge()
        bridge.stubLoginOutcome { request in
            .success(LoginSuccess(
                providerId: request.providerId,
                completedAtMs: 14,
                credential: .staticCredential(
                    kind: .apiKey,
                    secret: "{\"token\":\"sk-alibaba\",\"cookie\":\"a=b\",\"baseUrl\":\"https://cn.example\"}"
                )
            ))
        }
        let model = makeModel(bridge: bridge)

        await model.register(
            providerId: "alibaba-token-plan",
            method: .apiKey,
            inputs: LoginInputs(
                apiKey: "sk-alibaba",
                apiBaseUrl: "https://cn.example/compatible-mode/v1",
                cookieHeader: "login_aliyunid_csrf=abc; login_aliyunid_tt=xyz"
            )
        )

        let input = try XCTUnwrap(bridge.loginRequests.first?.inputs)
        XCTAssertTrue(input.apiKey == "sk-alibaba")
        XCTAssertTrue(input.cookieHeader == "login_aliyunid_csrf=abc; login_aliyunid_tt=xyz")
        XCTAssertTrue(input.apiBaseUrl == "https://cn.example/compatible-mode/v1")
        XCTAssertTrue(model.isRegistered("alibaba-token-plan"))
    }

    func testGitHubDeviceSendsEnterpriseHostInput() async throws {
        let bridge = AppTestBridge()
        bridge.stubLoginOutcome { request in
            .success(LoginSuccess(
                providerId: request.providerId,
                completedAtMs: 15,
                credential: .oauth(access: "bridge-minted-enterprise-github")
            ))
        }
        let model = makeModel(bridge: bridge)

        await model.register(
            providerId: "github-copilot",
            method: .device,
            inputs: LoginInputs(enterpriseHost: "ghe.example.com")
        )

        XCTAssertEqual(bridge.loginRequests.map(\.method), [.device])
        XCTAssertTrue(bridge.loginRequests.first?.inputs?.enterpriseHost == "ghe.example.com")
        XCTAssertTrue(model.isRegistered("github-copilot"))
    }

    // MARK: - Ollama blank key

    func testOllamaBlankKeyIsOmittedOnTheWireAndStoresBridgeReturnedNoneCredential() async throws {
        let credentials = AppTestCredentialStore()
        let bridge = AppTestBridge()
        bridge.stubLoginOutcome { request in
            .success(LoginSuccess(
                providerId: request.providerId,
                completedAtMs: 16,
                credential: BridgeCredential.none,
                accountLabel: "Local (no key)"
            ))
        }
        bridge.usageHandler = { request in .report(testReport(for: request)) }
        let model = makeModel(credentials: credentials, bridge: bridge)

        // A blank key must be omitted: the wire rejects present-but-empty
        // inputs, and the helper answers the omitted key with the honest
        // `{none}` credential.
        await model.register(
            providerId: "ollama",
            method: .apiKey,
            inputs: ProviderLoginFieldPolicy.loginInputs(from: [.apiKey: "  "])
        )

        XCTAssertEqual(bridge.loginRequests.map(\.method), [.apiKey])
        XCTAssertNil(bridge.loginRequests.first?.inputs?.apiKey, "blank key is omitted on the wire")
        XCTAssertTrue(model.isRegistered("ollama"))
        XCTAssertEqual(model.card(for: "ollama")?.accountName, "Local (no key)")

        let accountRef = try XCTUnwrap(model.accountRef(for: "ollama"))
        XCTAssertNil(credentials.stored(for: accountRef), "none credential is not persisted as a secret")

        XCTAssertEqual(bridge.usageRequests.count, 1)
        XCTAssertEqual(bridge.usageRequests.first?.credential, BridgeCredential.none, "refresh uses the honest none credential")
        XCTAssertNil(model.card(for: "ollama")?.error, "empty noQuota report is not an error")
        XCTAssertEqual(model.card(for: "ollama")?.showsNoStandaloneUsageAPI, true)
    }

    // MARK: - Bridge validation

    func testBridgeAPIKeyValidationFailureSurfacesTypedErrorAndPersistsNothing() async throws {
        let directory = temporaryStoreDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let metadata = try ProviderManagementStore(storageDirectory: directory)
        let credentials = AppTestCredentialStore()
        let bridge = AppTestBridge()
        bridge.stubLoginOutcome { _ in
            .failure(.invalidRequest("QwenCloud Token Plan login requires an API key"))
        }
        let model = makeModel(credentials: credentials, bridge: bridge, metadata: metadata)

        await model.register(providerId: "alibaba-token-plan", method: .apiKey, inputs: LoginInputs(apiKey: " "))

        XCTAssertEqual(
            model.authenticationErrors["alibaba-token-plan"],
            .invalidRequest("QwenCloud Token Plan login requires an API key")
        )
        XCTAssertFalse(model.isRegistered("alibaba-token-plan"))
        XCTAssertNil(model.accountRef(for: "alibaba-token-plan"))
        XCTAssertTrue(credentials.deleted.isEmpty)
        XCTAssertTrue(try metadata.accounts(forProvider: "alibaba-token-plan").isEmpty)
        XCTAssertTrue(bridge.usageRequests.isEmpty)
    }

    func testUndeclaredMethodFailsWithoutStartingALoginSession() async {
        let bridge = AppTestBridge()
        let model = makeModel(bridge: bridge)

        await model.register(providerId: "anthropic", method: .apiKey)

        XCTAssertEqual(model.authenticationErrors["anthropic"], .invalidProvider("anthropic"))
        XCTAssertTrue(bridge.loginRequests.isEmpty)
    }

    func testLoginCredentialOfUndeclaredKindIsRejected() async {
        let bridge = AppTestBridge()
        bridge.stubLoginOutcome { request in
            .success(LoginSuccess(
                providerId: request.providerId,
                completedAtMs: 17,
                credential: .staticCredential(kind: .bearer, secret: "undeclared-kind")
            ))
        }
        let model = makeModel(bridge: bridge)

        await model.register(providerId: "minimax-code", method: .apiKey, inputs: LoginInputs(apiKey: "k"))

        XCTAssertFalse(model.isRegistered("minimax-code"))
        XCTAssertEqual(model.authenticationErrors["minimax-code"], .invalidProtocol("login returned an undeclared credential kind"))
    }

    // MARK: - Duplex prompt response

    func testPromptEventIsRenderedAndResponseReachesHelperThenMintedCredentialStores() async throws {
        let credentials = AppTestCredentialStore()
        let bridge = AppTestBridge()
        bridge.loginOutcome = { _, session in
            session.emit(.prompt(
                requestId: "prompt-1",
                prompt: "Paste your QwenCloud Token Plan API key",
                inputKind: .text,
                sensitive: true
            ))
            guard let response = await session.awaitResponse() else {
                return .failure(.timeout)
            }
            guard response.id == "prompt-1" else {
                return .failure(.invalidProtocol("prompt correlation mismatch"))
            }
            return .success(LoginSuccess(
                providerId: "alibaba-token-plan",
                completedAtMs: 18,
                credential: .staticCredential(kind: .apiKey, secret: "bridge-minted-after-prompt")
            ))
        }
        let model = makeModel(credentials: credentials, bridge: bridge)

        let promptVisible = expectation(description: "prompt becomes visible")
        let promptCleared = expectation(description: "prompt cleared after completion")
        var cancellables: Set<AnyCancellable> = []
        model.$authenticationProgress.sink { progress in
            if progress["alibaba-token-plan"]?.prompt != nil {
                promptVisible.fulfill()
            }
            if progress["alibaba-token-plan"] != nil,
               progress["alibaba-token-plan"]?.prompt == nil,
               progress["alibaba-token-plan"]?.isActive == false {
                promptCleared.fulfill()
            }
        }.store(in: &cancellables)

        let registration = Task {
            await model.register(providerId: "alibaba-token-plan", method: .apiKey, inputs: LoginInputs())
        }
        await fulfillment(of: [promptVisible], timeout: 2)

        let prompt = try XCTUnwrap(model.progress(for: "alibaba-token-plan")?.prompt)
        XCTAssertEqual(prompt.id, "prompt-1")
        XCTAssertEqual(prompt.prompt, "Paste your QwenCloud Token Plan API key")
        XCTAssertEqual(prompt.inputKind, .text)
        XCTAssertEqual(prompt.sensitive, true)

        model.respondToPrompt(providerId: "alibaba-token-plan", value: "  pasted-duplex-key  ")

        await registration.value
        await fulfillment(of: [promptCleared], timeout: 2)

        XCTAssertEqual(bridge.loginRequests.count, 1)
        let accountRef = try XCTUnwrap(model.accountRef(for: "alibaba-token-plan"))
        XCTAssertTrue(
            credentials.stored(for: accountRef)?.credential
                == .staticCredential(kind: .apiKey, secret: "bridge-minted-after-prompt"),
            "stored credential is minted by the bridge after the duplex round-trip"
        )
        XCTAssertEqual(model.progress(for: "alibaba-token-plan")?.prompt, nil)
    }

    func testCookieHeaderPromptCarriesItsInputKindToTheSheet() async throws {
        let bridge = AppTestBridge()
        bridge.loginOutcome = { _, session in
            session.emit(.prompt(
                requestId: "prompt-cookie",
                prompt: "Paste the complete Cookie request header",
                inputKind: .cookieHeader,
                sensitive: true
            ))
            _ = await session.awaitResponse()
            return .failure(.authRequired)
        }
        let model = makeModel(bridge: bridge)

        let promptVisible = expectation(description: "cookie prompt visible")
        var cancellables: Set<AnyCancellable> = []
        model.$authenticationProgress.sink { progress in
            if progress["alibaba-token-plan"]?.prompt?.inputKind == .cookieHeader {
                promptVisible.fulfill()
            }
        }.store(in: &cancellables)

        let registration = Task {
            await model.register(providerId: "alibaba-token-plan", method: .apiKey, inputs: LoginInputs(apiKey: "sk-x"))
        }
        await fulfillment(of: [promptVisible], timeout: 2)

        let prompt = try XCTUnwrap(model.progress(for: "alibaba-token-plan")?.prompt)
        XCTAssertEqual(prompt.inputKind, .cookieHeader)
        XCTAssertEqual(prompt.sensitive, true)

        model.respondToPrompt(providerId: "alibaba-token-plan", value: "a=b; c=d")
        await registration.value

        XCTAssertEqual(model.authenticationErrors["alibaba-token-plan"], .authRequired)
    }

    // MARK: - Cancellation reaps the helper session

    func testCancellationReapsHelperSessionWithoutRecordingAnError() async throws {
        let credentials = AppTestCredentialStore()
        let bridge = AppTestBridge()
        let sessionHolder = LoginSessionHolder()
        bridge.loginOutcome = { _, session in
            session.emit(.prompt(
                requestId: "prompt-1",
                prompt: "Paste your key",
                inputKind: .text,
                sensitive: true
            ))
            sessionHolder.value = session
            guard await session.awaitResponse() != nil else {
                return .failure(.timeout)
            }
            return .failure(.internalError("should not complete after cancel"))
        }
        let model = makeModel(credentials: credentials, bridge: bridge)

        let promptVisible = expectation(description: "prompt visible before cancel")
        var cancellables: Set<AnyCancellable> = []
        model.$authenticationProgress.sink { progress in
            if progress["minimax-code"]?.prompt != nil {
                promptVisible.fulfill()
            }
        }.store(in: &cancellables)

        let registration = Task {
            await model.register(providerId: "minimax-code", method: .apiKey, inputs: LoginInputs())
        }
        await fulfillment(of: [promptVisible], timeout: 2)

        model.cancelLogin(providerId: "minimax-code")
        await registration.value

        let session = try XCTUnwrap(sessionHolder.value)
        XCTAssertEqual(session.wasCancelled, true, "the live session's cancel() (process reap) ran")
        XCTAssertTrue(session.recordedPromptResponses.isEmpty)

        XCTAssertFalse(model.isRegistered("minimax-code"))
        XCTAssertEqual(model.authenticationErrors.count, 0, "user cancellation is not an authentication error")
        XCTAssertEqual(model.progress(for: "minimax-code")?.isActive, false)
        XCTAssertEqual(model.progress(for: "minimax-code")?.statusText, "취소됨")
        XCTAssertTrue(credentials.deleted.isEmpty)
        XCTAssertTrue(bridge.usageRequests.isEmpty)

        // A second cancel or a late prompt response must be inert.
        model.cancelLogin(providerId: "minimax-code")
        model.respondToPrompt(providerId: "minimax-code", value: "late")
        XCTAssertEqual(session.recordedPromptResponses.count, 0, "no response is delivered to a cancelled session")
    }

    // MARK: - Removal

    func testRemovalClearsCredentialAndProviderMetadata() async throws {
        let directory = temporaryStoreDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let metadata = try ProviderManagementStore(storageDirectory: directory)
        let credentials = AppTestCredentialStore()
        let bridge = AppTestBridge()
        bridge.stubLoginOutcome { request in
            .success(LoginSuccess(
                providerId: request.providerId,
                completedAtMs: 19,
                credential: .staticCredential(kind: .apiKey, secret: "bridge-minted-synthetic")
            ))
        }
        let model = makeModel(credentials: credentials, bridge: bridge, metadata: metadata)

        await model.register(
            providerId: "synthetic",
            method: .apiKey,
            inputs: LoginInputs(apiKey: "synthetic-key")
        )
        let accountRef = try XCTUnwrap(model.accountRef(for: "synthetic"))

        model.remove(providerId: "synthetic")

        XCTAssertNil(credentials.stored(for: accountRef))
        XCTAssertEqual(credentials.deleted, [accountRef])
        XCTAssertTrue(try metadata.accounts(forProvider: "synthetic").isEmpty)
        XCTAssertFalse(model.isRegistered("synthetic"))
        XCTAssertNil(model.card(for: "synthetic"))
    }

    func testRegisteredAccountRestoresWithoutPersistingSecret() async throws {
        let directory = temporaryStoreDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let credentials = AppTestCredentialStore()
        let bridge = AppTestBridge()
        bridge.stubLoginOutcome { request in
            .success(LoginSuccess(
                providerId: request.providerId,
                completedAtMs: 20,
                credential: .staticCredential(kind: .apiKey, secret: "never-write-this-secret")
            ))
        }
        let model = makeModel(
            credentials: credentials,
            bridge: bridge,
            metadata: try ProviderManagementStore(storageDirectory: directory)
        )
        await model.register(
            providerId: "minimax-code",
            method: .apiKey,
            inputs: LoginInputs(apiKey: "typed-but-not-persisted"),
            accountLabel: "Team"
        )
        let accountRef = try XCTUnwrap(model.accountRef(for: "minimax-code"))

        let restored = makeModel(
            credentials: credentials,
            bridge: bridge,
            metadata: try ProviderManagementStore(storageDirectory: directory)
        )

        XCTAssertEqual(restored.isRegistered("minimax-code"), true)
        XCTAssertEqual(restored.accountRef(for: "minimax-code"), accountRef)
        let files = try FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: nil
        )
        let persisted = try files.reduce(into: "") { result, file in
            result += String(decoding: try Data(contentsOf: file), as: UTF8.self)
        }
        XCTAssertFalse(persisted.contains("never-write-this-secret"))
    }

    func testStaleMetadataWithoutCredentialFileEntryIsRemovedInsteadOfRestored() throws {
        let directory = temporaryStoreDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let metadata = try ProviderManagementStore(storageDirectory: directory)
        try metadata.upsert(account: AccountRecord(
            providerId: "minimax-code",
            accountRef: "minimax-code:stale",
            displayName: "Stale",
            credentialRevision: 7
        ))

        let restored = makeModel(
            credentials: AppTestCredentialStore(),
            bridge: AppTestBridge(),
            metadata: metadata
        )

        XCTAssertFalse(restored.isRegistered("minimax-code"))
        XCTAssertNil(restored.card(for: "minimax-code"))
        XCTAssertTrue(try metadata.accounts(forProvider: "minimax-code").isEmpty)
    }

    func testCredentialFreeOllamaMetadataRestoresWithoutCredentialFileEntry() throws {
        let directory = temporaryStoreDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let metadata = try ProviderManagementStore(storageDirectory: directory)
        try metadata.upsert(account: AccountRecord(
            providerId: "ollama",
            accountRef: "ollama:local",
            displayName: "Local Ollama",
            credentialRevision: 0
        ))

        let restored = makeModel(
            credentials: AppTestCredentialStore(),
            bridge: AppTestBridge(),
            metadata: metadata
        )

        XCTAssertTrue(restored.isRegistered("ollama"))
        XCTAssertEqual(restored.accountRef(for: "ollama"), "ollama:local")
    }
}
