#if TOKEN_METER_QA
import Foundation
import XCTest
import TokenMeterCore
@testable import TokenMeterApp

/// Explicit QA build: real subprocess login/usage, raw adapter fixture, real
/// auth.json and metadata stores. The production default build has no QA seam.
@MainActor
final class NekosQAIntegrationTests: XCTestCase {
    func testTransportRemainsDisabledWhenStoreIsolationIsAbsent() {
        // Given
        let environment = ["TOKEN_METER_QA_NEKOS_BRIDGE": "/fixture/bridge"]
        // When
        let bridge = NekosQAHost.bridge(environment: environment)
        // Then
        XCTAssertNil(bridge)
    }

    func testRegistrationProjectsFiveRowsWhenRealFixtureTransportAuthenticates() async throws {
        // Given
        let model = try makeModel()
        // When
        await model.register(providerId: "nekos", method: .apiKey, inputs: LoginInputs(apiKey: UUID().uuidString))
        // Then
        XCTAssertTrue(model.isRegistered("nekos"))
        let card = try XCTUnwrap(model.card(for: "nekos"))
        XCTAssertNil(card.error)
        XCTAssertEqual(card.rows.map(\.fraction), [0, 0, 18.39 / 100, 0, 33.55 / 100])
        XCTAssertEqual(Set(card.rows.map(\.limitId)).count, 5)
    }

    func testRegistrationRejectsBlankKeyWhenRealLoginDecoderReceivesFailure() async throws {
        // Given
        let model = try makeModel()
        // When
        await model.register(providerId: "nekos", method: .apiKey, inputs: LoginInputs(apiKey: ""))
        // Then
        XCTAssertFalse(model.isRegistered("nekos"))
        XCTAssertEqual(model.authenticationErrors["nekos"]?.wireCode, "invalidRequest")
    }

    private func makeModel() throws -> TokenMeterViewModel {
        let repository = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("TokenMeter-Nekos-QA-Test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try FileManager.default.removeItem(at: directory) }
        let executable = directory.appendingPathComponent("nekos-qa-bridge")
        let compiler = Process()
        compiler.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        compiler.currentDirectoryURL = repository
        compiler.arguments = ["bun", "build", "--compile", "scripts/qa/nekos-adapter.ts", "--outfile", executable.path]
        compiler.standardOutput = FileHandle.standardError
        compiler.standardError = FileHandle.standardError
        try compiler.run()
        compiler.waitUntilExit()
        XCTAssertEqual(compiler.terminationStatus, 0)
        let bridge = try XCTUnwrap(NekosQAHost.bridge(environment: [
            "TOKEN_METER_QA_FIXTURE": "1", "TOKEN_METER_QA_NEKOS_BRIDGE": executable.path,
        ]))
        let credentials = AuthFileCredentialStore(fileURL: directory.appendingPathComponent("auth.json"))
        return TokenMeterViewModel(credentialStore: credentials, bridge: bridge,
            providerManagementStore: try ProviderManagementStore(storageDirectory: directory.appendingPathComponent("accounts")))
    }
}
#endif
