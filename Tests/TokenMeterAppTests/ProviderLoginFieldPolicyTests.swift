import Foundation
import XCTest
import TokenMeterCore
@testable import TokenMeterApp

/// The provider-specific extra input fields are one small typed policy.
/// Auth METHODS themselves still come from the canonical manifest; the
/// policy only shapes which structured inputs the sheet collects.
final class ProviderLoginFieldPolicyTests: XCTestCase {
    private func provider(_ id: String) throws -> ProviderCapability {
        try XCTUnwrap(ProviderCatalog.locked.providers.first { $0.id == id }, id)
    }

    // MARK: Alibaba

    func testAlibabaAPIKeyCollectsKeyCookieAndOptionalBaseURL() throws {
        let alibaba = try provider("alibaba-token-plan")
        let fields = ProviderLoginFieldPolicy.fields(for: alibaba, method: .apiKey)

        XCTAssertEqual(fields.map(\.kind), [.apiKey, .cookieHeader, .apiBaseUrl])

        let apiKeyField = try XCTUnwrap(fields.first { $0.kind == .apiKey })
        XCTAssertTrue(apiKeyField.isSecure)
        XCTAssertFalse(apiKeyField.isMultiline)
        XCTAssertFalse(apiKeyField.isOptional)

        let cookieField = try XCTUnwrap(fields.first { $0.kind == .cookieHeader })
        XCTAssertTrue(cookieField.isSecure, "cookie header must render as secure input")
        XCTAssertTrue(cookieField.isMultiline, "cookie header must accept multiline paste")
        XCTAssertTrue(cookieField.isOptional)

        let baseURLField = try XCTUnwrap(fields.first { $0.kind == .apiBaseUrl })
        XCTAssertFalse(baseURLField.isSecure)
        XCTAssertFalse(baseURLField.isMultiline)
        XCTAssertTrue(baseURLField.isOptional)
    }

    func testAlibabaDeclaresNoOtherMethodFields() throws {
        let alibaba = try provider("alibaba-token-plan")
        XCTAssertTrue(alibaba.authMethods == [.apiKey])
        XCTAssertTrue(ProviderLoginFieldPolicy.fields(for: alibaba, method: .browser).isEmpty)
    }

    // MARK: GitHub enterprise host

    func testGitHubDeviceCollectsOptionalEnterpriseHostAndAPIKeyDoesNot() throws {
        let github = try provider("github-copilot")

        let deviceFields = ProviderLoginFieldPolicy.fields(for: github, method: .device)
        XCTAssertEqual(deviceFields.map(\.kind), [.enterpriseHost])
        XCTAssertTrue(deviceFields[0].isOptional)
        XCTAssertFalse(deviceFields[0].isSecure)

        let apiKeyFields = ProviderLoginFieldPolicy.fields(for: github, method: .apiKey)
        XCTAssertEqual(apiKeyFields.map(\.kind), [.apiKey])
    }

    // MARK: Ollama blank key

    func testOllamaAPIKeyFieldIsOptionalWhileOtherKeyProvidersRequireIt() throws {
        let ollama = try provider("ollama")
        let ollamaFields = ProviderLoginFieldPolicy.fields(for: ollama, method: .apiKey)
        XCTAssertEqual(ollamaFields.map(\.kind), [.apiKey])
        XCTAssertTrue(ollamaFields[0].isOptional, "Ollama allows a blank key for local no-auth")

        let minimax = try provider("minimax-code")
        let minimaxFields = ProviderLoginFieldPolicy.fields(for: minimax, method: .apiKey)
        XCTAssertEqual(minimaxFields.map(\.kind), [.apiKey])
        XCTAssertFalse(minimaxFields[0].isOptional)
    }

    // MARK: OAuth-only providers collect nothing upfront

    func testBrowserAndDeviceOnlyProvidersCollectNoUpfrontFields() throws {
        for id in ["anthropic", "google-antigravity", "google-gemini-cli"] {
            let capability = try provider(id)
            XCTAssertTrue(
                ProviderLoginFieldPolicy.fields(for: capability, method: .browser).isEmpty,
                id
            )
        }
        let kimi = try provider("kimi-code")
        XCTAssertTrue(ProviderLoginFieldPolicy.fields(for: kimi, method: .device).isEmpty)
        let codex = try provider("openai-codex")
        XCTAssertTrue(ProviderLoginFieldPolicy.fields(for: codex, method: .browser).isEmpty)
        XCTAssertTrue(ProviderLoginFieldPolicy.fields(for: codex, method: .device).isEmpty)
    }

    // MARK: LoginInputs mapping

    func testLoginInputsMapsFieldValuesIntoWireInputs() {
        let inputs = ProviderLoginFieldPolicy.loginInputs(from: [
            .apiKey: "  sk-live-input  ",
            .cookieHeader: "\nCookie: login_aliyunid_csrf=abc; x=1\n",
            .apiBaseUrl: " https://token-plan.example/compatible-mode/v1/ ",
            .enterpriseHost: "",
        ])

        XCTAssertTrue(inputs.apiKey == "sk-live-input", "apiKey trimmed")
        XCTAssertTrue(inputs.cookieHeader == "Cookie: login_aliyunid_csrf=abc; x=1", "cookie trimmed but content preserved")
        XCTAssertTrue(inputs.apiBaseUrl == "https://token-plan.example/compatible-mode/v1/", "base URL is whitespace-trimmed; the bridge owns URL normalization")
        XCTAssertNil(inputs.enterpriseHost, "blank enterprise host maps to nil")
    }

    func testLoginInputsOmitBlankValuesBecauseTheWireRequiresNonEmptyStrings() {
        let inputs = ProviderLoginFieldPolicy.loginInputs(from: [
            .apiKey: "  ",
            .cookieHeader: "",
            .apiBaseUrl: "   ",
            .enterpriseHost: "",
        ])
        XCTAssertNil(inputs.apiKey, "blank key is omitted; the helper answers local no-auth or prompts")
        XCTAssertNil(inputs.cookieHeader, "blank cookie is omitted; an empty duplex response is the explicit skip")
        XCTAssertNil(inputs.apiBaseUrl)
        XCTAssertNil(inputs.enterpriseHost)
    }

    func testLoginInputsFromEmptyValuesOmitsEverything() {
        let inputs = ProviderLoginFieldPolicy.loginInputs(from: [:])
        XCTAssertNil(inputs.apiKey)
        XCTAssertNil(inputs.apiBaseUrl)
        XCTAssertNil(inputs.cookieHeader)
        XCTAssertNil(inputs.enterpriseHost)
    }
}
