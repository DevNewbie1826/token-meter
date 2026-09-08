// Contract: strict TokenMeter/1.3.0 bridge response decoding, typed
// errors, utilization precedence and request encoding (plan criteria 2 and 4).
//
// These tests define the public decoding/encoding surface of TokenMeterCore.
// Error taxonomy pinned here:
//   - invalidProtocol: envelope violations (unknown fields, wrong/missing
//     schemaVersion, correlation mismatch, size bounds)
//   - malformedPayload: value-domain violations (unknown unit/product kind/
//     error code, duplicate limit IDs, inconsistent amount/fraction)
//   - partialPayload: incomplete-but-well-formed reports (limit entries with
//     no utilization representation at all, empty limit lists)
import XCTest
import Foundation
@testable import TokenMeterCore

final class BridgeDecodingTests: XCTestCase {

    // MARK: - Success decoding

    func testDecodesActualBridgeSuccessEnvelope() throws {
        let data = try JSONSerialization.data(withJSONObject: [
            "schemaVersion": "1.3.0",
            "requestId": testRequestId,
            "providerId": "github-copilot",
            "connectorId": "github-copilot",
            "accountRef": testAccountRef,
            "status": "ok",
            "completedAtMs": testNowMs,
            "report": [
                "productKind": "billingUsage",
                "sourceKind": "documentedApi",
                "fetchedAtMs": testNowMs,
                "connectorVersion": "github-billing-1",
                "windows": [
                    [
                        "id": "premium-requests-monthly",
                        "label": "Premium requests (monthly)",
                        "unit": "requests",
                        "severity": "unknown",
                        "used": 162,
                    ],
                ],
            ],
        ])

        guard case let .report(report) = try UsageResponseDecoder().decode(
            data,
            expectingRequestId: testRequestId
        ) else {
            return XCTFail("expected a report")
        }
        XCTAssertEqual(report.providerId, "github-copilot")
        XCTAssertEqual(report.connectorId, "github-copilot")
        XCTAssertEqual(report.limits.count, 1)
        XCTAssertEqual(report.limits.first?.limitId, "premium-requests-monthly")
        XCTAssertEqual(report.limits.first?.productKind, .billingUsage)
        XCTAssertEqual(report.limits.first?.unit, .requests)
        XCTAssertNil(report.limits.first?.utilization.fraction)
        XCTAssertEqual(report.limits.first?.utilization.used, 162)
        XCTAssertNil(report.limits.first?.utilization.limit)
    }

    func testDecodesRefreshedCredentialWriteback() throws {
        let data = try usageResponseData(
            limits: [[
                "limitId": "fixture:primary",
                "productKind": "quota",
                "unit": "requests",
                "fraction": 0.1,
            ]],
            extraFields: [
                "refreshedCredential": [
                    "kind": "oauth",
                    "secret": "rotated-access",
                    "oauth": [
                        "access": "rotated-access",
                        "refresh": "rotated-refresh",
                        "expiresAtMs": testNowMs + 3_600_000,
                        "identity": ["login": "octocat"],
                    ],
                ],
            ]
        )

        guard case let .report(report) = try UsageResponseDecoder().decode(data) else {
            return XCTFail("expected a report")
        }
        XCTAssertEqual(
            report.refreshedCredential,
            .oauthCredential(
                secret: "rotated-access",
                access: "rotated-access",
                refresh: "rotated-refresh",
                expiresAtMs: testNowMs + 3_600_000,
                identity: ["login": "octocat"]
            )
        )
    }

    func testSuccessWithoutWritebackHasNoRefreshedCredential() throws {
        let data = try usageResponseData(limits: [[
            "limitId": "fixture:primary",
            "productKind": "quota",
            "unit": "requests",
            "fraction": 0.1,
        ]])

        guard case let .report(report) = try UsageResponseDecoder().decode(data) else {
            return XCTFail("expected a report")
        }
        XCTAssertNil(report.refreshedCredential)
    }

    func testRejectsMalformedRefreshedCredential() throws {
        let data = try usageResponseData(
            limits: [[
                "limitId": "fixture:primary",
                "productKind": "quota",
                "unit": "requests",
                "fraction": 0.1,
            ]],
            extraFields: [
                "refreshedCredential": [
                    "kind": "oauth",
                    "secret": "access-without-oauth-object",
                ],
            ]
        )
        expectBridgeError(.invalidProtocol("invalid refreshedCredential")) {
            _ = try UsageResponseDecoder().decode(data)
        }
    }

