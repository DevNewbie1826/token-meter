import Foundation
import XCTest
@testable import TokenMeterCore

final class AntigravityAdapterIntegrationTests: XCTestCase {
    private var executable: URL?

    override func setUpWithError() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("antigravity-probe-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock {
            try FileManager.default.removeItem(at: directory)
            print("antigravity cleanup=removed-isolated-probe")
        }
        let binary = directory.appendingPathComponent("antigravity-wire-probe")
        let compiler = Process()
        compiler.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        compiler.currentDirectoryURL = root.appendingPathComponent("bridge")
        compiler.arguments = ["bun", "build", "test/antigravity-wire-probe.ts", "--compile", "--outfile", binary.path]
        compiler.standardOutput = FileHandle.standardError
        compiler.standardError = FileHandle.standardError
        try compiler.run()
        compiler.waitUntilExit()
        guard compiler.terminationStatus == 0 else {
            throw NSError(domain: "AntigravityProbeCompilation", code: Int(compiler.terminationStatus))
        }
        executable = binary
    }

    private func fetch(_ scenario: String) async throws -> UsageResponse {
        let executable = try XCTUnwrap(executable)
        XCTAssertTrue(FileManager.default.isExecutableFile(atPath: executable.path),
                      "Antigravity isolated probe compilation must produce an executable")
        let request = UsageRequest(
            requestId: testRequestId, operation: .fetchUsage,
            providerId: "google-antigravity", connectorId: "google-antigravity",
            accountRef: scenario, requestedAtMs: testNowMs, deadlineAtMs: testNowMs + 30_000,
            credential: .oauth(access: "synthetic-antigravity-access",
                               expiresAtMs: testNowMs + 3_600_000,
                               identity: ["projectId": "synthetic-project"])
        )
        return await BridgeClient(executableURL: executable, clock: ManualClock(nowMs: testNowMs))
            .fetchUsage(request)
    }

    func testRemainingOnlyAmountsHaveNoInventedDenominatorThroughRealProcess() async throws {
        guard case .report(let report) = try await fetch("remaining") else {
            return XCTFail("actual Antigravity remaining report failed Swift decoding")
        }
        XCTAssertEqual(report.limits.count, 2)
        XCTAssertEqual(report.limits.map(\.utilization.remaining), [42.5, 0])
        for row in report.limits {
            XCTAssertEqual(row.unit, .unknown)
            XCTAssertNil(row.utilization.limit)
            XCTAssertNil(row.utilization.used)
            XCTAssertNil(row.utilization.fraction)
            XCTAssertNil(row.utilization.remainingFraction)
        }
    }

    func testGroupedIndependentBucketsDecodeWithoutRankingDuplicates() async throws {
        guard case .report(let report) = try await fetch("grouped") else {
            return XCTFail("actual Antigravity grouped report failed Swift decoding")
        }
        XCTAssertEqual(report.limits.count, 4)
        XCTAssertEqual(Set(report.limits.map(\.limitId)).count, 4)
        XCTAssertEqual(report.limits.map(\.utilization.fraction), [0.95, 0.875, 0.8, 0])
        XCTAssertEqual(report.limits.filter { $0.limitId.contains("3p-") }.count, 2)
        XCTAssertEqual(report.limits.first?.resetsAtMs, 1_787_029_200_000)
    }

    func testLegacySeverityBoundaryDecodesThroughRealProcess() async throws {
        guard case .report(let report) = try await fetch("legacy") else {
            return XCTFail("legacy 87.5% report rejected by Swift severity validation")
        }
        XCTAssertEqual(report.limits.count, 1)
        XCTAssertEqual(report.limits.first?.utilization.fraction, 0.875)
    }

    func testDisabledSummaryDoesNotResurrectLegacyQuotaThroughRealProcess() async throws {
        guard case .failure(let error) = try await fetch("disabled") else {
            return XCTFail("disabled summary must not resurrect legacy quota")
        }
        XCTAssertEqual(error.wireCode, "noData")
    }

    func testIndependentLegacyWindowsSurviveMissingResetThroughRealProcess() async throws {
        for scenario in ["legacy-independent", "weeklyreset", "consumed-no-reset"] {
            guard case .report(let report) = try await fetch(scenario) else {
                XCTFail("actual legacy boundary failed Swift decoding: \(scenario)")
                continue
            }
            let ids = scenario == "consumed-no-reset" ? ["daily", "weekly"] : ["weekly", "daily"]
            XCTAssertEqual(report.limits.map(\.limitId), ids.map { "google-antigravity:google:default:\($0)" })
            XCTAssertEqual(report.limits.count, 2)
            for (index, limit) in report.limits.enumerated() {
                let fraction = index == 0 ? 0.99 : 0.1
                XCTAssertEqual(try XCTUnwrap(limit.utilization.fraction), fraction, accuracy: 1e-12)
                XCTAssertEqual(try XCTUnwrap(limit.utilization.used), fraction * 100, accuracy: 1e-12)
                XCTAssertEqual(limit.utilization.limit, 100)
                XCTAssertEqual(limit.unit, .percent)
            }
            XCTAssertEqual(QuotaProjector().rows(for: report, nowMs: testNowMs).map(\.severity), [.critical, .ok])
            XCTAssertEqual(report.limits.first?.resetsAtMs, scenario == "weeklyreset" ? 1_787_313_600_000 : nil)
            XCTAssertEqual(report.limits.last?.resetsAtMs,
                           scenario == "consumed-no-reset" ? 1_787_313_600_000 : 1_787_029_200_000)
            print("antigravity scenario=\(scenario) rows=\(report.limits.count) fractions=\(report.limits.map(\.utilization.fraction))")
        }
    }

    func testTrueBarePhantomIsSuppressedThroughRealProcess() async throws {
        guard case .report(let report) = try await fetch("truebarephantom") else {
            return XCTFail("actual bare-phantom control failed Swift decoding")
        }
        XCTAssertEqual(report.limits.map(\.limitId), ["google-antigravity:google:default:weekly"])
        XCTAssertEqual(report.limits.first?.utilization.fraction, 0.99)
        XCTAssertEqual(report.limits.first?.utilization.used, 99)
        XCTAssertEqual(report.limits.first?.utilization.limit, 100)
        XCTAssertEqual(report.limits.first?.resetsAtMs, 1_787_313_600_000)
        XCTAssertEqual(QuotaProjector().rows(for: report, nowMs: testNowMs).map(\.severity), [.critical])
    }

    func testPopulatedAmountlessSummaryReturnsNoDataWithoutLegacyFallback() async throws {
        guard case .failure(let error) = try await fetch("empty-bucket") else {
            return XCTFail("amountless summary must not resurrect legacy quota")
        }
        XCTAssertEqual(error.wireCode, "noData")
        print("antigravity scenario=empty-bucket error=\(error.wireCode)")
    }

    func testValidSiblingSurvivesAmountlessBucketWithoutLegacyFallback() async throws {
        guard case .report(let report) = try await fetch("empty-sibling") else {
            return XCTFail("amountless bucket poisoned valid sibling through Swift decoding")
        }
        XCTAssertEqual(report.limits.map(\.limitId), ["google-antigravity:summary:0:usable:0"])
        let limit = try XCTUnwrap(report.limits.first)
        XCTAssertEqual(limit.unit, .percent)
        XCTAssertEqual(limit.utilization.used, 50)
        XCTAssertEqual(limit.utilization.limit, 100)
        XCTAssertEqual(limit.utilization.remaining, 50)
        XCTAssertEqual(limit.utilization.remainingFraction, 0.5)
        XCTAssertEqual(limit.utilization.fraction, 0.5)
        XCTAssertNil(limit.resetsAtMs)
        XCTAssertEqual(QuotaProjector().rows(for: report, nowMs: testNowMs).map(\.severity), [.ok])
        print("antigravity scenario=empty-sibling rows=1 used=50 remaining=50 fraction=0.5 severity=ok")
    }
}
