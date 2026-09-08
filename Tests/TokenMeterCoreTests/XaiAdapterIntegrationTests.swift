import Foundation
import XCTest
@testable import TokenMeterCore

/// Compiles only the test probe in an isolated setup; never a release input.
final class XaiAdapterIntegrationTests: XCTestCase {
    private let now: Int64 = 1_787_011_200_500
    private var executable: URL?

    override func setUpWithError() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("xai-probe-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock {
            try FileManager.default.removeItem(at: directory)
            print("xai cleanup=removed-isolated-probe")
        }
        let binary = directory.appendingPathComponent("xai-wire-probe")
        let compiler = Process()
        compiler.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        compiler.currentDirectoryURL = root.appendingPathComponent("bridge")
        compiler.arguments = ["bun", "build", "test/xai-wire-probe.ts", "--compile", "--outfile", binary.path]
        compiler.standardOutput = FileHandle.standardError
        compiler.standardError = FileHandle.standardError
        try compiler.run()
        compiler.waitUntilExit()
        guard compiler.terminationStatus == 0 else {
            throw NSError(domain: "XaiProbeCompilation", code: Int(compiler.terminationStatus))
        }
        executable = binary
    }

    private func fetch(_ scenario: String, rotate: Bool = false, refresh: Bool = true) async throws -> (UsageResponse, BridgeCredential) {
        let executable = try XCTUnwrap(executable)
        XCTAssertTrue(FileManager.default.isExecutableFile(atPath: executable.path), "compile the test-only xAI probe first")
        let credential = BridgeCredential.oauth(
            access: "synthetic-xai-access", refresh: refresh ? "synthetic-xai-refresh" : nil,
            expiresAtMs: rotate ? now : now + 3_600_000,
            refreshEndpoint: "https://auth.x.ai/oauth2/token",
            clientId: "b1a00492-073a-47ea-816f-4c329264a828",
            identity: scenario.hasPrefix("identity-")
                ? ["probeScenario": scenario]
                : ["email": "synthetic@example.invalid", "probeScenario": scenario]
        )
        let request = UsageRequest(
            requestId: UUID().uuidString, operation: .fetchUsage, providerId: "xai-oauth", connectorId: "xai-oauth",
            accountRef: testAccountRef, requestedAtMs: now, deadlineAtMs: now + 30_000, credential: credential
        )
        let response = await BridgeClient(executableURL: executable, clock: ManualClock(nowMs: now)).fetchUsage(request)
        return (response, credential)
    }

    func testActualAdapterThresholdReportsAreAcceptedByClosedSwiftWire() async throws {
        for (percent, fraction, severity) in [
            ("80", 0.8, QuotaSeverity.warning), ("87.5", 0.875, .warning), ("89.9", 0.899, .warning),
            ("95", 0.95, .critical), ("99.9", 0.999, .critical),
        ] {
            let (response, _) = try await fetch("threshold-\(percent)", rotate: true)
            guard case .report(let report) = response else {
                if case .failure(let error) = response {
                    print("xai threshold=\(fraction) rejected=\(error.wireCode) rotation=\(response.refreshedCredential != nil)")
                }
                XCTFail("actual xAI adapter report rejected at \(fraction)")
                continue
            }
            XCTAssertEqual(report.limits.count, 4)
            for row in QuotaProjector().rows(for: report, nowMs: now) {
                XCTAssertEqual(row.severity, severity)
            }
            for limit in report.limits {
                XCTAssertEqual(try XCTUnwrap(limit.utilization.fraction), fraction, accuracy: 1e-12)
            }
            XCTAssertNotNil(response.refreshedCredential)
            print("xai threshold=\(fraction) accepted rows=\(report.limits.count) severity=\(severity) rotation=true")
        }
    }

    func testActualAdapterExactRatiosKeepEveryValidIndependentRow() async throws {
        let scenarios: [(String, [(String, Double)])] = [
            ("monthly-at-cap", [("included:1mo", 100)]),
            ("monthly-overage", [("included:1mo", 120)]),
            ("optional-monthly-overage", [("credits:1w", 42), ("included:1mo", 120)]),
            ("weekly-on-demand-overage", [("credits:1w", 42), ("on-demand", 120)]),
            ("monthly-on-demand-overage", [("included:1mo", 42), ("on-demand", 120)]),
            ("weekly-monthly-overflow", [("credits:1w", 42)]),
            ("weekly-on-demand-overflow", [("credits:1w", 42)]),
            ("monthly-overflow-valid-on-demand", [("on-demand", 42)]),
            ("monthly-valid-on-demand-overflow", [("included:1mo", 42)]),
        ]
        for (scenario, expected) in scenarios {
            let (response, _) = try await fetch(scenario)
            guard case .report(let report) = response else {
                if case .failure(let error) = response {
                    print("xai \(scenario) rejected=\(error.wireCode) detail=\(error.wireMessage ?? "")")
                }
                XCTFail("lost valid independent xAI rows: \(scenario)")
                continue
            }
            XCTAssertEqual(report.limits.map(\.limitId), expected.map { "xai-oauth:\($0.0)" }, scenario)
            let rows = QuotaProjector().rows(for: report, nowMs: now)
            XCTAssertEqual(rows.count, expected.count, scenario)
            for (row, (suffix, used)) in zip(rows, expected) {
                XCTAssertEqual(row.limitId, "xai-oauth:\(suffix)", scenario)
                XCTAssertEqual(row.used, used, scenario)
                XCTAssertEqual(row.limit, 100, scenario)
                XCTAssertEqual(try XCTUnwrap(row.fraction), used / 100, accuracy: 1e-12, scenario)
                XCTAssertEqual(row.severity, used >= 100 ? .exhausted : .ok, scenario)
                print("xai \(scenario) accepted id=\(row.limitId) used=\(used) limit=100 fraction=\(row.fraction ?? -1) severity=\(row.severity)")
            }
        }
    }

    func testActualAdapterPartialBillingFailuresKeepIndependentUsefulRows() async throws {
        for (scenario, ids) in [
            ("credits-500", ["xai-oauth:included:1mo"]),
            ("credits-malformed", ["xai-oauth:included:1mo"]),
            ("weekly-monthly-500", ["xai-oauth:credits:1w", "xai-oauth:product:grokbuild:1w", "xai-oauth:on-demand"]),
            ("inferred-zero-monthly", ["xai-oauth:credits:1w"]),
        ] {
            let (response, _) = try await fetch(scenario)
            guard case .report(let report) = response else { XCTFail("lost usable xAI rows: \(scenario)"); continue }
            XCTAssertEqual(report.limits.map(\.limitId), ids)
            XCTAssertEqual(report.limits.first?.utilization.fraction, scenario == "inferred-zero-monthly" ? 0 : 0.42)
            print("xai \(scenario) accepted rows=\(report.limits.count)")
        }
    }

    func testActualAdapterUnusableAndFatalBoundariesStayErrors() async throws {
        for (scenario, expected) in [
            ("no-data", "noData"), ("expired-inferred", "noData"), ("inferred-monthly-500", "upstreamError"),
            ("both-ratios-overflow", "noData"),
            ("credits-401", "authRequired"), ("credits-403", "permissionDenied"), ("credits-429", "rateLimited"),
            ("monthly-401", "authRequired"), ("monthly-403", "permissionDenied"), ("monthly-429", "rateLimited"),
        ] {
            let (response, _) = try await fetch(scenario, refresh: false)
            guard case .failure(let error) = response else { XCTFail("accepted fatal xAI boundary: \(scenario)"); continue }
            XCTAssertEqual(error.wireCode, expected)
            XCTAssertNil(response.refreshedCredential)
            if expected == "rateLimited" { XCTAssertEqual(error.underlyingError, .rateLimited(retryAfterMs: 19_000)) }
            print("xai \(scenario) error=\(error.wireCode)")
        }
    }

    func testActualAdapterOptionalIdentityTimeoutStillReturnsQuotaAndRotation() async throws {
        let (response, _) = try await fetch("identity-timeout", rotate: true)
        guard case .report(let report) = response else { return XCTFail("optional identity timeout discarded billing") }
        XCTAssertEqual(report.limits.count, 4)
        XCTAssertEqual(report.limits.first?.utilization.fraction, 0.42)
        XCTAssertNotNil(response.refreshedCredential)
        print("xai identity-timeout accepted rows=4 rotation=true")
    }

    func testActualAdapterRotationsPersistAfterSubsequentErrors() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("xai-store-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer {
            do { try FileManager.default.removeItem(at: directory); print("xai cleanup=removed-isolated-stores") }
            catch { XCTFail("xAI store cleanup failed") }
        }
        for (scenario, expected) in [
            ("rotated-rate", "rateLimited"), ("rotated-no-data", "noData"),
            ("rotated-malformed", "malformedPayload"), ("retry-401-rate", "rateLimited"),
            ("identity-cancel", "timeout"), ("billing-cancel", "timeout"),
        ] {
            let (response, original) = try await fetch(scenario, rotate: scenario != "retry-401-rate")
            let file = directory.appendingPathComponent("\(scenario).json")
            let store = AuthFileCredentialStore(fileURL: file)
            XCTAssertEqual(try store.save(credential: original, for: testAccountRef), 1)
            guard case .failure(let error) = response else { XCTFail("expected refreshed error: \(scenario)"); continue }
            XCTAssertEqual(error.wireCode, expected)
            let rotation = try XCTUnwrap(response.refreshedCredential)
            XCTAssertTrue(rotation.secret == "synthetic-xai-access-rotated", "wrong rotated access")
            XCTAssertEqual(try store.save(credential: rotation, for: testAccountRef), 2)
            let loaded = try AuthFileCredentialStore(fileURL: file).load(for: testAccountRef)
            XCTAssertTrue(loaded?.credential == rotation, "rotation lost on durable reload")
            XCTAssertEqual(loaded?.revision, 2)
            let mode = try FileManager.default.attributesOfItem(atPath: file.path)[.posixPermissions] as? NSNumber
            XCTAssertEqual(mode?.intValue, 0o600)
            print("xai \(scenario) error=\(error.wireCode) rotation=true revision=2 mode0600=true")
        }
    }
}