    func testRejectsUnknownFieldInsideRefreshedOAuthCredential() throws {
        let data = try usageResponseData(
            limits: [[
                "limitId": "fixture:primary",
                "productKind": "quota",
                "unit": "requests",
                "fraction": 0.1,
            ]],
            extraFields: [
                "refreshedCredential": [
                    "kind": "oauth",
                    "secret": "access",
                    "oauth": [
                        "access": "access",
                        "tokenType": "Bearer",
                    ],
                ],
            ]
        )
        expectBridgeError(.invalidProtocol("invalid refreshedCredential")) {
            _ = try UsageResponseDecoder().decode(data)
        }
    }

    func testDecodesCompleteReportWithResolvedUtilization() throws {
        let data = try usageResponseData(limits: [
            [
                "limitId": "fixture:primary",
                "productKind": "quota",
                "unit": "requests",
                "used": 80,
                "limit": 200,
                "fraction": 0.4,
                "resetsAtMs": testNowMs + 2_700_000,
            ],
            [
                "limitId": "fixture:secondary",
                "productKind": "quota",
                "unit": "percent",
                "fraction": 0.62,
            ],
        ])

        let response = try UsageResponseDecoder().decode(data, expectingRequestId: testRequestId)

        guard case let .report(report) = response else {
            return XCTFail("expected a report, got \(response)")
        }
        XCTAssertEqual(report.schemaVersion, "1.3.0")
        XCTAssertEqual(report.requestId, testRequestId)
        XCTAssertEqual(report.providerId, "fixture")
        XCTAssertEqual(report.connectorId, "fixture")
        XCTAssertEqual(report.accountRef, testAccountRef)
        XCTAssertEqual(report.fetchedAtMs, testNowMs)
        guard report.limits.count == 2 else {
            return XCTFail("expected 2 limits, got \(report.limits.count)")
        }

        let primary = report.limits[0]
        XCTAssertEqual(primary.limitId, "fixture:primary")
        XCTAssertEqual(primary.productKind, .quota)
        XCTAssertEqual(primary.unit, .requests)
        XCTAssertEqual(primary.utilization.fraction, 0.4)
        XCTAssertEqual(primary.utilization.used, 80)
        XCTAssertEqual(primary.utilization.limit, 200)
        XCTAssertNil(primary.windowSeconds)
        XCTAssertEqual(primary.resetsAtMs, testNowMs + 2_700_000)

        let secondary = report.limits[1]
        XCTAssertEqual(secondary.unit, .percent)
        XCTAssertEqual(secondary.utilization.fraction, 0.62)
        XCTAssertNil(secondary.utilization.used)
        XCTAssertNil(secondary.utilization.limit)
        XCTAssertNil(secondary.windowSeconds)
        XCTAssertNil(secondary.resetsAtMs)
    }

    func testResolvesUtilizationFromUsedOverLimitWhenFractionAbsent() throws {
        let data = try usageResponseData(limits: [[
            "limitId": "fixture:used-limit",
            "productKind": "quota",
            "unit": "tokens",
            "used": 25,
            "limit": 200,
        ]])

        guard case let .report(report) = try UsageResponseDecoder().decode(data) else {
            return XCTFail("expected a report")
        }
        let limit = try XCTUnwrap(report.limits.first)
        XCTAssertEqual(limit.utilization.fraction, 0.125)
    }

    func testDecodesResolvedFractionFromBridgeWindow() throws {
        let data = try usageResponseData(limits: [[
            "limitId": "fixture:percent",
            "productKind": "quota",
            "unit": "percent",
            "resolvedFraction": 0.625,
        ]])

        guard case let .report(report) = try UsageResponseDecoder().decode(data) else {
            return XCTFail("expected a report")
        }
        let limit = try XCTUnwrap(report.limits.first)
        XCTAssertEqual(limit.utilization.fraction, 0.625)
    }

    func testAcceptsResetCreditsOnlyWindowAsUnknownUtilization() throws {
        let data = try usageResponseData(limits: [[
            "limitId": "fixture:reset-credits",
            "productKind": "quota",
            "unit": "unknown",
            "resetCredits": 120,
        ]])

        guard case let .report(report) = try UsageResponseDecoder().decode(data) else {
            return XCTFail("expected a report")
        }
        XCTAssertNil(report.limits.first?.utilization.fraction)
        XCTAssertNil(report.limits.first?.utilization.used)
    }

