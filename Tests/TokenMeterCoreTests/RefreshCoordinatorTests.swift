// RED contract: refresh scheduling, caching and backoff (plan criterion 4).
//
// Deterministic by construction: wall clock, jitter randomness and the
// fetcher are all injected; concurrency is observed through continuation-gated
// events, never through sleeps or polling.
//
// Pinned decisions from the plan:
//   - default refresh 900s with injected ±25% jitter:
//       interval = 900 * (0.75 + 0.5 * u), u ∈ [0, 1)
//   - 24h last-good retention measured from the ORIGINAL fetch time;
//     failures never extend it
//   - transient backoff 10s doubling, capped at 900s, jittered
//   - 401/ordinary 403 (authRequired): purge cache and suspend until the
//     credential revision changes
//   - 429/rate-limit 403: preserve last-good and obey retryAfterMs exactly
//     (maxBackoffSeconds when absent)
//   - manual refresh joins the in-flight single-flight and never bypasses
//     retry deadlines or auth suspension
import XCTest
import Foundation
@testable import TokenMeterCore

final class RefreshCoordinatorTests: XCTestCase {

    private let key = AccountKey(providerId: "fixture", accountRef: testAccountRef)

    private func makeCoordinator(
        clock: ManualClock,
        jitter: ManualJitter,
        script: FetchScript,
        onFlightJoin: @escaping @Sendable (AccountKey) -> Void = { _ in }
    ) -> RefreshCoordinator {
        RefreshCoordinator(
            clock: clock,
            jitter: jitter,
            fetcher: { job in await script.fetch(job) },
            onFlightJoin: onFlightJoin
        )
    }

    // MARK: - Single-flight

    func testConcurrentManualRefreshesJoinASingleFlight() async {
        let clock = ManualClock(nowMs: testNowMs)
        let script = FetchScript()
        let (joins, joinContinuation) = AsyncStream<AccountKey>.makeStream()
        var joinIterator = joins.makeAsyncIterator()
        let coordinator = makeCoordinator(
            clock: clock,
            jitter: ManualJitter(fallback: 0.5),
            script: script,
            onFlightJoin: { joinContinuation.yield($0) }
        )
        let report = makeReport(limits: [
            makeLimit(limitId: "fixture:5h", unit: .requests, fraction: 0.125),
        ])
        // Two identical outcomes so a broken (non-single-flight) implementation
        // is discriminated purely by the call count, not by divergent results.
        await script.enqueue(.report(report))
        await script.enqueue(.report(report))
        await script.holdSubsequentCalls()

        async let first = coordinator.refreshNow(
            key: key, connectorId: "fixture", credentialRevision: 1
        )
        let firstCallArrived = await script.waitForCallCount(1)
        XCTAssertTrue(firstCallArrived, "refreshNow must invoke the injected fetcher")

        async let second = coordinator.refreshNow(
            key: key, connectorId: "fixture", credentialRevision: 1
        )
        let joinedKey = await joinIterator.next()
        XCTAssertEqual(joinedKey, key)
        await script.releaseHeldCalls()
        joinContinuation.finish()

        let (stateA, stateB) = await (first, second)
        let callCount = await script.callCount()
        XCTAssertEqual(callCount, 1, "concurrent manual refreshes must share one fetch")
        XCTAssertEqual(stateA, stateB)
        XCTAssertEqual(stateA.rows.count, 1)
        XCTAssertEqual(stateA.error, nil)
        let calls = await script.receivedCalls
        XCTAssertEqual(calls.map(\.accountKey), [key])
        XCTAssertEqual(calls.map(\.credentialRevision), [1])
    }

    // MARK: - Scheduling with jitter

