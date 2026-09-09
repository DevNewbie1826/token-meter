// Quota label rendering contracts (Nekos lane).
//
// The view seam under test is the real `QuotaRowView` body: rows arrive
// through the public decoder -> projector path and the rendered SwiftUI
// body is introspected for the literal strings it will display, including
// the accessibility label's format arguments. This proves a decoded wire
// label actually reaches the row surface without pinning any prose copy:
// assertions compare payload-label equality and machine-consumed fallback
// values (limit ids) only.
import XCTest
import SwiftUI
import TokenMeterCore
@testable import TokenMeterApp

final class QuotaLabelTests: XCTestCase {
    private let decoder = UsageResponseDecoder()
    private let projector = QuotaProjector()
    private let nowMs: Int64 = 1_787_011_200_000
    private let testRequestId = "00000000-0000-4000-8000-000000000001"
    private let testAccountRef = "00000000-0000-4000-8000-000000000002"

    // MARK: - Seams

    /// Builds one fully formed wire window (the decoder requires
    /// resolvedFraction and severity to agree).
    private func window(
        id: String,
        label: String? = nil,
        fraction: Double
    ) -> [String: Any] {
        var entry: [String: Any] = [
            "id": id,
            "unit": "percent",
            "resolvedFraction": fraction,
            "severity": fraction >= 1 ? "exhausted"
                : fraction >= 0.95 ? "critical"
                : fraction >= 0.8 ? "warning"
                : "ok",
        ]
        if let label {
            entry["label"] = label
        }
        return entry
    }

    private func projectedRows(_ windows: [[String: Any]]) throws -> [QuotaRow] {
        let envelope: [String: Any] = [
            "schemaVersion": "1.3.0",
            "requestId": testRequestId,
            "providerId": "nekos",
            "connectorId": "nekos",
            "accountRef": testAccountRef,
            "status": "ok",
            "completedAtMs": nowMs,
            "report": [
                "productKind": "quota",
                "sourceKind": "privateApi",
                "fetchedAtMs": nowMs,
                "connectorVersion": "label-test-1",
                "windows": windows,
            ],
        ]
        let data = try JSONSerialization.data(withJSONObject: envelope)
        let response = try decoder.decode(data, expectingRequestId: testRequestId)
        guard case .report(let report) = response else {
            XCTFail("expected a report, got \(response)")
            return []
        }
        return projector.rows(for: report, nowMs: nowMs)
    }

    /// The outer modifier owns the explicit AX label. Visible-content checks
    /// exclude every modifier subtree, so neither channel can mask the other.
    private func renderedStrings(of row: QuotaRow, accessibility: Bool = false) throws -> Set<String> {
        let branch = accessibility ? "modifier" : "content"
        let subtree = try XCTUnwrap(Mirror(reflecting: QuotaRowView(row: row).body)
            .children.first { $0.label == branch }?.value)
        var strings: Set<String> = []
        func walk(_ target: Any, depth: Int) {
            guard depth < 24 else { return }
            if let string = target as? String {
                strings.insert(string)
            }
            for child in Mirror(reflecting: target).children where accessibility || child.label != "modifier" {
                walk(child.value, depth: depth + 1)
            }
        }
        walk(subtree, depth: 0)
        return strings
    }

    func testRenderedPercentageWhenFinitePayloadExceedsIntegerRange() throws {
        // Given: the bridge divides finite Nekos used_percent by 100.
        let usedPercent = 1e308
        let rows = try projectedRows([
            window(id: "nekos:cost_usd:weekly:global", fraction: usedPercent / 100),
        ])
        let row = try XCTUnwrap(rows.first)
        // When: evaluate the actual SwiftUI body after decoding and projection.
        let strings = try renderedStrings(of: row)
        // Then: the uncapped finite percentage renders, still exhausted. The
        // shared 0...2-decimal formatter also groups digits (as the used/limit
        // display always has), so strip grouping before parsing.
        let percentages = strings.compactMap { text -> Double? in
            guard let percent = text.firstIndex(of: "%") else { return nil }
            return Double(text[..<percent].replacingOccurrences(of: ",", with: ""))
        }
        XCTAssertEqual(percentages.count, 1)
        XCTAssertEqual(try XCTUnwrap(percentages.first), usedPercent, accuracy: 1e292)
        XCTAssertEqual(row.fraction, usedPercent / 100)
        XCTAssertEqual(row.severity, .exhausted)
    }

