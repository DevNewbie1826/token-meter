// Quota label propagation contracts (Nekos lane).
//
// The wire `usageWindow` object has always permitted an optional `label`
// string, but the Swift decoder accepted and silently discarded it. These
// tests pin the full preservation path: wire label -> QuotaLimit ->
// QuotaRow, strict rejection of wrong-typed labels, and unchanged
// absent-label semantics.
//
// RED discipline: the field-level assertions use `Mirror` lookups by child
// name instead of typed member access, so the file compiles both before and
// after the `label` field exists; a missing field is an assertion failure,
// never a compile error.
import XCTest
import TokenMeterCore

final class QuotaLabelTests: XCTestCase {
    private let decoder = UsageResponseDecoder()

    // MARK: - Seams

    /// Decodes one wire report carrying the given windows and returns the
    /// projected domain limits.
    private func decodeLimits(_ windows: [[String: Any]]) throws -> [QuotaLimit] {
        let data = try usageResponseData(limits: windows)
        let response = try decoder.decode(data, expectingRequestId: testRequestId)
        guard case .report(let report) = response else {
            XCTFail("expected a report, got \(response)")
            return []
        }
        return report.limits
    }

    /// Pre-field assertion seam: reads the stored `label` child of a domain
    /// value through reflection, returning nil when the field does not
    /// exist or holds no string.
    private func mirrorLabel(of value: Any) -> String? {
        Mirror(reflecting: value)
            .children
            .first { $0.label == "label" }?
            .value as? String
    }

    private func projectedRows(_ windows: [[String: Any]]) throws -> [QuotaRow] {
        let limits = try decodeLimits(windows)
        return QuotaProjector().rows(for: makeReport(limits: limits), nowMs: testNowMs)
    }

    // MARK: - Decoded-label preservation

    func testDecoderPreservesProvidedWindowLabel() throws {
        let limits = try decodeLimits([[
            "limitId": "overall-3h",
            "label": "3-hour overall",
            "unit": "percent",
            "fraction": 0.1839,
        ]])
        XCTAssertEqual(limits.count, 1)
        XCTAssertEqual(mirrorLabel(of: limits[0]), "3-hour overall")
    }

    func testProjectionCarriesProvidedLabelIntoQuotaRow() throws {
        let rows = try projectedRows([[
            "limitId": "overall-3h",
            "label": "3-hour overall",
            "unit": "percent",
            "fraction": 0.1839,
        ]])
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(mirrorLabel(of: rows[0]), "3-hour overall")
    }

    func testDistinctGlobalAndModelScopeLabelsPreservedPerLimit() throws {
        let limits = try decodeLimits([
            [
                "limitId": "overall-daily",
                "label": "Daily overall",
                "unit": "percent",
                "fraction": 0.1839,
            ],
            [
                "limitId": "fable-daily",
                "label": "Fable daily",
                "unit": "percent",
                "fraction": 0.3355,
            ],
        ])
        XCTAssertEqual(limits.count, 2)
        XCTAssertEqual(mirrorLabel(of: limits[0]), "Daily overall")
        XCTAssertEqual(mirrorLabel(of: limits[1]), "Fable daily")
    }

    // MARK: - Strict rejection of malformed labels

    func testDecoderRejectsWrongTypedLabel() throws {
        let data = try usageResponseData(limits: [[
            "limitId": "overall-3h",
            "label": 42,
            "unit": "percent",
            "fraction": 0.1839,
        ]])
        expectBridgeError(.malformedPayload("invalid label")) {
            _ = try self.decoder.decode(data, expectingRequestId: testRequestId)
        }
    }

    func testDecoderRejectsBooleanLabel() throws {
        let data = try usageResponseData(limits: [[
            "limitId": "overall-3h",
            "label": true,
            "unit": "percent",
            "fraction": 0.1839,
        ]])
        expectBridgeError(.malformedPayload("invalid label")) {
            _ = try self.decoder.decode(data, expectingRequestId: testRequestId)
        }
    }

    // MARK: - Absent and empty label semantics

    func testAbsentLabelProjectsAsAbsentWithoutDisturbingFallbackFields() throws {
        let limits = try decodeLimits([[
            "limitId": "overall-3h",
            "unit": "percent",
            "fraction": 0.1839,
        ]])
        XCTAssertEqual(limits.count, 1)
        XCTAssertNil(mirrorLabel(of: limits[0]))
        let rows = QuotaProjector().rows(for: makeReport(limits: limits), nowMs: testNowMs)
        XCTAssertEqual(rows.count, 1)
        XCTAssertNil(mirrorLabel(of: rows[0]))
        XCTAssertEqual(rows[0].limitId, "overall-3h")
    }

    /// The wire schema permits an empty label string. The decoder must not
    /// reject schema-valid data; it carries the empty string through and
    /// the display layer falls back.
    func testEmptyStringLabelIsCarriedThroughUntouched() throws {
        let limits = try decodeLimits([[
            "limitId": "overall-3h",
            "label": "",
            "unit": "percent",
            "fraction": 0.1839,
        ]])
        XCTAssertEqual(mirrorLabel(of: limits[0]), "")
    }
}
