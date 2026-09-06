// Quota state projection (plan criterion 4).
//
// Pins: independent per-window rows — heterogeneous units/windows are never
// summed or aggregated; OMP-style severity thresholds; freshness boundaries
// against injected time; typed error projection with last-good retention and
// 24h expiry. Reset information is a machine-consumed millisecond delta, not
// prose, so UI copy stays free.
import Foundation

/// Severity ladder (plan: "Severity: `<0.80 ok`, `>=0.80 warning`,
/// `>=0.95 critical`, `>=1 exhausted`, missing fraction `unknown`").
public enum QuotaSeverity: Equatable, Sendable {
    case ok
    case warning
    case critical
    case exhausted
    case unknown

    public static func resolve(fraction: Double?) -> QuotaSeverity {
        guard let fraction, fraction.isFinite else { return .unknown }
        if fraction >= 1.0 { return .exhausted }
        if fraction >= 0.95 { return .critical }
        if fraction >= 0.80 { return .warning }
        return .ok
    }

    /// Unit-aware row severity. Counted quantities (everything except
    /// provider-curated `percent` figures) warn from half the window
    /// consumed — a rate-limited window that is already half gone deserves
    /// visibility — while `percent` figures keep the standard 0.80 boundary.
    /// Critical/exhausted/unknown boundaries are unit-independent.
    public static func resolve(fraction: Double?, unit: UsageUnit) -> QuotaSeverity {
        guard let fraction, fraction.isFinite else { return .unknown }
        if fraction >= 1.0 { return .exhausted }
        if fraction >= 0.95 { return .critical }
        if fraction >= (unit == .percent ? 0.80 : 0.50) { return .warning }
        return .ok
    }
}

public enum QuotaFreshness: Equatable, Sendable {
    case fresh(fetchedAtMs: Int64)
    case stale(lastGoodAtMs: Int64)
    case expired
}

/// One projected, displayable window row.
public struct QuotaRow: Equatable, Sendable {
    public let limitId: String
    public let productKind: ProductKind
    public let unit: UsageUnit
    public let severity: QuotaSeverity
    public let fraction: Double?
    public let used: Double?
    public let limit: Double?
    /// Milliseconds until the window resets, from the injected `nowMs`.
    public let resetsInMs: Int64?
    public let windowSeconds: Int64?
    /// Provider-provided display label, verbatim from the decoded limit.
    public let label: String?
}

/// Everything the projection needs for one account at one instant.
public struct AccountSnapshotInput: Sendable {
    public let providerId: String
    public let accountRef: String
    public let current: UsageReport?
    public let currentFetchedAtMs: Int64?
    public let pendingError: BridgeServiceError?

    public init(
        providerId: String,
        accountRef: String,
        current: UsageReport?,
        currentFetchedAtMs: Int64?,
        pendingError: BridgeServiceError?
    ) {
        self.providerId = providerId
        self.accountRef = accountRef
        self.current = current
        self.currentFetchedAtMs = currentFetchedAtMs
        self.pendingError = pendingError
    }
}

/// Fully projected per-account state.
public struct AccountSnapshot: Equatable, Sendable {
    public let providerId: String
    public let accountRef: String
    public let rows: [QuotaRow]
    public let freshness: QuotaFreshness?
    public let error: BridgeServiceError?
}

public struct QuotaProjector: Sendable {
    /// Default refresh interval (plan: 900s with ±25% jitter upstream in the
    /// coordinator). At exactly this age a report is due, hence stale.
    public static let defaultRefreshIntervalMs: Int64 = 900_000
    /// Last-good retention window measured from the original fetch time.
    public static let lastGoodRetentionMs: Int64 = 86_400_000

    public init() {}

    /// One independent row per limit. Never merges windows sharing a unit.
    public func rows(for report: UsageReport, nowMs: Int64) -> [QuotaRow] {
        report.limits.map { limit in
            QuotaRow(
                limitId: limit.limitId,
                productKind: limit.productKind,
                unit: limit.unit,
                severity: QuotaSeverity.resolve(fraction: limit.utilization.fraction, unit: limit.unit),
                fraction: limit.utilization.fraction,
                used: limit.utilization.used,
                limit: limit.utilization.limit,
                resetsInMs: limit.resetsAtMs.map { $0 - nowMs },
                windowSeconds: limit.windowSeconds,
                label: limit.label
            )
        }
    }

    /// Freshness boundaries for a report with no pending error: fresh below
    /// the 900s refresh interval, stale through exactly 24h from the
    /// original fetch, expired past it.
    public func freshness(fetchedAtMs: Int64, nowMs: Int64) -> QuotaFreshness {
        let age = nowMs - fetchedAtMs
        if age > Self.lastGoodRetentionMs { return .expired }
        if age >= Self.defaultRefreshIntervalMs { return .stale(lastGoodAtMs: fetchedAtMs) }
        return .fresh(fetchedAtMs: fetchedAtMs)
    }

    /// Projects one account. A pending error keeps last-good rows visible but
    /// marks them stale — the data is not current. Expired last-good data is
    /// never displayed. With no report at all the state is idle (nil
    /// freshness), even when an error is pending.
    public func project(_ input: AccountSnapshotInput, nowMs: Int64) -> AccountSnapshot {
        guard let report = input.current else {
            return AccountSnapshot(
                providerId: input.providerId,
                accountRef: input.accountRef,
                rows: [],
                freshness: nil,
                error: input.pendingError
            )
        }
        let fetchedAtMs = input.currentFetchedAtMs ?? report.fetchedAtMs
        let base = freshness(fetchedAtMs: fetchedAtMs, nowMs: nowMs)
        if case .expired = base {
            return AccountSnapshot(
                providerId: input.providerId,
                accountRef: input.accountRef,
                rows: [],
                freshness: .expired,
                error: input.pendingError
            )
        }
        let freshness: QuotaFreshness
        if input.pendingError != nil, case let .fresh(fetchedAtMs) = base {
            freshness = .stale(lastGoodAtMs: fetchedAtMs)
        } else {
            freshness = base
        }
        return AccountSnapshot(
            providerId: input.providerId,
            accountRef: input.accountRef,
            rows: rows(for: report, nowMs: nowMs),
            freshness: freshness,
            error: input.pendingError
        )
    }
}
