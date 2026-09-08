import Foundation
import XCTest
@testable import TokenMeterCore

final class BridgeClientIntegrationTests: XCTestCase {
    func testTransportDiagnosticsRedactRequestCredential() async throws {
        let directory = makeTempDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let helper = directory.appendingPathComponent("usage-helper")
        try """
            #!/bin/sh
            cat > /dev/null
            printf '%s' 'helper echoed usage-unit-secret' >&2
            exit 3
            """.write(to: helper, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes(
            [.posixPermissions: NSNumber(value: Int16(0o755))],
            ofItemAtPath: helper.path
        )
        let client = BridgeClient(
            executableURL: helper,
            clock: ManualClock(nowMs: testNowMs)
        )
        let request = UsageRequest(
            requestId: testRequestId,
            operation: .fetchUsage,
            providerId: "synthetic",
            connectorId: "synthetic",
            accountRef: testAccountRef,
            requestedAtMs: testNowMs,
            deadlineAtMs: testNowMs + 10_000,
            credential: .staticCredential(
                kind: .apiKey,
                secret: "usage-unit-secret"
            )
        )

        let response = await client.fetchUsage(request)
        XCTAssertEqual(
            response,
            .failure(.transport("bridge helper produced no output: helper echoed [redacted]"))
        )
    }

    func testCompiledBridgeFixtureDecodesThroughSwiftClient() async throws {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let executable = root.appendingPathComponent(
            "bridge/build/token-meter-bridge"
        )
        let fixture = root.appendingPathComponent("bridge/fixtures/quota.json")
        XCTAssertTrue(
            FileManager.default.isExecutableFile(atPath: executable.path),
            "build the compiled bridge before running Swift integration tests"
        )

        let clock = ManualClock(nowMs: testNowMs)
        let client = BridgeClient(
            executableURL: executable,
            arguments: [
                "usage",
                "--stdin",
                "--fixture",
                fixture.path,
            ],
            clock: clock
        )
        let request = UsageRequest(
            requestId: testRequestId,
            operation: .fetchUsage,
            providerId: "fixture",
            connectorId: "fixture",
            accountRef: testAccountRef,
            requestedAtMs: testNowMs,
            deadlineAtMs: testNowMs + 30_000,
            credential: .staticCredential(kind: .bearer, secret: "demo")
        )

        guard case let .report(report) = await client.fetchUsage(request) else {
            return XCTFail("expected compiled bridge report")
        }
        XCTAssertEqual(report.providerId, "fixture")
        XCTAssertEqual(report.connectorId, "fixture")
        XCTAssertEqual(report.limits.count, 7)
        XCTAssertEqual(report.limits.first?.limitId, "premium-requests-5h")
        XCTAssertEqual(report.limits.last?.unit, .unknown)
    }
}


extension BridgeClientIntegrationTests {
    func testMalformedReportRotationPersistsThroughProcessAndStore() async throws {
        let directory = makeTempDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let original = BridgeCredential.oauth(access: "synthetic-old-access", refresh: "synthetic-old-refresh")
        let rotation = BridgeCredential.oauth(access: "synthetic-new-access", refresh: "synthetic-new-refresh")
        let file = directory.appendingPathComponent("auth.json")
        let store = AuthFileCredentialStore(fileURL: file)
        XCTAssertEqual(try store.save(credential: original, for: testAccountRef), 1)
        let payload = try rawUsageResponseData(windows: [[
            "id": "a", "unit": "synthetic-old-access synthetic-new-access synthetic-new-refresh",
            "used": 1, "severity": "unknown",
        ]], rotation: rotation)
        let responseFile = directory.appendingPathComponent("response.json")
        try payload.write(to: responseFile)
        let helper = directory.appendingPathComponent("usage-helper")
        try """
            #!/bin/sh
            test "$1" = usage && test "$2" = --stdin || exit 2
            cat > /dev/null
            cat '\(responseFile.path)'
            """.write(to: helper, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: helper.path)
        let request = UsageRequest(
            requestId: testRequestId, operation: .fetchUsage, providerId: "fixture", connectorId: "fixture",
            accountRef: testAccountRef, requestedAtMs: testNowMs, deadlineAtMs: testNowMs + 10_000,
            credential: original
        )
        let response = await BridgeClient(executableURL: helper, clock: ManualClock(nowMs: testNowMs)).fetchUsage(request)
        guard case .failure(let error) = response else { return XCTFail("malformed report accepted") }
        XCTAssertEqual(error.wireCode, "malformedPayload")
        XCTAssertTrue(error.refreshedCredential == rotation, "validated rotation was lost")
        XCTAssertTrue(error.wireMessage?.contains("[redacted]") == true)
        for secret in original.redactionSecrets + rotation.redactionSecrets {
            XCTAssertFalse(error.wireMessage?.contains(secret) == true, "diagnostic leaked a known secret")
        }
        guard let refreshed = error.refreshedCredential else { return }
        XCTAssertEqual(try store.save(credential: refreshed, for: testAccountRef), 2)
        let reloaded = try AuthFileCredentialStore(fileURL: file).load(for: testAccountRef)
        XCTAssertTrue(reloaded?.credential == rotation, "persisted rotation did not survive a new store instance")
        XCTAssertEqual(reloaded?.revision, 2)
        let permissions = try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? NSNumber
        XCTAssertEqual(permissions?.intValue, 0o600)
    }
}


extension BridgeClientIntegrationTests {
    func testMismatchedEnvelopeIdentitiesNeverReturnRotationThroughProcess() async throws {
        let directory = makeTempDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let rotation = BridgeCredential.oauth(access: "synthetic-rotation")
        let responseFile = directory.appendingPathComponent("response.json")
        let helper = directory.appendingPathComponent("usage-helper")
        try """
            #!/bin/sh
            cat > /dev/null
            cat '\(responseFile.path)'
            """.write(to: helper, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: helper.path)
        let client = BridgeClient(executableURL: helper, clock: ManualClock(nowMs: testNowMs))
        let request = UsageRequest(
            requestId: testRequestId, operation: .fetchUsage, providerId: "fixture", connectorId: "fixture",
            accountRef: testAccountRef, requestedAtMs: testNowMs, deadlineAtMs: testNowMs + 10_000,
            credential: BridgeCredential.none
        )
        for key in ["providerId", "connectorId", "accountRef"] {
            // A valid report must also reject the mismatch before returning a rotation.
            let data = try rawUsageResponseData(windows: [[
                "id": "a", "unit": "requests", "used": 1, "severity": "unknown",
            ]], overrides: [key: "different"], rotation: rotation)
            try data.write(to: responseFile)
            let response = await client.fetchUsage(request)
            XCTAssertTrue(response.refreshedCredential == nil, "mismatched identity authorized rotation")
            guard case .failure(let error) = response else { XCTFail("mismatched identity accepted"); continue }
            XCTAssertEqual(error.wireCode, "invalidProtocol")
        }
    }
}


extension BridgeClientIntegrationTests {
    func testCompiledBridgeRemainingCreditsFixturePreservesRawAmounts() async throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let executable = root.appendingPathComponent("bridge/build/token-meter-bridge")
        let fixture = root.appendingPathComponent("bridge/fixtures/remaining-credits.json")
        XCTAssertTrue(FileManager.default.isExecutableFile(atPath: executable.path))
        let client = BridgeClient(
            executableURL: executable,
            arguments: ["usage", "--stdin", "--fixture", fixture.path],
            clock: ManualClock(nowMs: testNowMs)
        )
        let request = UsageRequest(
            requestId: testRequestId, operation: .fetchUsage, providerId: "fixture", connectorId: "fixture",
            accountRef: testAccountRef, requestedAtMs: testNowMs, deadlineAtMs: testNowMs + 30_000,
            credential: BridgeCredential.none
        )
        guard case .report(let report) = await client.fetchUsage(request) else {
            return XCTFail("expected compiled credits/remaining report")
        }
        XCTAssertEqual(report.schemaVersion, "1.3.0")
        XCTAssertEqual(report.limits.map(\.unit), [.credits, .credits, .credits])
        XCTAssertEqual(report.limits.map(\.utilization.remaining), [250, 125, 0])
        XCTAssertEqual(report.limits.map(\.utilization.remainingFraction), [nil, 0.125, 0])
        XCTAssertEqual(report.limits.map(\.utilization.fraction), [nil, 0.875, 1])
        XCTAssertEqual(report.limits.map(\.utilization.used), [nil, nil, nil])
        XCTAssertEqual(report.limits.map(\.utilization.limit), [nil, 1000, nil])
        XCTAssertEqual(QuotaProjector().rows(for: report, nowMs: testNowMs).map(\.severity),
                       [.unknown, .warning, .exhausted])
    }
}

