// Strict response decoder for the `TokenMeter/1.3.0` bridge protocol
// (plan criteria 2 and 4).
//
// Error taxonomy pinned by the RED tests:
//   - invalidProtocol: envelope violations (unknown fields, wrong/missing
//     schemaVersion, correlation mismatch, size bounds)
//   - malformedPayload: value-domain violations (unknown unit/productKind/
//     error code, duplicate limit IDs, inconsistent amount/fraction)
//   - partialPayload: incomplete-but-well-formed reports
//
// Utilization precedence: explicit resolvedFraction, used/positive limit,
// then inverted remainingFraction. Raw remaining never invents a denominator.
// Redundant ratios agree within 1e-9 and explicit used fractions must also
// preserve the existing wire-severity consistency check.
import Foundation

public enum UsageResponse: Equatable, Sendable {
    case report(UsageReport)
    case failure(BridgeServiceError)

    /// Credential writeback is available uniformly on success and failure so
    /// orchestration can persist it before handling the report or error.
    public var refreshedCredential: BridgeCredential? {
        switch self {
        case .report(let report):
            return report.refreshedCredential
        case .failure(let error):
            return error.refreshedCredential
        }
    }
}

public struct UsageResponseDecoder: Sendable {
    public static let protocolSchemaVersion = "1.3.0"
    public static let maximumResponseBytes = 2 * 1024 * 1024

    private static let successEnvelopeKeys: Set<String> = [
        "schemaVersion", "requestId", "providerId", "connectorId",
        "accountRef", "status", "completedAtMs", "report",
        "refreshedCredential",
    ]
    private static let errorEnvelopeKeys: Set<String> = [
        "schemaVersion", "requestId", "providerId", "connectorId",
        "accountRef", "status", "completedAtMs", "error",
        "refreshedCredential",
    ]
    private static let reportKeys: Set<String> = [
        "productKind", "sourceKind", "fetchedAtMs", "connectorVersion", "windows",
    ]
    private static let windowKeys: Set<String> = [
        "id", "label", "unit", "resolvedFraction", "severity", "used",
        "limit", "remaining", "remainingFraction", "resetsAtMs", "resetCredits",
    ]
    private static let sourceKinds: Set<String> = [
        "localObserved", "documentedApi", "firstPartyApi", "privateApi",
        "browserSession", "noQuotaApi",
    ]
    private static let severities: Set<String> = [
        "ok", "warning", "critical", "exhausted", "unknown",
    ]

    public init() {}

