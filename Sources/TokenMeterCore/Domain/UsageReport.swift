// Domain value types for usage reports (plan: "Protocol decisions").
//
// There is deliberately no model catalog type anywhere in this module: a
// limit is identified by `limitId`, `productKind`, `unit` and utilization
// only. Heterogeneous windows/units are never aggregated — each limit stays
// an independent row.
import Foundation

/// Units a limit can be denominated in. `unknown` keeps unrepresentable
/// units visible instead of guessing.
public enum UsageUnit: String, Codable, Equatable, Sendable, CaseIterable {
    case percent
    case tokens
    case requests
    case usd
    case minutes
    case bytes
    case unknown
}

/// Product kinds are never substituted or cross-aggregated.
public enum ProductKind: String, Codable, Equatable, Sendable, CaseIterable {
    case quota
    case billingUsage
    case organizationUsage
    case localActivity
}

/// Utilization of a single limit. `fraction` is the resolved utilization in
/// [0, ∞) when the provider exposed one (explicitly or derived); `used` and
/// `limit` are the raw amounts when available. A nil `fraction` with amounts
/// present stays visibly `unknown` severity.
public struct Utilization: Equatable, Sendable {
    public let fraction: Double?
    public let used: Double?
    public let limit: Double?

    public init(fraction: Double? = nil, used: Double? = nil, limit: Double? = nil) {
        self.fraction = fraction
        self.used = used
        self.limit = limit
    }
}

/// One independent quota window as normalized by a connector.
public struct QuotaLimit: Equatable, Sendable {
    public let limitId: String
    public let productKind: ProductKind
    public let unit: UsageUnit
    public let utilization: Utilization
    public let windowSeconds: Int64?
    public let resetsAtMs: Int64?

    public init(
        limitId: String,
        productKind: ProductKind,
        unit: UsageUnit,
        utilization: Utilization,
        windowSeconds: Int64? = nil,
        resetsAtMs: Int64? = nil
    ) {
        self.limitId = limitId
        self.productKind = productKind
        self.unit = unit
        self.utilization = utilization
        self.windowSeconds = windowSeconds
        self.resetsAtMs = resetsAtMs
    }
}

/// A complete, correlated usage report. Only complete reports are cached
/// (plan: "Cache only complete reports").
public struct UsageReport: Equatable, Sendable {
    public let schemaVersion: String
    public let requestId: String
    public let providerId: String
    public let connectorId: String
    public let accountRef: String
    public let fetchedAtMs: Int64
    public let limits: [QuotaLimit]
    /// Set only when the connector rotated a credential during this fetch.
    public let refreshedCredential: BridgeCredential?

    public init(
        schemaVersion: String,
        requestId: String,
        providerId: String,
        connectorId: String,
        accountRef: String,
        fetchedAtMs: Int64,
        limits: [QuotaLimit],
        refreshedCredential: BridgeCredential? = nil
    ) {
        self.schemaVersion = schemaVersion
        self.requestId = requestId
        self.providerId = providerId
        self.connectorId = connectorId
        self.accountRef = accountRef
        self.fetchedAtMs = fetchedAtMs
        self.limits = limits
        self.refreshedCredential = refreshedCredential
    }
}