    // MARK: - Strictness: envelope violations -> invalidProtocol

    func testRejectsUnknownTopLevelField() throws {
        let data = try usageResponseData(
            limits: [[
                "limitId": "fixture:primary",
                "productKind": "quota",
                "unit": "requests",
                "fraction": 0.1,
            ]],
            extraFields: ["arbitraryMetadata": ["unexpected": true]]
        )
        expectBridgeError(.invalidProtocol("unknown field: arbitraryMetadata")) {
            _ = try UsageResponseDecoder().decode(data)
        }
    }

    func testRejectsUnknownFieldInsideLimitEntry() throws {
        let data = try usageResponseData(limits: [[
            "limitId": "fixture:primary",
            "productKind": "quota",
            "unit": "requests",
            "fraction": 0.1,
            "models": ["gpt-imagination"],
        ]])
        expectBridgeError(.invalidProtocol("unknown field: models")) {
            _ = try UsageResponseDecoder().decode(data)
        }
    }

    func testRejectsWrongSchemaVersion() throws {
        let data = try usageResponseData(
            schemaVersion: "1.0.1",
            limits: [[
                "limitId": "fixture:primary",
                "productKind": "quota",
                "unit": "requests",
                "fraction": 0.1,
            ]]
        )
        expectBridgeError(.invalidProtocol("unsupported schemaVersion: 1.0.1")) {
            _ = try UsageResponseDecoder().decode(data)
        }
    }

    func testRejectsCorrelationMismatch() throws {
        let data = try usageResponseData(
            requestId: "00000000-0000-4000-8000-00000000dead",
            limits: [[
                "limitId": "fixture:primary",
                "productKind": "quota",
                "unit": "requests",
                "fraction": 0.1,
            ]]
        )
        expectBridgeError(.invalidProtocol("requestId mismatch")) {
            _ = try UsageResponseDecoder().decode(data, expectingRequestId: testRequestId)
        }
    }

    func testRejectsOversizedResponse() {
        let oversized = Data(
            repeating: 0x20,
            count: UsageResponseDecoder.maximumResponseBytes + 1
        )
        expectBridgeError(.invalidProtocol("response exceeds 2 MiB")) {
            _ = try UsageResponseDecoder().decode(oversized)
        }
    }

    // MARK: - Strictness: value-domain violations -> malformedPayload

    func testRejectsUnknownUnitValue() throws {
        let data = try usageResponseData(limits: [[
            "limitId": "fixture:primary",
            "productKind": "quota",
            "unit": "gallons",
            "fraction": 0.1,
        ]])
        expectBridgeError(.malformedPayload("unknown unit: gallons")) {
            _ = try UsageResponseDecoder().decode(data)
        }
    }

    func testRejectsUnknownProductKindValue() throws {
        let data = try usageResponseData(limits: [[
            "limitId": "fixture:primary",
            "productKind": "subscription",
            "unit": "requests",
            "fraction": 0.1,
        ]])
        expectBridgeError(.malformedPayload("unknown productKind: subscription")) {
            _ = try UsageResponseDecoder().decode(data)
        }
    }

    func testRejectsDuplicateLimitIds() throws {
        let data = try usageResponseData(limits: [
            [
                "limitId": "fixture:primary",
                "productKind": "quota",
                "unit": "requests",
                "fraction": 0.1,
            ],
            [
                "limitId": "fixture:primary",
                "productKind": "quota",
                "unit": "tokens",
                "fraction": 0.2,
            ],
        ])
        expectBridgeError(.malformedPayload("duplicate limitId: fixture:primary")) {
            _ = try UsageResponseDecoder().decode(data)
        }
    }

    func testRejectsInconsistentFractionAgainstUsedLimit() throws {
        let data = try usageResponseData(limits: [[
            "limitId": "fixture:primary",
            "productKind": "quota",
            "unit": "requests",
            "used": 1,
            "limit": 4,
            "fraction": 0.9,
        ]])
        expectBridgeError(.malformedPayload("inconsistent fraction")) {
            _ = try UsageResponseDecoder().decode(data)
        }
    }

    // MARK: - Strictness: incomplete reports -> partialPayload