extension BridgeClientIntegrationTests {
    func testDecoderBoundarySubprocessRejectionsPreserveStorageAndMatchedControlRotates() async throws {
        let directory = makeTempDirectory()
        defer {
            do { try FileManager.default.removeItem(at: directory) }
            catch { XCTFail("failed to clean decoder boundary process fixtures") }
        }
        let original = BridgeCredential.oauth(access: UUID().uuidString, refresh: UUID().uuidString)
        let rotation = BridgeCredential.oauth(access: UUID().uuidString, refresh: UUID().uuidString)
        let responseFile = directory.appendingPathComponent("response.json")
        let inputFile = directory.appendingPathComponent("stdin.json")
        let helper = directory.appendingPathComponent("usage-helper")
        try """
            #!/bin/sh
            test "$#" = 2 && test "$1" = usage && test "$2" = --stdin || exit 2
            cat > '\(inputFile.path)' || exit 3
            cat '\(responseFile.path)'
            """.write(to: helper, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: helper.path)
        let client = BridgeClient(executableURL: helper, clock: ManualClock(nowMs: testNowMs))
        let request = UsageRequest(
            requestId: testRequestId, operation: .fetchUsage, providerId: "fixture", connectorId: "fixture",
            accountRef: testAccountRef, requestedAtMs: testNowMs, deadlineAtMs: testNowMs + 10_000,
            credential: original
        )
        var cases = try decoderBoundaryRejections(rotation: rotation)
        cases.append(("matched-control", try usageErrorData(
            code: "upstreamError",
            message: (original.redactionSecrets + rotation.redactionSecrets).joined(separator: " "),
            refreshedCredential: rotation
        ), "upstreamError"))
        for (index, scenario) in cases.enumerated() {
            let (name, data, code) = scenario
            let matched = name == "matched-control"
            let file = directory.appendingPathComponent("auth-\(index).json")
            let store = AuthFileCredentialStore(fileURL: file)
            XCTAssertEqual(try store.save(credential: original, for: testAccountRef), 1)
            let before = try Data(contentsOf: file)
            try data.write(to: responseFile)

            // Actual stdin -> child stdout -> strict decoder; return awaits child exit/EOF.
            let response = await client.fetchUsage(request)
            assertBoundaryFailure({ response }, code: code,
                                  secrets: original.redactionSecrets + rotation.redactionSecrets,
                                  rotation: matched ? rotation : nil, scenario: name)
            let sent = try jsonObject(from: Data(contentsOf: inputFile))
            XCTAssertEqual(sent["requestId"] as? String, testRequestId)
            let sentCredential = try JSONDecoder().decode(
                BridgeCredential.self, from: JSONSerialization.data(withJSONObject: XCTUnwrap(sent["credential"]))
            )
            XCTAssertTrue(sentCredential == original, "stdin credential transport")

            // Mirror the app's persist-before-error consumer using real durable storage.
            if let refreshed = response.refreshedCredential {
                _ = try store.save(credential: refreshed, for: testAccountRef)
            }
            let reloaded = try AuthFileCredentialStore(fileURL: file).load(for: testAccountRef)
            XCTAssertEqual(reloaded?.revision, matched ? 2 : 1, name)
            XCTAssertTrue(reloaded?.credential == (matched ? rotation : original), "stored credential: \(name)")
            if !matched {
                XCTAssertTrue(try Data(contentsOf: file) == before, "rejected envelope changed storage: \(name)")
            }
            let permissions = try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? NSNumber
            XCTAssertEqual(permissions?.intValue, 0o600)
        }
    }