    func testSuccessSchedulesJitteredDefaultIntervalAndSkipsBeforeDeadline() async {
        let clock = ManualClock(nowMs: testNowMs)
        let script = FetchScript()
        let coordinator = makeCoordinator(
            clock: clock,
            jitter: ManualJitter(values: [0.0, 0.25, 0.5, 0.75, 1.0]),
            script: script
        )
        let report = makeReport(limits: [
            makeLimit(limitId: "fixture:5h", unit: .requests, fraction: 0.1),
        ])
        // 900s * (0.75 + 0.5*u) for u = 0, 0.25, 0.5, 0.75, 1.0
        let deltas: [Int64] = [675_000, 787_500, 900_000, 1_012_500, 1_125_000]
        for _ in deltas { await script.enqueue(.report(report)) }

        let state = await coordinator.refreshNow(
            key: key, connectorId: "fixture", credentialRevision: 1
        )
        XCTAssertEqual(state.rows.count, 1)

        var due = testNowMs + deltas[0]
        let firstDue = await coordinator.nextDueMs(for: key)
        XCTAssertEqual(firstDue, due)

        // Not due yet at the same instant: no fetch, no state change.
        let skipped = await coordinator.refreshIfDue(
            key: key, connectorId: "fixture", credentialRevision: 1
        )
        XCTAssertNil(skipped)
        let idleCallCount = await script.callCount()
        XCTAssertEqual(idleCallCount, 1)

        for delta in deltas.dropFirst() {
            clock.advance(byMilliseconds: due - clock.nowMs())
            let advanced = await coordinator.refreshIfDue(
                key: key, connectorId: "fixture", credentialRevision: 1
            )
            XCTAssertNotNil(advanced)
            due += delta
            let nextDue = await coordinator.nextDueMs(for: key)
            XCTAssertEqual(nextDue, due)
        }
    }

    // MARK: - Transient backoff

    func testTransientFailuresBackOffExponentiallyAndCapAtMaxBackoff() async {
        let clock = ManualClock(nowMs: testNowMs)
        let script = FetchScript()
        // fallback jitter 0.5 -> factor exactly 1.0, so delays are the pure
        // 10s, 20s, 40s ... sequence capped at 900s.
        let coordinator = makeCoordinator(
            clock: clock,
            jitter: ManualJitter(fallback: 0.5),
            script: script
        )
        let expectedDelays: [Int64] = [
            10_000, 20_000, 40_000, 80_000, 160_000, 320_000, 640_000, 900_000,
        ]
        for _ in expectedDelays { await script.enqueue(.failed(.transport("boom"))) }

        let first = await coordinator.refreshNow(
            key: key, connectorId: "fixture", credentialRevision: 1
        )
        XCTAssertEqual(first.error, .transport("boom"))
        XCTAssertEqual(first.rows, [])

        var due = testNowMs + expectedDelays[0]
        let afterFirst = await coordinator.nextDueMs(for: key)
        XCTAssertEqual(afterFirst, due)

        for delay in expectedDelays.dropFirst() {
            clock.advance(byMilliseconds: due - clock.nowMs())
            let state = await coordinator.refreshIfDue(
                key: key, connectorId: "fixture", credentialRevision: 1
            )
            XCTAssertEqual(state?.error, .transport("boom"))
            due += delay
            let nextDue = await coordinator.nextDueMs(for: key)
            XCTAssertEqual(nextDue, due)
        }

        // A success resets the backoff sequence and returns to the default
        // (jitter factor 1.0) refresh interval.
        let report = makeReport(fetchedAtMs: due, limits: [
            makeLimit(limitId: "fixture:5h", unit: .requests, fraction: 0.1),
        ])
        await script.enqueue(.report(report))
        clock.advance(byMilliseconds: due - clock.nowMs())
        let recovered = await coordinator.refreshIfDue(
            key: key, connectorId: "fixture", credentialRevision: 1
        )
        XCTAssertNil(recovered?.error)
        XCTAssertEqual(recovered?.rows.isEmpty, false)
        let nextDue = await coordinator.nextDueMs(for: key)
        XCTAssertEqual(nextDue, due + 900_000)
    }

    // MARK: - Last-good retention