    func testRejectsLimitEntryWithoutAnyUtilizationRepresentation() throws {
        let data = try usageResponseData(limits: [[
            "limitId": "fixture:primary",
            "productKind": "quota",
            "unit": "requests",
            "windowSeconds": 3_600,
        ]])
        expectBridgeError(.partialPayload("no utilization for limit: fixture:primary")) {
            _ = try UsageResponseDecoder().decode(data)
        }
    }

    func testAcceptsEmptyLimitsArrayForHonestNoQuotaReports() throws {
        let data = try usageResponseData(limits: [])
        guard case let .report(report) = try UsageResponseDecoder().decode(data) else {
            return XCTFail("expected an empty report")
        }
        XCTAssertTrue(report.limits.isEmpty)
    }

    // MARK: - Typed error envelopes

    func testDecodesRateLimitedErrorEnvelopeWithRetryAfter() throws {
        let data = try usageErrorData(code: "rateLimited", retryAfterMs: 30_000)

        let response = try UsageResponseDecoder().decode(data, expectingRequestId: testRequestId)

        XCTAssertEqual(response, .failure(.rateLimited(retryAfterMs: 30_000)))
    }

    func testDecodesTimeoutErrorEnvelope() throws {
        let data = try usageErrorData(code: "timeout")

        let response = try UsageResponseDecoder().decode(data)

        XCTAssertEqual(response, .failure(.timeout))
    }

    func testErrorEnvelopeExposesRefreshedCredentialBeforeSurfacingError() throws {
        let refreshed = BridgeCredential.oauth(
            access: "rotated-access",
            refresh: "rotated-refresh",
            expiresAtMs: testNowMs + 3_600_000
        )
        let data = try usageErrorData(
            code: "authRequired",
            refreshedCredential: refreshed
        )

        let response = try UsageResponseDecoder().decode(data)
        guard case let .failure(error) = response else {
            return XCTFail("expected a typed usage failure")
        }
        XCTAssertEqual(response.refreshedCredential, refreshed)
        XCTAssertEqual(error.refreshedCredential, refreshed)
        XCTAssertEqual(error.underlyingError, .authRequired)
    }

    func testRefreshedCredentialSecretsAreRedactedFromErrorMessages() throws {
        let refreshed = BridgeCredential.oauth(
            access: "rotated-access",
            refresh: "rotated-refresh"
        )
        let data = try usageErrorData(
            code: "invalidRequest",
            message: "rejected rotated-access via rotated-refresh",
            refreshedCredential: refreshed
        )

        guard case let .failure(error) = try UsageResponseDecoder().decode(data) else {
            return XCTFail("expected a typed usage failure")
        }
        XCTAssertEqual(
            error.underlyingError,
            .invalidRequest("rejected [redacted] via [redacted]")
        )
        XCTAssertEqual(error.refreshedCredential, refreshed)
    }

    func testRejectsMalformedRefreshedCredentialOnErrorEnvelope() throws {
        let data = try usageErrorData(
            code: "authRequired",
            rawRefreshedCredential: ["kind": "none", "secret": "unexpected"]
        )
        expectBridgeError(.invalidProtocol("invalid refreshedCredential")) {
            _ = try UsageResponseDecoder().decode(data)
        }
    }

    func testRejectsUnknownErrorCode() throws {
        let data = try usageErrorData(code: "quantumFlux")
        expectBridgeError(.malformedPayload("unknown error code: quantumFlux")) {
            _ = try UsageResponseDecoder().decode(data)
        }
    }

    // MARK: - Request encoding

    func testEncodesWellFormedFetchRequest() throws {
        let request = UsageRequest(
            requestId: testRequestId,
            operation: .fetchUsage,
            providerId: "fixture",
            connectorId: "fixture",
            accountRef: testAccountRef,
            requestedAtMs: testNowMs,
            deadlineAtMs: testNowMs + 10_000,
            credential: .staticCredential(kind: .bearer, secret: "demo")
        )

        let data = try UsageRequestEncoder().encode(request)
        XCTAssertLessThanOrEqual(data.count, UsageRequestEncoder.maximumRequestBytes)

        let object = try jsonObject(from: data)
        XCTAssertEqual(object["schemaVersion"] as? String, "1.3.0")
        XCTAssertEqual(object["operation"] as? String, "fetchUsage")
        XCTAssertEqual(object["requestId"] as? String, testRequestId)
        XCTAssertEqual(object["providerId"] as? String, "fixture")
        XCTAssertEqual(object["connectorId"] as? String, "fixture")
        XCTAssertEqual(object["accountRef"] as? String, testAccountRef)
        XCTAssertEqual(object["requestedAtMs"] as? Int, Int(testNowMs))
        XCTAssertEqual(object["deadlineAtMs"] as? Int, Int(testNowMs + 10_000))
        let credential = try XCTUnwrap(object["credential"] as? [String: Any])
        XCTAssertEqual(credential["kind"] as? String, "bearer")
        XCTAssertEqual(credential["secret"] as? String, "demo")
    }

