// RED contract: quota state projection (plan criterion 4).
//
// Pins: independent per-window rows (heterogeneous units/windows are never
// summed or aggregated), OMP-style severity thresholds, freshness boundaries
// against injected time, typed error/last-good retention and 24h expiry.
// Reset information is exposed as machine-consumed millisecond deltas, not
// prose, so the UI copy remains free to change.
import XCTest
import Foundation
@testable import TokenMeterCore

final class QuotaProjectionTests: XCTestCase {

    private var projector: QuotaProjector {
        QuotaProjector()
    }

    // MARK: - Independent window rows

    func testProjectBuildsIndependentRowsPerWindowWithoutAggregation() throws {
        let report = makeReport(limits: [
            makeLimit(
                limitId: "fixture:5h",
                unit: .requests,
                fraction: 0.125,
                used: 25,
                limit: 200,
                windowSeconds: 18_000,
                resetsAtMs: testNowMs + 2_700_000
            ),
            makeLimit(
                limitId: "fixture:30d-tokens",
                unit: .tokens,
                used: 1_200_000
                // no fraction, no reset: unknown severity, nil reset
            ),
            makeLimit(
                limitId: "fixture:percent",
                unit: .percent,
                fraction: 0.62
            ),
        ])

        let rows = projector.rows(for: report, nowMs: testNowMs)

        guard rows.count == 3 else {
            return XCTFail("each window must stay an independent row, got \(rows.count)")
        }

        XCTAssertEqual(rows[0].limitId, "fixture:5h")
        XCTAssertEqual(rows[0].unit, .requests)
        XCTAssertEqual(rows[0].severity, .ok)
        XCTAssertEqual(rows[0].fraction, 0.125)
        XCTAssertEqual(rows[0].used, 25)
        XCTAssertEqual(rows[0].limit, 200)
        XCTAssertEqual(rows[0].resetsInMs, 2_700_000)
        XCTAssertEqual(rows[0].windowSeconds, 18_000)

        XCTAssertEqual(rows[1].limitId, "fixture:30d-tokens")
        XCTAssertEqual(rows[1].unit, .tokens)
        XCTAssertEqual(rows[1].severity, .unknown, "missing fraction must be visibly unknown")
        XCTAssertNil(rows[1].fraction)
        XCTAssertEqual(rows[1].used, 1_200_000)
        XCTAssertNil(rows[1].limit)
        XCTAssertNil(rows[1].resetsInMs)

        XCTAssertEqual(rows[2].limitId, "fixture:percent")
        XCTAssertEqual(rows[2].unit, .percent)
        XCTAssertEqual(rows[2].severity, .ok)
        XCTAssertEqual(rows[2].fraction, 0.62)
    }

    func testRowsNeverMergeWindowsSharingAUnit() {
        let report = makeReport(limits: [
            makeLimit(limitId: "a:short", unit: .requests, fraction: 0.5),
            makeLimit(limitId: "a:long", unit: .requests, fraction: 0.8),
        ])

        let rows = projector.rows(for: report, nowMs: testNowMs)

        XCTAssertEqual(rows.map(\.limitId), ["a:short", "a:long"])
        XCTAssertEqual(rows.map(\.fraction), [0.5, 0.8], "fractions must never be summed")
        XCTAssertEqual(rows.map(\.severity), [.warning, .warning])
    }

    // MARK: - Severity thresholds

    func testSeverityResolvesPlanThresholds() {
        let cases: [(Double?, QuotaSeverity)] = [
            (0.79, .ok),
            (0.80, .warning),
            (0.94, .warning),
            (0.95, .critical),
            (0.99, .critical),
            (1.0, .exhausted),
            (1.5, .exhausted),
            (nil, .unknown),
        ]
        for (fraction, expected) in cases {
            XCTAssertEqual(
                QuotaSeverity.resolve(fraction: fraction),
                expected,
                "fraction \(String(describing: fraction)) must resolve to \(expected)"
            )
        }
    }

    // MARK: - Freshness boundaries against injected time

    func testFreshnessFollowsRefreshIntervalAndRetentionBoundaries() {
        let fetchedAt = testNowMs

        XCTAssertEqual(
            projector.freshness(fetchedAtMs: fetchedAt, nowMs: fetchedAt + 899_999),
            .fresh(fetchedAtMs: fetchedAt)
        )
        XCTAssertEqual(
            projector.freshness(fetchedAtMs: fetchedAt, nowMs: fetchedAt + 900_000),
            .stale(lastGoodAtMs: fetchedAt),
            "at exactly the 900s default refresh interval the report is due, hence stale"
        )
        XCTAssertEqual(
            projector.freshness(fetchedAtMs: fetchedAt, nowMs: fetchedAt + 86_400_000),
            .stale(lastGoodAtMs: fetchedAt),
            "at exactly 24h the last-good report is still retained"
        )
        XCTAssertEqual(
            projector.freshness(fetchedAtMs: fetchedAt, nowMs: fetchedAt + 86_400_001),
            .expired
        )
    }