    /// Decodes one bridge response object. Every supplied expectation must
    /// correlate exactly, including on error envelopes. Errors with absent
    /// identity fields remain typed but cannot authorize credential writeback.
    public func decode(
        _ data: Data,
        expectingRequestId expectedRequestId: String? = nil,
        expectingProviderId expectedProviderId: String? = nil,
        expectingConnectorId expectedConnectorId: String? = nil,
        expectingAccountRef expectedAccountRef: String? = nil
    ) throws -> UsageResponse {
        guard data.count <= Self.maximumResponseBytes else {
            throw BridgeServiceError.invalidProtocol("response exceeds 2 MiB")
        }
        guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw BridgeServiceError.invalidProtocol("response is not a JSON object")
        }
        // Redaction is independent of validation/authorization. Even a rejected
        // credential can contain secrets echoed in an envelope key or diagnostic.
        // Inspect only known secret slots in the already-parsed object; never
        // attach a credential merely to make its secrets available for redaction.
        let credential = object["refreshedCredential"] as? [String: Any]
        let oauth = credential?["oauth"] as? [String: Any]
        let secrets = [credential?["secret"], oauth?["access"], oauth?["refresh"]]
            .compactMap { $0 as? String }
        do {
            let response = try Self.decodeEnvelope(
                object,
                expectedRequestId: expectedRequestId,
                expectedProviderId: expectedProviderId,
                expectedConnectorId: expectedConnectorId,
                expectedAccountRef: expectedAccountRef
            )
            if case .failure(let error) = response {
                return .failure(error.redacting(secrets: secrets))
            }
            return response
        } catch let error as BridgeServiceError {
            throw error.redacting(secrets: secrets)
        }
    }

    private static func decodeEnvelope(
        _ object: [String: Any],
        expectedRequestId: String?,
        expectedProviderId: String?,
        expectedConnectorId: String?,
        expectedAccountRef: String?
    ) throws -> UsageResponse {
        guard let schemaVersion = object["schemaVersion"] as? String else {
            throw BridgeServiceError.invalidProtocol(
                "unsupported schemaVersion: \(StrictJSON.describe(object["schemaVersion"]))"
            )
        }
        guard schemaVersion == Self.protocolSchemaVersion else {
            throw BridgeServiceError.invalidProtocol("unsupported schemaVersion: \(schemaVersion)")
        }
        guard let status = object["status"] as? String else {
            throw BridgeServiceError.invalidProtocol("missing status")
        }
        switch status {
        case "ok":
            try StrictJSON.rejectUnknownKeys(object, allowed: Self.successEnvelopeKeys)
            let requestId = try StrictJSON.requiredString(object["requestId"], name: "requestId")
            if let expectedRequestId, requestId != expectedRequestId {
                throw BridgeServiceError.invalidProtocol("requestId mismatch")
            }
            guard try StrictJSON.requiredInteger(object["completedAtMs"], name: "completedAtMs") > 0 else {
                throw BridgeServiceError.invalidProtocol("invalid completedAtMs")
            }
            let providerId = try StrictJSON.requiredString(object["providerId"], name: "providerId")
            let connectorId = try StrictJSON.requiredString(object["connectorId"], name: "connectorId")
            let accountRef = try StrictJSON.requiredString(object["accountRef"], name: "accountRef")
            for (actual, expected) in [(providerId, expectedProviderId),
                                       (connectorId, expectedConnectorId),
                                       (accountRef, expectedAccountRef)] {
                if let expected, actual != expected {
                    throw BridgeServiceError.invalidProtocol("usage response correlation mismatch")
                }
            }
            let refreshedCredential = try Self.decodeRefreshedCredential(object["refreshedCredential"])
            do {
                return .report(try Self.decodeReport(
                    object,
                    requestId: requestId,
                    providerId: providerId,
                    connectorId: connectorId,
                    accountRef: accountRef,
                    refreshedCredential: refreshedCredential
                ))
            } catch let error as BridgeServiceError {
                // Only a validated, correlated envelope authorizes salvage.
                // A malformed report is never cached or projected as success.
                guard expectedRequestId != nil, let refreshedCredential else { throw error }
                return .failure(error.attaching(refreshedCredential: refreshedCredential))
            }
        case "error":
            try StrictJSON.rejectUnknownKeys(object, allowed: Self.errorEnvelopeKeys)
            var hasCompleteIdentity = true
            for (key, expected) in [
                ("requestId", expectedRequestId), ("providerId", expectedProviderId),
                ("connectorId", expectedConnectorId), ("accountRef", expectedAccountRef),
            ] {
                // Parse errors may omit identities, but an expected identity
                // must be present and exact. Present fields must be well-formed
                // even when the caller did not supply an expectation.
                if object[key] == nil, expected == nil {
                    hasCompleteIdentity = false
                    continue
                }
                let actual = try StrictJSON.requiredString(object[key], name: key)
                if let expected, actual != expected {
                    throw BridgeServiceError.invalidProtocol("usage response correlation mismatch")
                }
            }
            guard try StrictJSON.requiredInteger(object["completedAtMs"], name: "completedAtMs") > 0 else {
                throw BridgeServiceError.invalidProtocol("invalid completedAtMs")
            }
            let refreshedCredential = try Self.decodeRefreshedCredential(
                object["refreshedCredential"]
            )
            let error = try StrictJSON.decodeErrorPayload(object["error"] as Any)
            return .failure(error.attaching(
                refreshedCredential: hasCompleteIdentity ? refreshedCredential : nil
            ))
        default:
            throw BridgeServiceError.invalidProtocol("unknown status: \(status)")
        }
    }

    // MARK: - Credential writeback

    private static func decodeRefreshedCredential(_ raw: Any?) throws -> BridgeCredential? {
        guard let raw else { return nil }
        guard let object = raw as? [String: Any] else {
            throw BridgeServiceError.invalidProtocol("invalid refreshedCredential")
        }
        do {
            let data = try JSONSerialization.data(withJSONObject: object)
            return try JSONDecoder().decode(BridgeCredential.self, from: data)
        } catch {
            throw BridgeServiceError.invalidProtocol("invalid refreshedCredential")
        }
    }

    // MARK: - Reports

    private static func decodeReport(
        _ envelope: [String: Any],
        requestId: String,
        providerId: String,
        connectorId: String,
        accountRef: String,
        refreshedCredential: BridgeCredential?
    ) throws -> UsageReport {
        guard let report = envelope["report"] as? [String: Any] else {
            throw BridgeServiceError.invalidProtocol("invalid report")
        }
        try StrictJSON.rejectUnknownKeys(report, allowed: reportKeys)
        let productKindRaw = try StrictJSON.requiredString(
            report["productKind"],
            name: "productKind"
        )
        guard let productKind = ProductKind(rawValue: productKindRaw) else {
            throw BridgeServiceError.malformedPayload(
                "unknown productKind: \(productKindRaw)"
            )
        }
        let sourceKind = try StrictJSON.requiredString(report["sourceKind"], name: "sourceKind")
        guard sourceKinds.contains(sourceKind) else {
            throw BridgeServiceError.malformedPayload(
                "unknown sourceKind: \(sourceKind)"
            )
        }
        _ = try StrictJSON.requiredString(report["connectorVersion"], name: "connectorVersion")
        let fetchedAtMs = try StrictJSON.requiredInteger(report["fetchedAtMs"], name: "fetchedAtMs")
        guard let rawWindows = report["windows"] as? [Any] else {
            throw BridgeServiceError.invalidProtocol("invalid windows")
        }
        var seenIds = Set<String>()
        var limits: [QuotaLimit] = []
        limits.reserveCapacity(rawWindows.count)
        for rawLimit in rawWindows {
            guard let entry = rawLimit as? [String: Any] else {
                throw BridgeServiceError.invalidProtocol("window entry is not an object")
            }
            try StrictJSON.rejectUnknownKeys(entry, allowed: windowKeys)
            let limitId = try StrictJSON.requiredString(entry["id"], name: "window id")
            if !seenIds.insert(limitId).inserted {
                throw BridgeServiceError.malformedPayload("duplicate limitId: \(limitId)")
            }
            let unitRaw = try StrictJSON.requiredString(entry["unit"], name: "unit")
            guard let unit = UsageUnit(rawValue: unitRaw) else {
                throw BridgeServiceError.malformedPayload("unknown unit: \(unitRaw)")
            }
            let severity = try StrictJSON.requiredString(entry["severity"], name: "severity")
            guard severities.contains(severity) else {
                throw BridgeServiceError.malformedPayload(
                    "unknown severity: \(severity)"
                )
            }
            let fraction = try finiteDouble(
                entry["resolvedFraction"],
                name: "resolvedFraction"
            )
            let used = try finiteDouble(entry["used"], name: "used")
            let limitAmount = try finiteDouble(entry["limit"], name: "limit")
            if let limitAmount, limitAmount == 0 {
                throw BridgeServiceError.malformedPayload("invalid limit")
            }
            let remaining = try finiteDouble(entry["remaining"], name: "remaining")
            let remainingFraction = try finiteDouble(entry["remainingFraction"], name: "remainingFraction")
            if let remainingFraction, remainingFraction > 1 {
                throw BridgeServiceError.malformedPayload("invalid remainingFraction")
            }
            let resetsAtMs = try StrictJSON.integerValue(entry["resetsAtMs"], name: "resetsAtMs")
            let resetCredits = try finiteDouble(
                entry["resetCredits"],
                name: "resetCredits"
            )
            let label = entry["label"] as? String
            guard entry["label"] == nil || label != nil else {
                throw BridgeServiceError.malformedPayload("invalid label")
            }
            let utilization = try Self.resolveUtilization(
                limitId: limitId,
                fraction: fraction,
                used: used,
                limit: limitAmount,
                remaining: remaining,
                remainingFraction: remainingFraction,
                resetCredits: resetCredits
            )
            let expectedSeverity = Self.wireSeverity(for: utilization.fraction)
            guard expectedSeverity == severity else {
                throw BridgeServiceError.malformedPayload("inconsistent severity")
            }
            limits.append(QuotaLimit(
                limitId: limitId,
                productKind: productKind,
                unit: unit,
                utilization: utilization,
                windowSeconds: nil,
                resetsAtMs: resetsAtMs,
                label: label
            ))
        }
        return UsageReport(
            schemaVersion: protocolSchemaVersion,
            requestId: requestId,
            providerId: providerId,
            connectorId: connectorId,
            accountRef: accountRef,
            fetchedAtMs: fetchedAtMs,
            limits: limits,
            refreshedCredential: refreshedCredential
        )
    }

    private static func resolveUtilization(
        limitId: String,
        fraction: Double?,
        used: Double?,
        limit: Double?,
        remaining: Double?,
        remainingFraction: Double?,
        resetCredits: Double?
    ) throws -> Utilization {
        let epsilon = 1e-9
        var resolved = fraction
        if let used, let limit, limit > 0 {
            let ratio = used / limit
            guard ratio.isFinite else {
                throw BridgeServiceError.malformedPayload("invalid used/limit ratio")
            }
            if let fraction {
                guard abs(fraction - ratio) <= epsilon,
                      QuotaSeverity.resolve(fraction: fraction) == QuotaSeverity.resolve(fraction: ratio)
                else { throw BridgeServiceError.malformedPayload("inconsistent fraction") }
            } else {
                resolved = ratio
            }
        }
        if let remainingFraction {
            if let resolved, abs(max(0, 1 - resolved) - remainingFraction) > epsilon {
                throw BridgeServiceError.malformedPayload("inconsistent remainingFraction")
            }
            if resolved == nil { resolved = 1 - remainingFraction }
        }
        if let remaining, let limit {
            guard remaining <= limit else {
                throw BridgeServiceError.malformedPayload("remaining exceeds limit")
            }
            if limit > 0 {
                let ratio = remaining / limit
                if let remainingFraction, abs(ratio - remainingFraction) > epsilon {
                    throw BridgeServiceError.malformedPayload("inconsistent remainingFraction")
                }
                if let resolved, abs(ratio - max(0, 1 - resolved)) > epsilon {
                    throw BridgeServiceError.malformedPayload("inconsistent remaining")
                }
            }
        }
        guard resolved != nil || used != nil || limit != nil || remaining != nil || resetCredits != nil
        else {
            throw BridgeServiceError.partialPayload("no utilization for limit: \(limitId)")
        }
        return Utilization(
            fraction: resolved, used: used, limit: limit,
            remaining: remaining, remainingFraction: remainingFraction
        )
    }

    private static func wireSeverity(for fraction: Double?) -> String {
        guard let fraction else { return "unknown" }
        if fraction >= 1 { return "exhausted" }
        if fraction >= 0.95 { return "critical" }
        if fraction >= 0.8 { return "warning" }
        return "ok"
    }

    // MARK: - Strict JSON helpers

    private static func finiteDouble(_ raw: Any?, name: String) throws -> Double? {
        guard let raw else { return nil }
        guard let number = raw as? NSNumber, !StrictJSON.isBoolean(number) else {
            throw BridgeServiceError.malformedPayload("invalid \(name)")
        }
        let value = number.doubleValue
        guard value.isFinite, value >= 0 else {
            throw BridgeServiceError.malformedPayload("invalid \(name)")
        }
        return value
    }

}