    func testUsageRequestOmitsAnAbsentCredential() throws {
        let request = UsageRequest(
            requestId: testRequestId,
            operation: .fetchUsage,
            providerId: "ollama",
            connectorId: "ollama",
            accountRef: testAccountRef,
            requestedAtMs: testNowMs,
            deadlineAtMs: testNowMs + 10_000,
            credential: nil
        )

        let object = try jsonObject(from: UsageRequestEncoder().encode(request))
        XCTAssertNil(object["credential"])
        XCTAssertFalse(object.keys.contains("credential"))
    }

    func testRejectsOversizedFetchRequest() {
        let oversizedRequest = UsageRequest(
            requestId: testRequestId,
            operation: .fetchUsage,
            providerId: "fixture",
            connectorId: "fixture",
            accountRef: testAccountRef,
            requestedAtMs: testNowMs,
            deadlineAtMs: testNowMs + 10_000,
            credential: .staticCredential(
                kind: .bearer,
                secret: String(repeating: "x", count: 70_000)
            )
        )
        expectBridgeError(.invalidProtocol("request exceeds 64 KiB")) {
            _ = try UsageRequestEncoder().encode(oversizedRequest)
        }
    }
}


extension BridgeDecodingTests {
    func testMalformedCorrelatedReportRetainsValidatedRotation() throws {
        let rotation = BridgeCredential.oauth(access: "synthetic-new-access", refresh: "synthetic-new-refresh")
        for overrides: [String: Any] in [[:], ["report": NSNull()]] {
            let data = try rawUsageResponseData(windows: [[
                "id": "a", "unit": "requests", "resolvedFraction": 0.875, "severity": "ok",
            ]], overrides: overrides, rotation: rotation)
            do {
                let response = try UsageResponseDecoder().decode(data, expectingRequestId: testRequestId)
                guard case .failure(let error) = response else { return XCTFail("malformed report accepted") }
                XCTAssertTrue(error.refreshedCredential == rotation, "validated rotation was lost")
                XCTAssertTrue(["malformedPayload", "invalidProtocol"].contains(error.wireCode))
            } catch {
                XCTFail("malformed correlated report threw instead of returning attached rotation")
            }
        }
    }

    func testInvalidEnvelopeNeverSalvagesRotation() throws {
        let rotation = BridgeCredential.oauth(access: "synthetic-new-access", refresh: "synthetic-new-refresh")
        let cases: [[String: Any]] = [
            ["schemaVersion": "1.0.0"], ["requestId": "mismatched"],
            ["requestId": NSNull()], ["providerId": ""], ["connectorId": 1],
            ["accountRef": NSNull()], ["completedAtMs": false], ["completedAtMs": 0],
            ["completedAtMs": -1], ["status": "bogus"],
            ["unexpected": true], ["refreshedCredential": ["kind": "oauth", "secret": "invalid"]],
        ]
        for overrides in cases {
            let data = try rawUsageResponseData(windows: [[
                "id": "a", "unit": "requests", "resolvedFraction": 0.875, "severity": "ok",
            ]], overrides: overrides, rotation: rotation)
            do {
                let response = try UsageResponseDecoder().decode(data, expectingRequestId: testRequestId)
                XCTAssertTrue(response.refreshedCredential == nil, "invalid envelope authorized rotation")
                guard case .failure = response else { return XCTFail("invalid envelope accepted") }
            } catch let error as BridgeServiceError {
                XCTAssertTrue(error.refreshedCredential == nil, "invalid envelope authorized rotation")
            }
        }
    }

