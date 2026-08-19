import Foundation
import XCTest
import TokenMeterCore
@testable import TokenMeterApp

/// Automatic refresh lifecycle: a tick refreshes registered providers whose
/// capability allows automatic refresh, skips providers whose capability
/// does not, and a second start reuses the installed driver instead of
/// adding a second one.
///
/// Determinism: ticks are driven through `RefreshAutomation.fire()` so no
/// real timer fires; the fake bridge's fetch callback is the completion
/// signal, exactly like the restore-time automatic refresh coverage in
/// `UsageRefreshBehaviorTests`. No sleeps, no wall-clock assertions.
@MainActor
final class AutomaticRefreshTests: XCTestCase {
    private func makeModel(bridge: AppTestBridge) -> TokenMeterViewModel {
        TokenMeterViewModel(
            credentialStore: AppTestCredentialStore(),
            bridge: bridge,
            providerManagementStore: nil
        )
    }

    /// Bridge-minted credentials per provider, mirroring the registration
    /// stubs in `UsageRefreshBehaviorTests`.
    private func stubBridgeLogins(_ bridge: AppTestBridge) {
        bridge.stubLoginOutcome { request in
            if request.providerId == "anthropic" {
                return .success(LoginSuccess(
                    providerId: request.providerId,
                    completedAtMs: 31,
                    credential: .oauth(access: "bridge-minted-anthropic")
                ))
            }
            return .success(LoginSuccess(
                providerId: request.providerId,
                completedAtMs: 31,
                credential: .staticCredential(kind: .bearer, secret: "bridge-minted-\(request.providerId)")
            ))
        }
    }

    /// Registers the sole catalog provider that allows automatic refresh.
    /// `register` awaits its initial refresh, so the setup itself is
    /// deterministic.
    private func registerAutomaticCapableProvider(_ model: TokenMeterViewModel) async {
        await model.register(
            providerId: "github-copilot",
            method: .apiKey,
            inputs: LoginInputs(apiKey: "github-token")
        )
    }

    // MARK: - Tick refreshes capable providers

    func testTickRefreshesRegisteredProviderThatAllowsAutomaticRefresh() async throws {
        let bridge = AppTestBridge()
        stubBridgeLogins(bridge)
        let model = makeModel(bridge: bridge)
        await registerAutomaticCapableProvider(model)
        let requestsBeforeTick = bridge.usageRequests.count

        let tickFetch = expectation(description: "automatic tick usage fetch")
        bridge.onUsage = { tickFetch.fulfill() }
        model.startAutomaticRefresh()
        XCTAssertNotNil(model.refreshAutomation)
        XCTAssertEqual(model.refreshAutomation?.isRunning, true)
        try XCTUnwrap(model.refreshAutomation).fire()
        await fulfillment(of: [tickFetch], timeout: 2)

        let tickRequests = bridge.usageRequests.dropFirst(requestsBeforeTick)
        XCTAssertEqual(
            tickRequests.map(\.providerId),
            ["github-copilot"],
            "one tick produces exactly one fetch for the automatic-refresh-capable provider"
        )

        model.stopAutomaticRefresh()
        XCTAssertEqual(model.refreshAutomation?.isRunning, false)
    }

    // MARK: - Tick skips providers without the capability

    func testTickSkipsRegisteredProviderWithoutAutomaticRefreshCapability() async throws {
        let bridge = AppTestBridge()
        stubBridgeLogins(bridge)
        let model = makeModel(bridge: bridge)
        await model.register(providerId: "anthropic", method: .browser)
        await registerAutomaticCapableProvider(model)
        let requestsBeforeTick = bridge.usageRequests.count

        // The capable provider's tick fetch is the deterministic signal
        // that the whole tick ran; every task the tick spawns was already
        // spawned synchronously inside fire().
        let tickFetch = expectation(description: "automatic tick usage fetch")
        bridge.onUsage = { tickFetch.fulfill() }
        model.startAutomaticRefresh()
        try XCTUnwrap(model.refreshAutomation).fire()
        await fulfillment(of: [tickFetch], timeout: 2)

        let tickRequests = bridge.usageRequests.dropFirst(requestsBeforeTick)
        XCTAssertEqual(tickRequests.count, 1, "only the automatic-refresh-capable provider is fetched on a tick")
        XCTAssertEqual(tickRequests.first?.providerId, "github-copilot")
        XCTAssertEqual(
            model.isRegistered("anthropic"),
            true,
            "the incapable provider stays registered; it is merely not auto-refreshed"
        )
    }

    // MARK: - Start idempotency

    func testSecondStartDoesNotDoubleTick() async throws {
        let bridge = AppTestBridge()
        stubBridgeLogins(bridge)
        let model = makeModel(bridge: bridge)
        await registerAutomaticCapableProvider(model)
        let requestsBeforeTick = bridge.usageRequests.count

        model.startAutomaticRefresh()
        let firstDriver = try XCTUnwrap(model.refreshAutomation)
        model.startAutomaticRefresh()
        XCTAssertTrue(
            firstDriver === model.refreshAutomation,
            "a second start reuses the installed driver instead of adding one"
        )

        let tickFetch = expectation(description: "automatic tick usage fetch")
        bridge.onUsage = { tickFetch.fulfill() }
        firstDriver.fire()
        await fulfillment(of: [tickFetch], timeout: 2)

        XCTAssertEqual(
            bridge.usageRequests.count - requestsBeforeTick,
            1,
            "one tick produces exactly one fetch even after two starts"
        )
    }
}