    func testLastGoodIsRetainedForTwentyFourHoursFromOriginalFetchOnly() async {
        let clock = ManualClock(nowMs: testNowMs)
        let script = FetchScript()
        let coordinator = makeCoordinator(
            clock: clock,
            jitter: ManualJitter(values: [0.0]),
            script: script
        )
        let report = makeReport(limits: [
            makeLimit(limitId: "fixture:5h", unit: .requests, fraction: 0.3),
        ])
        await script.enqueue(.report(report))
        _ = await coordinator.refreshNow(key: key, connectorId: "fixture", credentialRevision: 1)
        let dueAfterSuccess = await coordinator.nextDueMs(for: key)
        XCTAssertEqual(dueAfterSuccess, testNowMs + 675_000)

        // A failure at the next due time must not extend the retention window.
        await script.enqueue(.failed(.transport("boom")))
        clock.advance(byMilliseconds: 675_000)
        _ = await coordinator.refreshIfDue(key: key, connectorId: "fixture", credentialRevision: 1)

        let failedState = await coordinator.snapshot(for: key)
        XCTAssertEqual(failedState?.rows.count, 1, "failures keep showing last-good values")
        XCTAssertEqual(failedState?.freshness, .stale(lastGoodAtMs: testNowMs))
        XCTAssertEqual(failedState?.error, .transport("boom"))

        // 23h after the ORIGINAL fetch: still retained, still measured from T0.
        clock.advance(byMilliseconds: 23 * 3_600_000 - 675_000)
        let at23h = await coordinator.snapshot(for: key)
        XCTAssertEqual(at23h?.rows.count, 1)
        XCTAssertEqual(at23h?.freshness, .stale(lastGoodAtMs: testNowMs))

        // Exactly 24h: last day of retention.
        clock.advance(byMilliseconds: 3_600_000)
        let at24h = await coordinator.snapshot(for: key)
        XCTAssertEqual(at24h?.freshness, .stale(lastGoodAtMs: testNowMs))

        // One millisecond past 24h from the original fetch: expired.
        clock.advance(byMilliseconds: 1)
        let expired = await coordinator.snapshot(for: key)
        XCTAssertEqual(expired?.freshness, .expired)
        XCTAssertEqual(expired?.rows, [])
    }

    // MARK: - Rate limiting

    func testRateLimitPreservesLastGoodAndObeysRetryAfterExactly() async {
        let clock = ManualClock(nowMs: testNowMs)
        let script = FetchScript()
        let coordinator = makeCoordinator(
            clock: clock,
            jitter: ManualJitter(values: [0.0]),
            script: script
        )
        let report = makeReport(limits: [
            makeLimit(limitId: "fixture:5h", unit: .requests, fraction: 0.3),
        ])
        await script.enqueue(.report(report))
        _ = await coordinator.refreshNow(key: key, connectorId: "fixture", credentialRevision: 1)

        let failureTime = testNowMs + 675_000
        await script.enqueue(.failed(.rateLimited(retryAfterMs: 30_000)))
        clock.advance(byMilliseconds: 675_000)
        _ = await coordinator.refreshIfDue(key: key, connectorId: "fixture", credentialRevision: 1)

        // Retry-After is honored exactly, with no jitter applied.
        let due = await coordinator.nextDueMs(for: key)
        XCTAssertEqual(due, failureTime + 30_000)

        let state = await coordinator.snapshot(for: key)
        XCTAssertEqual(state?.rows.count, 1, "429 must preserve last-good")
        XCTAssertEqual(state?.freshness, .stale(lastGoodAtMs: testNowMs))
        XCTAssertEqual(state?.error, .rateLimited(retryAfterMs: 30_000))

        // A manual refresh before the deadline must not bypass the deadline.
        let manual = await coordinator.refreshNow(
            key: key, connectorId: "fixture", credentialRevision: 1
        )
        let callsBeforeDeadline = await script.callCount()
        XCTAssertEqual(callsBeforeDeadline, 2)
        XCTAssertEqual(manual.rows.count, 1)
        XCTAssertEqual(manual.error, .rateLimited(retryAfterMs: 30_000))

        // At the deadline the scheduled refresh proceeds.
        let recovered = makeReport(fetchedAtMs: failureTime + 30_000, limits: [
            makeLimit(limitId: "fixture:5h", unit: .requests, fraction: 0.2),
        ])
        await script.enqueue(.report(recovered))
        clock.advance(byMilliseconds: 30_000)
        let refreshed = await coordinator.refreshIfDue(
            key: key, connectorId: "fixture", credentialRevision: 1
        )
        let callsAfterDeadline = await script.callCount()
        XCTAssertEqual(callsAfterDeadline, 3)
        XCTAssertEqual(refreshed?.error, nil)
        XCTAssertEqual(refreshed?.freshness, .fresh(fetchedAtMs: failureTime + 30_000))
    }