    func testRawCreditsAndRemainingOnlyRowsDecodeWithoutInventedDenominator() throws {
        let data = try rawUsageResponseData(windows: [
            ["id": "credits", "unit": "credits", "used": 80, "limit": 100, "remaining": 20,
             "remainingFraction": 0.2, "severity": "warning"],
            ["id": "remaining", "unit": "requests", "remaining": 42, "severity": "unknown"],
            ["id": "fraction", "unit": "percent", "remainingFraction": 0.125, "severity": "warning"],
        ])
        guard case .report(let report) = try UsageResponseDecoder().decode(data) else {
            return XCTFail("expected report")
        }
        XCTAssertEqual(report.limits.map(\.unit.rawValue), ["credits", "requests", "percent"])
        XCTAssertEqual(report.limits.map(\.utilization.fraction), [0.8, nil, 0.875])
        XCTAssertNil(report.limits[1].utilization.limit)
        XCTAssertNil(report.limits[1].utilization.used)
        XCTAssertEqual(report.limits.map(\.utilization.remaining), [20, 42, nil])
        XCTAssertEqual(report.limits.map(\.utilization.remainingFraction), [0.2, nil, 0.125])
    }

    func testRawRatioConsistencyAndPrecedenceBoundaries() throws {
        let cases: [(Double, String)] = [(0.8, "warning"), (0.875, "warning"), (0.899, "warning"),
                                       (0.95, "critical"), (0.999, "critical"), (1, "exhausted")]
        for (fraction, severity) in cases {
            let explicit = fraction + 5e-10
            let data = try rawUsageResponseData(windows: [[
                "id": "a", "unit": "requests", "used": fraction * 1000, "limit": 1000,
                "remaining": (1 - fraction) * 1000, "remainingFraction": 1 - fraction,
                "resolvedFraction": explicit, "severity": severity,
            ]])
            guard case .report(let report) = try UsageResponseDecoder().decode(data) else {
                return XCTFail("expected consistent boundary report")
            }
            XCTAssertEqual(report.limits[0].utilization.fraction, explicit)
        }
        for window: [String: Any] in [
            ["used": 20, "limit": 100, "resolvedFraction": 0.200000002],
            ["used": 20, "limit": 100, "remaining": 70],
            ["used": 20, "limit": 100, "remainingFraction": 0.7],
            ["remaining": 101, "limit": 100],
            ["remaining": 20, "limit": 100, "remainingFraction": 0.3],
            ["resolvedFraction": 0.2, "remainingFraction": 0.7],
        ] {
            var entry: [String: Any] = ["id": "a", "unit": "requests", "severity": "ok"]
            entry.merge(window) { _, new in new }
            XCTAssertThrowsError(try UsageResponseDecoder().decode(rawUsageResponseData(windows: [entry])))
        }
    }

    func testRawInvalidNumericDomainsAndOverflowAreRejected() throws {
        for key in ["resolvedFraction", "used", "limit", "remaining", "remainingFraction", "resetCredits"] {
            for value: Any in [-1, NSNull(), true, "1"] {
                var entry: [String: Any] = ["id": "a", "unit": "requests", "used": 1, "severity": "unknown"]
                entry[key] = value
                XCTAssertThrowsError(try UsageResponseDecoder().decode(rawUsageResponseData(windows: [entry])), key)
            }
        }
        for entry: [String: Any] in [
            ["id": "a", "unit": "requests", "remainingFraction": 1.01, "severity": "ok"],
            ["id": "a", "unit": "requests", "used": 1e308, "limit": 1e-308, "severity": "exhausted"],
        ] {
            XCTAssertThrowsError(try UsageResponseDecoder().decode(rawUsageResponseData(windows: [entry])))
        }
    }

    func testZeroDenominatorIsRejectedByWireSchema() throws {
        let data = try rawUsageResponseData(windows: [[
            "id": "a", "unit": "requests", "used": 0, "limit": 0, "remaining": 0, "severity": "unknown",
        ]])
        XCTAssertThrowsError(try UsageResponseDecoder().decode(data))
    }
}


extension BridgeDecodingTests {
    func testMalformedReportWithoutExpectedCorrelationDoesNotSalvage() throws {
        let data = try rawUsageResponseData(windows: [[
            "id": "a", "unit": "requests", "used": 1, "severity": "warning",
        ]], rotation: .oauth(access: "synthetic-rotation"))
        XCTAssertThrowsError(try UsageResponseDecoder().decode(data)) { error in
            XCTAssertTrue((error as? BridgeServiceError)?.refreshedCredential == nil)
        }
    }

