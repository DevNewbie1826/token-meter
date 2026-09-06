// Strict response decoder for the `TokenMeter/1.2.0` bridge protocol
// (plan criteria 2 and 4).
//
// Error taxonomy pinned by the RED tests:
//   - invalidProtocol: envelope violations (unknown fields, wrong/missing
//     schemaVersion, correlation mismatch, size bounds)
//   - malformedPayload: value-domain violations (unknown unit/productKind/
//     error code, duplicate limit IDs, inconsistent amount/fraction)
//   - partialPayload: incomplete-but-well-formed reports
//
// Utilization precedence (plan): explicit fraction, used/limit, percentUsed,
// inverted remainingFraction. A limit entry that carries no utilization
// representation at all is a partial payload; one that carries only amounts
// keeps a nil fraction and a visibly `unknown` severity.
//
// Fraction/amount consistency: when both an explicit fraction and used/limit
// are present the two representations must agree on the severity class they
// imply (the pinned <0.80 / >=0.80 / >=0.95 / >=1 ladder). Providers round
// their explicit fractions, so exact numeric equality is too strict, but a
// report whose fraction says "warning" while its amounts say "ok" is
// self-contradictory and rejected as `inconsistent fraction`.
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
    public static let protocolSchemaVersion = "1.2.0"
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
        "limit", "resetsAtMs", "resetCredits",
    ]
    private static let sourceKinds: Set<String> = [
        "localObserved", "documentedApi", "firstPartyApi", "privateApi",
        "browserSession", "noQuotaApi",
    ]
    private static let severities: Set<String> = [
        "ok", "warning", "critical", "exhausted", "unknown",
    ]

    public init() {}

    /// Decodes one bridge response object. When `expectingRequestId` is
    /// provided the response must correlate exactly.
    public func decode(_ data: Data, expectingRequestId expectedRequestId: String? = nil) throws -> UsageResponse {
        guard data.count <= Self.maximumResponseBytes else {
            throw BridgeServiceError.invalidProtocol("response exceeds 2 MiB")
        }
        guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw BridgeServiceError.invalidProtocol("response is not a JSON object")
        }
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
            _ = try StrictJSON.requiredInteger(object["completedAtMs"], name: "completedAtMs")
            let refreshedCredential = try Self.decodeRefreshedCredential(object["refreshedCredential"])
            return .report(try Self.decodeReport(
                object,
                requestId: requestId,
                refreshedCredential: refreshedCredential
            ))
        case "error":
            try StrictJSON.rejectUnknownKeys(object, allowed: Self.errorEnvelopeKeys)
            if let expectedRequestId {
                guard object["requestId"] as? String == expectedRequestId else {
                    throw BridgeServiceError.invalidProtocol("requestId mismatch")
                }
            }
            _ = try StrictJSON.requiredInteger(object["completedAtMs"], name: "completedAtMs")
            let refreshedCredential = try Self.decodeRefreshedCredential(
                object["refreshedCredential"]
            )
            let error = try StrictJSON.decodeErrorPayload(object["error"] as Any)
                .redacting(secrets: refreshedCredential?.redactionSecrets ?? [])
            return .failure(error.attaching(refreshedCredential: refreshedCredential))
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
        refreshedCredential: BridgeCredential?
    ) throws -> UsageReport {
        let providerId = try StrictJSON.requiredString(envelope["providerId"], name: "providerId")
        let connectorId = try StrictJSON.requiredString(envelope["connectorId"], name: "connectorId")
        let accountRef = try StrictJSON.requiredString(envelope["accountRef"], name: "accountRef")
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
        resetCredits: Double?
    ) throws -> Utilization {
        var resolved = fraction
        if let used, let limit {
            if limit != 0 {
                let ratio = used / limit
                if let fraction {
                    guard QuotaSeverity.resolve(fraction: fraction) == QuotaSeverity.resolve(fraction: ratio) else {
                        throw BridgeServiceError.malformedPayload("inconsistent fraction")
                    }
                } else {
                    resolved = ratio
                }
            }
        }
        guard resolved != nil || used != nil || limit != nil || resetCredits != nil
        else {
            throw BridgeServiceError.partialPayload("no utilization for limit: \(limitId)")
        }
        return Utilization(fraction: resolved, used: used, limit: limit)
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
        guard value.isFinite else {
            throw BridgeServiceError.malformedPayload("invalid \(name)")
        }
        return value
    }

}
