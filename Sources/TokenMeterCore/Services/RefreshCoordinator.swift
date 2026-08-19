// Deterministic refresh scheduling, caching and backoff (plan criterion 4).
//
// Pinned decisions (plan: "Cache/scheduler decisions"):
//   - default refresh 900s with injected ±25% jitter:
//       interval = 900s * (0.75 + 0.5 * u), u ∈ [0, 1)
//   - 24h last-good retention measured from the ORIGINAL fetch time
//     (`UsageReport.fetchedAtMs`); failures never extend it
//   - transient backoff 10s doubling, capped at 900s, jittered with the same
//     factor formula; a success resets the sequence
//   - 401/ordinary 403 (authRequired-class): purge cached last-good and
//     suspend until the credential revision changes
//   - 429/rate-limit 403: preserve last-good and obey `retryAfterMs` exactly
//     (backoff cap when absent), with no jitter applied
//   - manual refresh joins the in-flight single-flight and never bypasses
//     auth suspension or retry deadlines; it may only bypass the ordinary
//     success interval, because forcing a refresh of good credentials is the
//     entire point of a manual refresh
//
// Determinism: wall clock, jitter randomness and the fetcher are injected.
// The single-flight task runs detached so user fetch closures never occupy
// the actor, and state is committed back on the actor.
import Foundation

public protocol WallClock: Sendable {
    func nowMs() -> Int64
}

public protocol JitterSource: Sendable {
    /// Next draw from the unit interval [0, 1).
    func nextUnitInterval() -> Double
}

public struct AccountKey: Equatable, Hashable, Sendable {
    public let providerId: String
    public let accountRef: String

    public init(providerId: String, accountRef: String) {
        self.providerId = providerId
        self.accountRef = accountRef
    }
}

/// One fetch the coordinator wants performed on its behalf.
public struct FetchJob: Equatable, Sendable {
    public let accountKey: AccountKey
    public let connectorId: String
    public let credentialRevision: Int

    public init(accountKey: AccountKey, connectorId: String, credentialRevision: Int) {
        self.accountKey = accountKey
        self.connectorId = connectorId
        self.credentialRevision = credentialRevision
    }
}

public enum FetchOutcome: Equatable, Sendable {
    case report(UsageReport)
    case failed(BridgeServiceError)
}