    func testRemainingAmountWithCapacityDoesNotInventUsedFraction() throws {
        let data = try rawUsageResponseData(windows: [[
            "id": "a", "unit": "credits", "remaining": 25, "limit": 100, "severity": "unknown",
        ]])
        guard case .report(let report) = try UsageResponseDecoder().decode(data) else { return XCTFail("expected report") }
        let utilization = report.limits[0].utilization
        XCTAssertNil(utilization.fraction)
        XCTAssertNil(utilization.used)
        XCTAssertEqual(utilization.remaining, 25)
        XCTAssertEqual(utilization.limit, 100)
    }

    func testRemainingFractionEndpointsAndSaturatedOverage() throws {
        for (remainingFraction, fraction, severity) in [(1.0, 0.0, "ok"), (0.0, 1.0, "exhausted")] {
            let data = try rawUsageResponseData(windows: [[
                "id": "a", "unit": "percent", "remainingFraction": remainingFraction, "severity": severity,
            ]])
            guard case .report(let report) = try UsageResponseDecoder().decode(data) else { return XCTFail("expected report") }
            XCTAssertEqual(report.limits[0].utilization.fraction, fraction)
        }
        let data = try rawUsageResponseData(windows: [[
            "id": "a", "unit": "credits", "used": 120, "limit": 100, "remaining": 0,
            "remainingFraction": 0, "severity": "exhausted",
        ]])
        guard case .report(let report) = try UsageResponseDecoder().decode(data) else { return XCTFail("expected overage") }
        XCTAssertEqual(report.limits[0].utilization.fraction, 1.2)
    }

    func testNonfiniteJSONNumbersAndNaNAreRejected() throws {
        let data = try rawUsageResponseData(windows: [[
            "id": "a", "unit": "requests", "remaining": 1234567, "severity": "unknown",
        ]])
        let template = try XCTUnwrap(String(data: data, encoding: .utf8))
        for invalid in ["1e309", "-1e309", "NaN", "Infinity"] {
            let invalidData = Data(template.replacingOccurrences(of: "1234567", with: invalid).utf8)
            XCTAssertThrowsError(try UsageResponseDecoder().decode(invalidData))
        }
    }
}

extension BridgeDecodingTests {
    func testDecoderBoundaryRejectsUntrustedEnvelopesWithoutDisclosureOrRotation() throws {
        let rotation = BridgeCredential.oauth(access: UUID().uuidString, refresh: UUID().uuidString)
        for (name, data, code) in try decoderBoundaryRejections(rotation: rotation) {
            assertBoundaryFailure({ try decodeBoundaryResponse(data) }, code: code,
                                  secrets: rotation.redactionSecrets, scenario: name)
        }
    }

    func testDecoderBoundaryUncorrelatedMalformedReportsNeverDiscloseOrSalvage() throws {
        let rotation = BridgeCredential.oauth(access: UUID().uuidString, refresh: UUID().uuidString)
        let marker = rotation.secret
        for (name, window, overrides, code): (String, [String: Any], [String: Any], String) in [
            ("unit", ["unit": marker], [:], "malformedPayload"),
            ("severity", ["severity": marker], [:], "malformedPayload"),
            ("window-key", [marker: true], [:], "invalidProtocol"),
            ("partial", ["id": marker], [:], "partialPayload"),
            ("product", [:], ["productKind": marker], "malformedPayload"),
            ("source", [:], ["sourceKind": marker], "malformedPayload"),
            ("report-key", [:], [marker: true], "invalidProtocol"),
        ] {
            var entry: [String: Any] = ["id": "a", "unit": "requests", "severity": "unknown"]
            if name != "partial" { entry["used"] = 1 }
            entry.merge(window) { _, new in new }
            var envelope = try jsonObject(from: rawUsageResponseData(windows: [entry], rotation: rotation))
            var report = try XCTUnwrap(envelope["report"] as? [String: Any])
            report.merge(overrides) { _, new in new }
            envelope["report"] = report
            let data = try JSONSerialization.data(withJSONObject: envelope)
            assertBoundaryFailure({ try decodeBoundaryResponse(data, correlated: false) }, code: code,
                                  secrets: rotation.redactionSecrets, scenario: name)
        }
    }