    // MARK: - State projection with typed errors

    func testProjectRetainsTypedRateLimitErrorWithLastGoodRows() {
        let lastGood = makeReport(fetchedAtMs: testNowMs, limits: [
            makeLimit(limitId: "fixture:5h", unit: .requests, fraction: 0.3),
        ])
        let input = AccountSnapshotInput(
            providerId: "fixture",
            accountRef: testAccountRef,
            current: lastGood,
            currentFetchedAtMs: testNowMs,
            pendingError: .rateLimited(retryAfterMs: 30_000)
        )

        let state = projector.project(input, nowMs: testNowMs + 600_000)

        XCTAssertEqual(state.providerId, "fixture")
        XCTAssertEqual(state.accountRef, testAccountRef)
        guard state.rows.count == 1 else {
            return XCTFail("rate limiting must preserve last-good values, got \(state.rows.count) rows")
        }
        XCTAssertEqual(state.rows[0].limitId, "fixture:5h")
        XCTAssertEqual(state.freshness, .stale(lastGoodAtMs: testNowMs))
        XCTAssertEqual(state.error, .rateLimited(retryAfterMs: 30_000), "the error stays typed")
    }

    func testProjectPurgesRowsWhenLastGoodHasExpired() {
        let oldReport = makeReport(fetchedAtMs: testNowMs, limits: [
            makeLimit(limitId: "fixture:5h", unit: .requests, fraction: 0.3),
        ])
        let input = AccountSnapshotInput(
            providerId: "fixture",
            accountRef: testAccountRef,
            current: oldReport,
            currentFetchedAtMs: testNowMs,
            pendingError: .transport("network down")
        )

        let state = projector.project(input, nowMs: testNowMs + 86_400_001)

        XCTAssertEqual(state.rows, [], "expired last-good data must not be displayed")
        XCTAssertEqual(state.freshness, .expired)
        XCTAssertEqual(state.error, .transport("network down"))
    }

    func testProjectWithoutAnyDataIsIdle() {
        let input = AccountSnapshotInput(
            providerId: "fixture",
            accountRef: testAccountRef,
            current: nil,
            currentFetchedAtMs: nil,
            pendingError: nil
        )

        let state = projector.project(input, nowMs: testNowMs)

        XCTAssertEqual(state.rows, [])
        XCTAssertNil(state.freshness)
        XCTAssertNil(state.error)
    }

    func testProjectWithFreshReportAndNoErrorShowsFreshState() {
        let report = makeReport(fetchedAtMs: testNowMs, limits: [
            makeLimit(limitId: "fixture:5h", unit: .requests, fraction: 0.95),
        ])
        let input = AccountSnapshotInput(
            providerId: "fixture",
            accountRef: testAccountRef,
            current: report,
            currentFetchedAtMs: testNowMs,
            pendingError: nil
        )

        let state = projector.project(input, nowMs: testNowMs + 1_000)

        XCTAssertEqual(state.freshness, .fresh(fetchedAtMs: testNowMs))
        XCTAssertNil(state.error)
        guard let row = state.rows.first else {
            return XCTFail("expected a fresh row for the report")
        }
        XCTAssertEqual(row.severity, .critical)
    }

    // MARK: - Reset information is machine-consumed

    func testResetDeltaUsesInjectedNowAndStaysNilWhenUnknown() {
        let report = makeReport(limits: [
            makeLimit(limitId: "with-reset", unit: .requests, fraction: 0.1,
                      resetsAtMs: testNowMs + 45 * 60_000),
            makeLimit(limitId: "without-reset", unit: .tokens, fraction: 0.2),
        ])

        let rows = projector.rows(for: report, nowMs: testNowMs + 5 * 60_000)

        guard rows.count == 2 else {
            return XCTFail("expected 2 rows, got \(rows.count)")
        }
        XCTAssertEqual(rows[0].resetsInMs, 40 * 60_000)
        XCTAssertNil(rows[1].resetsInMs)
    }
}


extension QuotaProjectionTests {
    func testRemainingOnlyAndCreditsProjectIndependentHonestRows() throws {
        let data = try rawUsageResponseData(windows: [
            ["id": "credits", "unit": "credits", "used": 80, "limit": 100, "remaining": 20, "severity": "warning"],
            ["id": "remaining", "unit": "requests", "remaining": 42, "severity": "unknown"],
        ])
        guard case .report(let report) = try UsageResponseDecoder().decode(data) else { return XCTFail("expected report") }
        let rows = QuotaProjector().rows(for: report, nowMs: testNowMs)
        XCTAssertEqual(rows.map(\.limitId), ["credits", "remaining"])
        XCTAssertEqual(rows.map(\.fraction), [0.8, nil])
        XCTAssertEqual(rows.map(\.severity), [.warning, .unknown])
        XCTAssertNil(rows[1].used)
        XCTAssertNil(rows[1].limit)
        XCTAssertEqual(rows.map(\.remaining), [20, 42])
        XCTAssertEqual(rows.map(\.remainingFraction), [nil, nil])
    }
}