    func testTypedErrorPayloadSubprocessRejectionsPreserveStorageAndValidControlsRotate() async throws {
        let directory = makeTempDirectory()
        defer {
            do {
                try FileManager.default.removeItem(at: directory)
                print("typed-error-process cleanup=removed")
            }
            catch { XCTFail("failed to clean typed-error process fixtures") }
        }
        let original = BridgeCredential.oauth(access: UUID().uuidString, refresh: UUID().uuidString)
        let rotation = BridgeCredential.oauth(access: UUID().uuidString, refresh: UUID().uuidString)
        let secrets = original.redactionSecrets + rotation.redactionSecrets
        let responseFile = directory.appendingPathComponent("response.json")
        let inputFile = directory.appendingPathComponent("stdin.json")
        let helper = directory.appendingPathComponent("usage-helper")
        try """
            #!/bin/sh
            test "$#" = 2 && test "$1" = usage && test "$2" = --stdin || exit 2
            cat > '\(inputFile.path)' || exit 3
            cat '\(responseFile.path)' || exit 4
            exit 1
            """.write(to: helper, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: helper.path)
        let client = BridgeClient(executableURL: helper, clock: ManualClock(nowMs: testNowMs))
        let request = UsageRequest(
            requestId: testRequestId, operation: .fetchUsage, providerId: "fixture", connectorId: "fixture",
            accountRef: testAccountRef, requestedAtMs: testNowMs, deadlineAtMs: testNowMs + 10_000,
            credential: original
        )
        var cases = try invalidTypedErrorPayloads(message: secrets.joined(separator: " ")).map {
            (name: $0.name, payload: $0.payload, code: $0.code, valid: false, retry: nil as Int?)
        }
        cases += validTypedErrorPayloads().map { ($0.name, $0.payload, $0.code, true, $0.retry) }
        for (index, scenario) in cases.enumerated() {
            let file = directory.appendingPathComponent("auth-\(index).json")
            let store = AuthFileCredentialStore(fileURL: file)
            XCTAssertEqual(try store.save(credential: original, for: testAccountRef), 1)
            let before = try Data(contentsOf: file)
            try rawTypedErrorResponseData(scenario.payload, rotation: rotation).write(to: responseFile)

            // Real process exit + pipe EOF, not a delay or mocked decoder/store.
            let response = await client.fetchUsage(request)
            assertBoundaryFailure({ response }, code: scenario.code, secrets: secrets,
                                  rotation: scenario.valid ? rotation : nil, scenario: scenario.name)
            if scenario.valid, scenario.code == "rateLimited", case .failure(let error) = response {
                XCTAssertEqual(error.underlyingError, .rateLimited(retryAfterMs: scenario.retry), scenario.name)
            }
            let sent = try jsonObject(from: Data(contentsOf: inputFile))
            XCTAssertEqual(sent["requestId"] as? String, testRequestId)
            let sentCredential = try JSONDecoder().decode(
                BridgeCredential.self, from: JSONSerialization.data(withJSONObject: XCTUnwrap(sent["credential"]))
            )
            XCTAssertTrue(sentCredential == original, "stdin credential transport")
            if let refreshed = response.refreshedCredential {
                _ = try store.save(credential: refreshed, for: testAccountRef)
            }
            let reloaded = try AuthFileCredentialStore(fileURL: file).load(for: testAccountRef)
            XCTAssertEqual(reloaded?.revision, scenario.valid ? 2 : 1, scenario.name)
            XCTAssertTrue(reloaded?.credential == (scenario.valid ? rotation : original), "stored credential: \(scenario.name)")
            let unchanged = try Data(contentsOf: file) == before
            if !scenario.valid {
                XCTAssertTrue(unchanged, "invalid payload changed storage: \(scenario.name)")
            }
            let permissions = try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? NSNumber
            XCTAssertEqual(permissions?.intValue, 0o600)
            if case .failure(let error) = response {
                print("typed-error-process \(scenario.name) code=\(error.wireCode) rotation=\(response.refreshedCredential != nil) revision=\(reloaded?.revision ?? -1) unchanged=\(unchanged) mode0600=\(permissions?.intValue == 0o600)")
            }
        }
    }
}
