import Foundation
import XCTest
@testable import TokenMeterCore

final class AntigravityAdapterIntegrationTests: XCTestCase {
    private func fetch(_ scenario: String) async throws -> UsageResponse {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
        let executable = root.appendingPathComponent("bridge/build/antigravity-wire-probe")
        XCTAssertTrue(FileManager.default.isExecutableFile(atPath: executable.path),
                      "Compile bridge/test/antigravity-wire-probe.ts before this integration suite")
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
}
