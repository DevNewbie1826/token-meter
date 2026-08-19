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