    func testRateLimitWithoutRetryAfterFallsBackToMaxBackoff() async {
        let clock = ManualClock(nowMs: testNowMs)
        let script = FetchScript()
        let coordinator = makeCoordinator(
            clock: clock,
            jitter: ManualJitter(values: [0.0]),
            script: script
        )
        let report = makeReport(limits: [
            makeLimit(limitId: "fixture:5h", unit: .requests, fraction: 0.3),
        ])
        await script.enqueue(.report(report))
        _ = await coordinator.refreshNow(key: key, connectorId: "fixture", credentialRevision: 1)

        let failureTime = testNowMs + 675_000
        await script.enqueue(.failed(.rateLimited(retryAfterMs: nil)))
        clock.advance(byMilliseconds: 675_000)
        _ = await coordinator.refreshIfDue(key: key, connectorId: "fixture", credentialRevision: 1)

        let due = await coordinator.nextDueMs(for: key)
        XCTAssertEqual(due, failureTime + 900_000)
    }

    // MARK: - Auth suspension

    func testAuthRequiredPurgesCacheAndSuspendsUntilCredentialRevisionChanges() async {
        let clock = ManualClock(nowMs: testNowMs)
        let script = FetchScript()
        let coordinator = makeCoordinator(
            clock: clock,
            jitter: ManualJitter(values: [0.0]),
            script: script
        )
        let report = makeReport(limits: [
            makeLimit(limitId: "fixture:5h", unit: .requests, fraction: 0.3),
        ])
        await script.enqueue(.report(report))
        _ = await coordinator.refreshNow(key: key, connectorId: "fixture", credentialRevision: 1)

        let failureTime = testNowMs + 675_000
        await script.enqueue(.failed(.authRequired))
        clock.advance(byMilliseconds: 675_000)
        _ = await coordinator.refreshIfDue(key: key, connectorId: "fixture", credentialRevision: 1)

        // 401 purges the cache entirely and suspends scheduling.
        let purged = await coordinator.snapshot(for: key)
        XCTAssertEqual(purged?.rows, [])
        XCTAssertNil(purged?.freshness)
        XCTAssertEqual(purged?.error, .authRequired)
        let suspendedDue = await coordinator.nextDueMs(for: key)
        XCTAssertNil(suspendedDue)

        // Manual refresh with the SAME credential revision is suspended too.
        let blocked = await coordinator.refreshNow(
            key: key, connectorId: "fixture", credentialRevision: 1
        )
        let callsWhileSuspended = await script.callCount()
        XCTAssertEqual(callsWhileSuspended, 2)
        XCTAssertEqual(blocked.rows, [])
        XCTAssertEqual(blocked.error, .authRequired)

        // A credential revision change lifts the suspension.
        let recovered = makeReport(fetchedAtMs: failureTime, limits: [
            makeLimit(limitId: "fixture:5h", unit: .requests, fraction: 0.1),
        ])
        await script.enqueue(.report(recovered))
        let state = await coordinator.refreshNow(
            key: key, connectorId: "fixture", credentialRevision: 2
        )
        let callsAfterRevisionChange = await script.callCount()
        XCTAssertEqual(callsAfterRevisionChange, 3)
        XCTAssertEqual(state.rows.count, 1)
        XCTAssertEqual(state.freshness, .fresh(fetchedAtMs: failureTime))
        XCTAssertNil(state.error)
    }

    // MARK: - Unknown accounts

    func testSnapshotForUntouchedAccountIsNil() async {
        let clock = ManualClock(nowMs: testNowMs)
        let script = FetchScript()
        let coordinator = makeCoordinator(
            clock: clock,
            jitter: ManualJitter(fallback: 0.5),
            script: script
        )
        let unknown = AccountKey(providerId: "anthropic", accountRef: testAccountRef)
        let snapshot = await coordinator.snapshot(for: unknown)
        XCTAssertNil(snapshot)
        let due = await coordinator.nextDueMs(for: unknown)
        XCTAssertNil(due)
    }
}