public actor RefreshCoordinator {
    /// Default refresh interval for supported connectors.
    public static let defaultRefreshIntervalMs: Int64 = 900_000
    /// ±25% jitter ratio.
    public static let jitterRatio: Double = 0.25
    /// First transient backoff delay.
    public static let transientBackoffBaseMs: Int64 = 10_000
    /// Backoff (and Retry-After-less rate-limit) cap.
    public static let transientBackoffCapMs: Int64 = 900_000

    private enum DueKind {
        /// Next scheduled refresh after a success; manual refresh may force.
        case scheduled
        /// Transient failure backoff; manual refresh must not bypass.
        case retry
        /// Rate-limit deadline; manual refresh must not bypass.
        case rateLimit
    }

    private struct AccountState {
        var lastGood: UsageReport?
        var pendingError: BridgeServiceError?
        var dueAtMs: Int64?
        var dueKind: DueKind?
        var consecutiveTransientFailures = 0
        /// Credential revision under which refreshing is suspended
        /// (authRequired-class errors). Nil when not suspended.
        var suspendedCredentialRevision: Int?
    }

    private let clock: WallClock
    private let jitter: JitterSource
    private let fetcher: @Sendable (FetchJob) async -> FetchOutcome
    private let onFlightJoin: @Sendable (AccountKey) -> Void
    private let projector = QuotaProjector()
    private var states: [AccountKey: AccountState] = [:]
    private var flights: [AccountKey: Task<AccountSnapshot, Never>] = [:]

    public init(
        clock: WallClock,
        jitter: JitterSource,
        fetcher: @escaping @Sendable (FetchJob) async -> FetchOutcome,
        onFlightJoin: @escaping @Sendable (AccountKey) -> Void = { _ in }
    ) {
        self.clock = clock
        self.jitter = jitter
        self.fetcher = fetcher
        self.onFlightJoin = onFlightJoin
    }

    // MARK: - Public surface

    /// Manual refresh. Joins any in-flight fetch for the account (single
    /// flight), never bypasses auth suspension or retry/rate-limit
    /// deadlines, and otherwise forces a fetch now.
    public func refreshNow(
        key: AccountKey,
        connectorId: String,
        credentialRevision: Int
    ) async -> AccountSnapshot {
        if let flight = flights[key] {
            onFlightJoin(key)
            return await flight.value
        }
        var state = states[key] ?? AccountState()
        if let suspendedRevision = state.suspendedCredentialRevision {
            guard suspendedRevision != credentialRevision else {
                return snapshot(of: state, key: key)
            }
            // The credential changed: lift the suspension and fetch.
            state.suspendedCredentialRevision = nil
            state.pendingError = nil
            states[key] = state
        }
        if let due = state.dueAtMs,
           state.dueKind != .scheduled,
           clock.nowMs() < due {
            return snapshot(of: state, key: key)
        }
        let flight = startFlight(key: key, connectorId: connectorId, credentialRevision: credentialRevision)
        return await flight.value
    }

    /// Scheduled refresh. Returns nil (and performs no fetch) when the
    /// account is unknown, suspended, or not yet due.
    public func refreshIfDue(
        key: AccountKey,
        connectorId: String,
        credentialRevision: Int
    ) async -> AccountSnapshot? {
        if let flight = flights[key] {
            onFlightJoin(key)
            return await flight.value
        }
        guard let state = states[key],
              let due = state.dueAtMs,
              clock.nowMs() >= due else {
            return nil
        }
        let flight = startFlight(key: key, connectorId: connectorId, credentialRevision: credentialRevision)
        return await flight.value
    }

    /// Next scheduled refresh deadline, if any.
    public func nextDueMs(for key: AccountKey) -> Int64? {
        states[key]?.dueAtMs
    }

    /// Current projected state for the account at the injected clock time,
    /// or nil for an account the coordinator has never touched.
    public func snapshot(for key: AccountKey) -> AccountSnapshot? {
        guard let state = states[key] else { return nil }
        return snapshot(of: state, key: key)
    }

    // MARK: - Flights

    private func startFlight(
        key: AccountKey,
        connectorId: String,
        credentialRevision: Int
    ) -> Task<AccountSnapshot, Never> {
        let job = FetchJob(accountKey: key, connectorId: connectorId, credentialRevision: credentialRevision)
        let fetcher = self.fetcher
        let task = Task.detached(priority: .utility) { [weak self] () -> AccountSnapshot in
            let outcome = await fetcher(job)
            guard let self else {
                return AccountSnapshot(
                    providerId: key.providerId,
                    accountRef: key.accountRef,
                    rows: [],
                    freshness: nil,
                    error: nil
                )
            }
            return await self.commit(outcome: outcome, key: key, credentialRevision: credentialRevision)
        }
        flights[key] = task
        return task
    }

    private func commit(
        outcome: FetchOutcome,
        key: AccountKey,
        credentialRevision: Int
    ) -> AccountSnapshot {
        let now = clock.nowMs()
        var state = states[key] ?? AccountState()
        defer {
            states[key] = state
            flights[key] = nil
        }
        switch outcome {
        case .report(let report):
            state.lastGood = report
            state.pendingError = nil
            state.consecutiveTransientFailures = 0
            state.suspendedCredentialRevision = nil
            state.dueAtMs = now + Self.jitteredIntervalMs(jitter: jitter)
            state.dueKind = .scheduled
        case .failed(let error):
            if error.suspendsUntilCredentialChange {
                // 401/ordinary 403: purge the cache and suspend scheduling.
                state.lastGood = nil
                state.pendingError = error
                state.dueAtMs = nil
                state.dueKind = nil
                state.consecutiveTransientFailures = 0
                state.suspendedCredentialRevision = credentialRevision
            } else if error.isRateLimited {
                // Preserve last-good and obey Retry-After exactly (cap when
                // absent); no jitter is applied to a rate-limit deadline.
                state.pendingError = error
                let delayMs: Int64 = {
                    if case .rateLimited(let retryAfterMs) = error {
                        return retryAfterMs.map { Int64(max(0, $0)) } ?? Self.transientBackoffCapMs
                    }
                    return Self.transientBackoffCapMs
                }()
                state.dueAtMs = now + delayMs
                state.dueKind = .rateLimit
            } else {
                state.pendingError = error
                state.consecutiveTransientFailures += 1
                state.dueAtMs = now + Self.transientBackoffMs(
                    consecutiveFailures: state.consecutiveTransientFailures,
                    jitter: jitter
                )
                state.dueKind = .retry
            }
        }
        return snapshot(of: state, key: key)
    }

    // MARK: - Projection

    private func snapshot(of state: AccountState, key: AccountKey) -> AccountSnapshot {
        projector.project(
            AccountSnapshotInput(
                providerId: key.providerId,
                accountRef: key.accountRef,
                current: state.lastGood,
                currentFetchedAtMs: state.lastGood?.fetchedAtMs,
                pendingError: state.pendingError
            ),
            nowMs: clock.nowMs()
        )
    }

    // MARK: - Interval math

    /// interval = base * (0.75 + 0.5 * u) for ±25% jitter around the base.
    private static func jitteredIntervalMs(jitter: JitterSource) -> Int64 {
        let factor = 1 - jitterRatio + (2 * jitterRatio * jitter.nextUnitInterval())
        return Int64((Double(defaultRefreshIntervalMs) * factor).rounded())
    }

    /// 10s doubling per consecutive transient failure, capped at 900s, with
    /// the same ±25% jitter factor applied and the cap enforced after
    /// jittering so 900s is a true maximum.
    private static func transientBackoffMs(consecutiveFailures: Int, jitter: JitterSource) -> Int64 {
        var base = transientBackoffBaseMs
        for _ in 1..<max(1, consecutiveFailures) {
            guard base < transientBackoffCapMs else { break }
            base = min(base * 2, transientBackoffCapMs)
        }
        let factor = 1 - jitterRatio + (2 * jitterRatio * jitter.nextUnitInterval())
        return min(Int64((Double(base) * factor).rounded()), transientBackoffCapMs)
    }
}
