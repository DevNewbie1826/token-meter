import Foundation
import XCTest
import TokenMeterCore
@testable import TokenMeterApp

/// Registration actions are projected from the canonical manifest, so
/// registry updates surface automatically: Codex shows both browser and
/// device, and the Cursor/GitHub/Zai dual buttons both exist.
@MainActor
final class RegistrationActionsTests: XCTestCase {
    private var model: TokenMeterViewModel {
        TokenMeterViewModel(credentialStore: AppTestCredentialStore(), bridge: AppTestBridge())
    }

    func testAllSixteenProvidersExposeAtLeastOneRegistrationAction() {
        XCTAssertEqual(ProviderCatalog.locked.providers.count, 16)
        let model = self.model
        for provider in ProviderCatalog.locked.providers {
            let actions = model.registrationActions(for: provider.id)
            XCTAssertGreaterThanOrEqual(actions.count, 1, provider.id)
            XCTAssertEqual(
                actions.map(\.method.authMethod),
                provider.authMethods,
                "\(provider.id) actions mirror the manifest auth methods"
            )
            XCTAssertEqual(actions[0].accessibilityID, "provider-action-\(provider.id)", provider.id)
        }
    }

    func testCodexAutomaticallyShowsBrowserAndDeviceFromTheRegistry() {
        let codex = model.registrationActions(for: "openai-codex")
        XCTAssertEqual(codex.map(\.method.authMethod), [.browser, .device])
        XCTAssertEqual(codex.map(\.accessibilityID), [
            "provider-action-openai-codex",
            "provider-action-openai-codex-device",
        ])
    }

    func testDualMethodProvidersExposeBothActionsWithDistinctIdentifiers() {
        XCTAssertEqual(
            model.registrationActions(for: "cursor").map(\.method.authMethod),
            [.browser, .apiKey]
        )
        XCTAssertEqual(
            model.registrationActions(for: "github-copilot").map(\.method.authMethod),
            [.apiKey, .device]
        )
        XCTAssertEqual(
            model.registrationActions(for: "zai").map(\.method.authMethod),
            [.apiKey, .browser]
        )

        let ids = model.registrationActions(for: "cursor").map(\.accessibilityID)
        XCTAssertEqual(Set(ids).count, ids.count, "dual buttons have distinct accessibility ids")
    }

    func testActionTitlesFollowTheMethodFamily() {
        let actions = model.registrationActions(for: "github-copilot")
        XCTAssertEqual(actions.map(\.title), ["API 키로 등록", "기기 인증"])
    }
}