    func testRenderedPercentageWhenOrdinaryOrOverLimit() throws {
        // Display keeps up to two decimals (the shared formatter), so boundary
        // values such as 0.7999 render as 79.99 instead of crossing a band as 80.
        for (fraction, expected) in [(0.0, 0.0), (0.1839, 18.39), (0.3355, 33.55), (1.25, 125.0)] {
            // Given
            let rows = try projectedRows([window(id: "overall-daily", fraction: fraction)])
            // When
            let strings = try renderedStrings(of: try XCTUnwrap(rows.first))
            // Then: assert the numeric display, not its surrounding prose.
            let percentages = strings.compactMap { text -> Double? in
                guard let percent = text.firstIndex(of: "%") else { return nil }
                return Double(text[..<percent].replacingOccurrences(of: ",", with: ""))
            }
            XCTAssertEqual(percentages, [expected])
        }
    }

    // MARK: - Provided label reaches the rendered row

    func testRenderedRowShowsProvidedLabelInsteadOfLimitId() throws {
        let rows = try projectedRows([
            window(id: "overall-3h", label: "3-hour overall", fraction: 0.1839),
        ])
        let strings = try renderedStrings(of: rows[0])
        XCTAssertTrue(
            strings.contains("3-hour overall"),
            "decoded payload label must survive into the rendered quota row; rendered: \(strings.sorted())"
        )
        XCTAssertFalse(
            strings.contains("overall-3h"),
            "a provided label must replace the limitId fallback; rendered: \(strings.sorted())"
        )
    }

    func testAccessibilityOutputIncludesProvidedScopeLabel() throws {
        // Given: distinct machine scope and fallback ID.
        let rows = try projectedRows([
            window(id: "overall-daily", label: "Daily overall", fraction: 0.1839),
        ])
        // When: inspect only the accessibility modifier, never visible Text.
        let accessibilityStrings = try renderedStrings(of: rows[0], accessibility: true)
        // Then
        XCTAssertTrue(
            accessibilityStrings.contains("Daily overall"),
            "accessibility output must include the provided scope label"
        )
    }

    func testDistinctGlobalAndModelScopeLabelsRenderOnTheirOwnRows() throws {
        let rows = try projectedRows([
            window(id: "overall-daily", label: "Daily overall", fraction: 0.1839),
            window(id: "fable-daily", label: "Fable daily", fraction: 0.3355),
        ])
        let globalStrings = try renderedStrings(of: rows[0])
        let modelStrings = try renderedStrings(of: rows[1])
        XCTAssertTrue(globalStrings.contains("Daily overall"))
        XCTAssertTrue(modelStrings.contains("Fable daily"))
        XCTAssertFalse(globalStrings.contains("Fable daily"))
        XCTAssertFalse(modelStrings.contains("Daily overall"))
    }

    // MARK: - Absent/empty label fallback (existing semantics)

    func testRenderedRowFallsBackToLimitIdWhenLabelAbsent() throws {
        let rows = try projectedRows([
            window(id: "overall-3h", fraction: 0.1839),
        ])
        XCTAssertTrue(
            try renderedStrings(of: rows[0]).contains("overall-3h"),
            "absent label must keep the existing limitId fallback"
        )
    }

    func testRenderedRowTreatsEmptyLabelAsAbsent() throws {
        let rows = try projectedRows([
            window(id: "overall-3h", label: "", fraction: 0.1839),
        ])
        XCTAssertTrue(
            try renderedStrings(of: rows[0]).contains("overall-3h"),
            "an empty label must fall back to the existing limitId display"
        )
    }
}
