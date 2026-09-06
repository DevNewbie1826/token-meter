import Foundation
import XCTest
import TokenMeterCore
@testable import TokenMeterApp

@MainActor
final class TokenMeterViewModelTests: XCTestCase {
    /// Every provider, every declared auth method: the registration runs a
    /// real bridge login session and completes with a real usage refresh.
    /// Dual-method providers (Cursor, GitHub, Codex, Z.ai) register through
    /// both arms.
    func testEveryProviderEveryMethodCompletesBridgeLoginAndUsageRefresh() async {
        for provider in ProviderCatalog.locked.providers {
            for method in provider.authMethods {
                let credentials = AppTestCredentialStore()
                let bridge = AppTestBridge()
                bridge.initialLoginEvents = { _ in
                    method == .device
                        ? [.code(code: "WXYZ-1234", verificationUrl: "https://verify.example")]
                        : [.openUrl(url: "https://login.example")]
                }
                bridge.stubLoginOutcome { request in
                    if request.providerId == "ollama" && (request.inputs?.apiKey ?? "") == "" {
                        return .success(LoginSuccess(
                            providerId: request.providerId,
                            completedAtMs: 30,
                            credential: .none,
                            accountLabel: "Local (no key)"
                        ))
                    }
                    let capability = ProviderCatalog.locked.providers
                        .first { $0.id == request.providerId }!
                    return .success(LoginSuccess(
                        providerId: request.providerId,
                        completedAtMs: 30,
                        credential: mintedCredential(for: capability, method: request.method)
                    ))
                }
                let model = TokenMeterViewModel(
                    credentialStore: credentials,
                    bridge: bridge,
                    openURL: { _ in }
                )

                let blankAllowed = provider.registrationCapability.allowsBlankAPIKey
                let inputs = method == .apiKey
                    ? LoginInputs(apiKey: blankAllowed ? nil : "typed-\(provider.id)")
                    : LoginInputs()

                await model.register(providerId: provider.id, method: method, inputs: inputs)

                XCTAssertTrue(model.isRegistered(provider.id), "\(provider.id)/\(method.rawValue)")
                XCTAssertEqual(bridge.loginRequests.map(\.method), [method], provider.id)
                XCTAssertEqual(bridge.usageRequests.count, 1, provider.id)
                XCTAssertTrue(bridge.usageRequests.allSatisfy { $0.providerId == $0.connectorId })

                if let accountRef = model.accountRef(for: provider.id),
                   let stored = credentials.stored(for: accountRef) {
                    XCTAssertTrue(
                        stored.credential == mintedCredential(for: provider, method: method),
                        "\(provider.id)/\(method.rawValue): stored credential is the bridge-minted one"
                    )
                }
            }
        }
    }

    /// The QA-hosted window and its capture/bring-front machine paths stay
    /// available; the fake fixture data itself is gone.
    func testQAHostedWindowMachinePathsRemainAvailable() throws {
        let repository = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let appSource = try String(contentsOf: repository
            .appendingPathComponent("Sources/TokenMeterApp/TokenMeterApp.swift"))
        for sentinel in [
            "TOKEN_METER_QA_FIXTURE",
            "TOKEN_METER_QA_OPEN_SETTINGS",
            "dev.herdr.token-meter.qa.bring-front",
            "dev.herdr.token-meter.qa.front-ready",
            "dev.herdr.token-meter.qa.capture-window",
            "dev.herdr.token-meter.qa.capture-done",
            "TOKEN_METER_QA_READY",
        ] {
            XCTAssertTrue(appSource.contains(sentinel), sentinel)
        }
        XCTAssertFalse(
            appSource.contains("fixtureCards"),
            "fake fixture usage is removed from the view model"
        )
    }

    func testEveryCatalogProviderExposesManifestDerivedRegistrationMethods() {
        XCTAssertEqual(ProviderCatalog.locked.providers.count, 17)
        for provider in ProviderCatalog.locked.providers {
            XCTAssertFalse(provider.registrationMethods.isEmpty, provider.id)
            XCTAssertEqual(
                provider.registrationMethods.map(\.authMethod),
                provider.authMethods,
                provider.id
            )
        }
    }
}