    func testDecoderBoundaryParseErrorWithoutIdentityRemainsTypedButCannotRotate() throws {
        let rotation = BridgeCredential.oauth(access: UUID().uuidString, refresh: UUID().uuidString)
        var envelope = try jsonObject(from: usageErrorData(
            code: "invalidRequest", message: rotation.redactionSecrets.joined(separator: " "),
            refreshedCredential: rotation
        ))
        for key in ["requestId", "providerId", "connectorId", "accountRef"] { envelope.removeValue(forKey: key) }
        let data = try JSONSerialization.data(withJSONObject: envelope)
        assertBoundaryFailure({ try decodeBoundaryResponse(data, correlated: false) }, code: "invalidRequest",
                              secrets: rotation.redactionSecrets, scenario: "parse-error")
    }

    func testDecoderBoundaryMatchedTypedErrorRetainsRedactedRotation() throws {
        let rotation = BridgeCredential.oauth(access: UUID().uuidString, refresh: UUID().uuidString)
        let data = try usageErrorData(code: "upstreamError", message: rotation.redactionSecrets.joined(separator: " "),
                                      refreshedCredential: rotation)
        assertBoundaryFailure({ try decodeBoundaryResponse(data) }, code: "upstreamError",
                              secrets: rotation.redactionSecrets, rotation: rotation, scenario: "matched-control")
    }

    func testTypedErrorPayloadRejectionsThrowWithoutRotation() throws {
        let rotation = BridgeCredential.oauth(access: UUID().uuidString, refresh: UUID().uuidString)
        for scenario in try invalidTypedErrorPayloads(message: rotation.redactionSecrets.joined(separator: " ")) {
            let data = try rawTypedErrorResponseData(scenario.payload, rotation: rotation)
            XCTAssertThrowsError(try decodeBoundaryResponse(data), scenario.name) { failure in
                guard let error = failure as? BridgeServiceError else { return XCTFail("untyped failure: \(scenario.name)") }
                XCTAssertEqual(error.wireCode, scenario.code, scenario.name)
                XCTAssertTrue(error.refreshedCredential == nil, "invalid payload authorized rotation: \(scenario.name)")
                for secret in rotation.redactionSecrets {
                    XCTAssertFalse(error.wireMessage?.contains(secret) == true, "diagnostic disclosure: \(scenario.name)")
                }
            }
        }
    }

    func testTypedErrorPayloadValidDomainRetainsMatchedRotation() throws {
        let rotation = BridgeCredential.oauth(access: UUID().uuidString, refresh: UUID().uuidString)
        for scenario in validTypedErrorPayloads() {
            let data = try rawTypedErrorResponseData(scenario.payload, rotation: rotation)
            guard case .failure(let error) = try decodeBoundaryResponse(data) else { return XCTFail(scenario.name) }
            XCTAssertEqual(error.wireCode, scenario.code, scenario.name)
            XCTAssertTrue(error.refreshedCredential == rotation, "valid rotation lost: \(scenario.name)")
            if scenario.code == "rateLimited" {
                XCTAssertEqual(error.underlyingError, .rateLimited(retryAfterMs: scenario.retry), scenario.name)
            }
        }
    }

    func testTypedErrorPayloadRejectsNonfiniteNumbersAtSharedBoundary() {
        for value in [Double.infinity, -Double.infinity, Double.nan] {
            XCTAssertThrowsError(try StrictJSON.decodeErrorPayload([
                "kind": "rateLimited", "message": "failure", "retryAfterMs": NSNumber(value: value),
            ])) { failure in
                guard let error = failure as? BridgeServiceError else { return XCTFail("untyped failure") }
                XCTAssertEqual(error.wireCode, "invalidProtocol")
                XCTAssertTrue(error.refreshedCredential == nil)
            }
        }
    }

    func testDecoderBoundaryEachSuppliedIdentityIsEnforcedIndependently() throws {
        let rotation = BridgeCredential.oauth(access: UUID().uuidString)
        let data = try usageErrorData(code: "upstreamError", refreshedCredential: rotation)
        for index in 0..<3 {
            assertBoundaryFailure({ try UsageResponseDecoder().decode(
                data, expectingProviderId: index == 0 ? "unrelated" : nil,
                expectingConnectorId: index == 1 ? "unrelated" : nil,
                expectingAccountRef: index == 2 ? "unrelated" : nil
            ) }, code: "invalidProtocol", secrets: rotation.redactionSecrets, scenario: "independent-\(index)")
        }
    }
}
