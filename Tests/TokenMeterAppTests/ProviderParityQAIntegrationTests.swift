#if TOKEN_METER_QA
import Foundation
import XCTest
import TokenMeterCore
@testable import TokenMeterApp

@MainActor
final class ProviderParityQAIntegrationTests: XCTestCase {
    func testAllOfflineProvidersRegisterThroughCompiledBridgeAndDurableStores() async throws {
        let repository = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("TokenMeter-Parity-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try FileManager.default.removeItem(at: directory) }
        let binary = directory.appendingPathComponent("qa-bridge")
        let compiler = Process()
        compiler.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        compiler.currentDirectoryURL = repository
        compiler.arguments = ["bun", "build", "--compile", "bridge/qa/provider-parity.ts", "--outfile", binary.path]
        compiler.standardOutput = FileHandle.standardError
        compiler.standardError = FileHandle.standardError
        try compiler.run()
        compiler.waitUntilExit()
        XCTAssertEqual(compiler.terminationStatus, 0)

        let cases: [(String, String, AuthMethod, [Double?])] = [
            ("xai-80", "xai-oauth", .device, [0.8, 0.8, 0.8, 0.8]),
            ("xai-87.5", "xai-oauth", .device, [0.875, 0.875, 0.875, 0.875]),
            ("xai-89.9", "xai-oauth", .device, Array(repeating: 89.9 / 100, count: 4)),
            ("xai-95", "xai-oauth", .device, [0.95, 0.95, 0.95, 0.95]),
            ("xai-99.9", "xai-oauth", .device, Array(repeating: 99.9 / 100, count: 4)),
            ("xai-overage", "xai-oauth", .device, [1.2, 1.2]),
            ("zai-mixed", "zai", .apiKey, [0.8, 0.7999, 0.9499, 0.9999]),
            ("ag-remaining", "google-antigravity", .browser, [nil, nil]),
            ("ag-weekly", "google-antigravity", .browser, [0.99, 1 - 0.9]),
            ("cursor-used", "cursor", .apiKey, [nil]),
            ("opencode-12", "opencode-go", .apiKey, [0.12, 0.2, 0.3]),
            ("nekos", "nekos", .apiKey, [0, 0, 18.39 / 100, 0, 33.55 / 100]),
        ]
        for (scenario, provider, method, fractions) in cases {
            let profile = directory.appendingPathComponent(scenario)
            try FileManager.default.createDirectory(at: profile, withIntermediateDirectories: true)
            let executable = profile.appendingPathComponent("launch")
            // Only QA selector and temporary metadata directory use env. All
            // request fields/credentials still go through BridgeClient stdin.
            try "#!/bin/sh\nexport TOKEN_METER_QA_SCENARIO='\(scenario)'\nexport TMPDIR='\(profile.path)'\nexec '\(binary.path)' \"$@\"\n"
                .write(to: executable, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
            let authURL: URL
            let credentials: CredentialStoreProtocol
            if scenario == "nekos" {
                let qaDirectory = FileManager.default.temporaryDirectory
                    .appendingPathComponent("TokenMeter-QA-\(ProcessInfo.processInfo.processIdentifier)-credentials")
                authURL = qaDirectory.appendingPathComponent("auth.json")
                credentials = try XCTUnwrap(TokenMeterApp.qaCredentialStore())
                addTeardownBlock { try FileManager.default.removeItem(at: qaDirectory) }
            } else {
                authURL = profile.appendingPathComponent("auth.json")
                credentials = AuthFileCredentialStore(fileURL: authURL)
            }
            let accounts = try ProviderManagementStore(storageDirectory: profile.appendingPathComponent("accounts"))
            let model = TokenMeterViewModel(credentialStore: credentials,
                bridge: BridgeClient(executableURL: executable), providerManagementStore: accounts, openURL: { _ in })
            XCTAssertTrue(model.registeredProviderIDs.isEmpty)
            XCTAssertTrue(model.cards.isEmpty)
            XCTAssertFalse(FileManager.default.fileExists(atPath: authURL.path))

            await model.register(providerId: provider, method: method, inputs: LoginInputs(apiKey: UUID().uuidString))
            XCTAssertTrue(model.isRegistered(provider), scenario)
            let card = try XCTUnwrap(model.card(for: provider), scenario)
            XCTAssertNil(card.error, scenario)
            XCTAssertEqual(card.rows.map(\.fraction), fractions, scenario)
            let accountRef = try XCTUnwrap(model.accountRef(for: provider))
            XCTAssertNotNil(try credentials.load(for: accountRef), scenario)
            if scenario == "nekos" {
                // A later/lazy menu model must not erase the hosted model's
                // credential. Both getters refer to this process's QA store.
                let reopened = try XCTUnwrap(TokenMeterApp.qaCredentialStore())
                XCTAssertNotNil(try reopened.load(for: accountRef))
            }
            XCTAssertEqual(try accounts.accounts(forProvider: provider).count, 1)
            if scenario == "ag-remaining" {
                XCTAssertEqual(card.rows.map(\.unit), [.unknown, .unknown])
                XCTAssertEqual(card.rows.map(\.remaining), [42.5, 0])
                XCTAssertTrue(card.rows.allSatisfy { $0.severity == .unknown && !$0.showsProgressBar })
            }
            if scenario == "zai-mixed" {
                // Wire bands remain 0.8/0.95/1; actual non-percent display rows
                // intentionally warn from 0.5 under the existing Core policy.
                XCTAssertEqual(card.rows.map(\.severity), [.warning, .warning, .warning, .critical])
            }
            if scenario == "cursor-used" {
                XCTAssertEqual(card.rows.first?.used, 42.5)
                XCTAssertFalse(try XCTUnwrap(card.rows.first).showsProgressBar)
            }
            if scenario == "xai-overage" {
                XCTAssertEqual(card.rows.map(\.used), [120, 120])
                XCTAssertEqual(card.rows.map(\.limit), [100, 100])
            }
            if scenario == "ag-weekly" { XCTAssertNil(card.rows.first?.resetsInMs) }
            // No credential override: second subprocess must load auth.json.
            await model.refresh(providerId: provider)
            XCTAssertNil(model.card(for: provider)?.error, scenario)
            XCTAssertEqual(model.card(for: provider)?.rows.map(\.fraction), fractions, scenario)
            model.remove(providerId: provider)
            XCTAssertNil(try credentials.load(for: accountRef))
            XCTAssertTrue(try accounts.accounts(forProvider: provider).isEmpty)
            XCTAssertTrue(model.cards.isEmpty)
        }
    }
}
#endif
