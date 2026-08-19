// Shared deterministic test harness for the TokenMeterCore RED contracts.
//
// Discipline (plan criterion 4): all time, randomness and network are
// injected; there are no fixed sleeps, polling delays or wait-for-timeouts.
// Cross-task coordination uses checked continuations that resume only on
// actual events, so every await is causally ordered.
import Foundation
import XCTest
import TokenMeterCore

// MARK: - Shared constants

let testRequestId = "00000000-0000-4000-8000-000000000001"
let testAccountRef = "00000000-0000-4000-8000-000000000002"
let testNowMs: Int64 = 1_787_011_200_000

// MARK: - Injected clock

/// Deterministic wall clock. Tests advance it explicitly; production code
/// must only ever read `nowMs()`.
final class ManualClock: WallClock, @unchecked Sendable {
    private let lock = NSLock()
    private var currentMs: Int64

    init(nowMs: Int64) {
        self.currentMs = nowMs
    }

    func nowMs() -> Int64 {
        lock.lock()
        defer { lock.unlock() }
        return currentMs
    }

    func advance(byMilliseconds delta: Int64) {
        lock.lock()
        defer { lock.unlock() }
        currentMs += delta
    }
}

// MARK: - Injected randomness

/// Deterministic jitter source handing out queued unit-interval draws and
/// falling back to a fixed value once the queue is empty.
final class ManualJitter: JitterSource, @unchecked Sendable {
    private let lock = NSLock()
    private var queued: [Double]
    private let fallback: Double

    init(values: [Double] = [], fallback: Double = 0.5) {
        self.queued = values
        self.fallback = fallback
    }

    func nextUnitInterval() -> Double {
        lock.lock()
        defer { lock.unlock() }
        if queued.isEmpty { return fallback }
        return queued.removeFirst()
    }
}

// MARK: - Scripted fetcher

/// Scripted, observable fetch backend. Outcomes are consumed in order; calls
/// can be held via continuations so concurrent coordinator behavior is
//  observable without any real time passing.
actor FetchScript {
    private struct Waiter {
        let id: Int
        let count: Int
        let continuation: CheckedContinuation<Bool, Never>
        let watchdog: Task<Void, Never>
    }

    private var outcomes: [FetchOutcome] = []
    private var holdNewCalls = false
    private var held: [CheckedContinuation<FetchOutcome, Never>] = []
    private var waiters: [Waiter] = []
    private var waiterId = 0
    private var active = 0
    private(set) var receivedCalls: [FetchJob] = []
    private(set) var events: [String] = []
    private(set) var maxActive = 0

    func enqueue(_ outcome: FetchOutcome) {
        outcomes.append(outcome)
    }

    func holdSubsequentCalls() {
        holdNewCalls = true
    }

    func releaseHeldCalls() {
        events.append("release")
        holdNewCalls = false
        let toResume = held
        held = []
        for continuation in toResume {
            continuation.resume(returning: nextOutcome())
        }
    }

    private func nextOutcome() -> FetchOutcome {
        if outcomes.isEmpty { return .failed(.transport("fetch script exhausted")) }
        return outcomes.removeFirst()
    }

    func fetch(_ job: FetchJob) async -> FetchOutcome {
        receivedCalls.append(job)
        events.append("call:\(job.accountKey.accountRef)")
        active += 1
        maxActive = Swift.max(maxActive, active)
        resumeCallWaiters()

        let outcome: FetchOutcome
        if holdNewCalls {
            outcome = await withCheckedContinuation { continuation in
                held.append(continuation)
            }
        } else {
            outcome = nextOutcome()
        }
        active -= 1
        return outcome
    }

    /// Suspends until at least `count` fetch calls have started. Resumes only
    /// on real call events, never on a timer; a bounded watchdog converts a
    /// missing event (absent production behavior) into a fast failure instead
    /// of an indefinite hang.
    func waitForCallCount(_ count: Int, timeoutNanos: UInt64 = 10_000_000_000) async -> Bool {
        if receivedCalls.count >= count { return true }
        return await withCheckedContinuation { continuation in
            let nextWaiterId = waiterId
            waiterId += 1
            let watchdog = Task.detached { [weak self] in
                try? await Task.sleep(nanoseconds: timeoutNanos)
                await self?.completeWaiter(nextWaiterId, outcome: false)
            }
            waiters.append(Waiter(id: nextWaiterId, count: count, continuation: continuation, watchdog: watchdog))
        }
    }

    private func completeWaiter(_ waiterId: Int, outcome: Bool) {
        guard let index = waiters.firstIndex(where: { $0.id == waiterId }) else { return }
        let waiter = waiters.remove(at: index)
        waiter.watchdog.cancel()
        waiter.continuation.resume(returning: outcome)
    }

    private func resumeCallWaiters() {
        let satisfied = waiters.filter { receivedCalls.count >= $0.count }
        for waiter in satisfied {
            completeWaiter(waiter.id, outcome: true)
        }
    }

    func callCount() -> Int { receivedCalls.count }
    func recordedEvents() -> [String] { events }
    func maximumActiveCalls() -> Int { maxActive }
}

// MARK: - Domain fixture builders

func makeLimit(
    limitId: String,
    productKind: ProductKind = .quota,
    unit: UsageUnit,
    fraction: Double? = nil,
    used: Double? = nil,
    limit: Double? = nil,
    windowSeconds: Int64? = nil,
    resetsAtMs: Int64? = nil
) -> QuotaLimit {
    QuotaLimit(
        limitId: limitId,
        productKind: productKind,
        unit: unit,
        utilization: Utilization(fraction: fraction, used: used, limit: limit),
        windowSeconds: windowSeconds,
        resetsAtMs: resetsAtMs
    )
}

func makeReport(
    providerId: String = "fixture",
    connectorId: String = "fixture",
    accountRef: String = testAccountRef,
    fetchedAtMs: Int64 = testNowMs,
    limits: [QuotaLimit]
) -> UsageReport {
    UsageReport(
        schemaVersion: "1.2.0",
        requestId: testRequestId,
        providerId: providerId,
        connectorId: connectorId,
        accountRef: accountRef,
        fetchedAtMs: fetchedAtMs,
        limits: limits
    )
}

// MARK: - Wire fixture builders

func usageResponseData(
    schemaVersion: String = "1.2.0",
    requestId: String = testRequestId,
    fetchedAtMs: Int64 = testNowMs,
    limits: [[String: Any]],
    extraFields: [String: Any] = [:]
) throws -> Data {
    let productKind = limits.first?["productKind"] as? String ?? "quota"
    let windows: [[String: Any]] = limits.map { limit in
        func double(_ key: String) -> Double? {
            (limit[key] as? NSNumber)?.doubleValue
        }
        var window: [String: Any] = [
            "id": limit["limitId"] ?? "missing",
            "unit": limit["unit"] ?? "unknown",
        ]
        let resolvedFraction: Double? = {
            if let value = double("resolvedFraction") { return value }
            if let value = double("fraction") { return value }
            if let used = double("used"),
               let capacity = double("limit"),
               capacity != 0 {
                return used / capacity
            }
            if let percent = double("percentUsed") {
                return percent / 100
            }
            if let remaining = double("remainingFraction") {
                return 1 - remaining
            }
            return nil
        }()
        if let resolvedFraction {
            window["resolvedFraction"] = resolvedFraction
        }
        for key in ["label", "used", "limit", "resetsAtMs", "resetCredits"] {
            if let value = limit[key] {
                window[key] = value
            }
        }
        let severity: String = {
            guard let resolvedFraction else { return "unknown" }
            if resolvedFraction >= 1 { return "exhausted" }
            if resolvedFraction >= 0.95 { return "critical" }
            if resolvedFraction >= 0.8 { return "warning" }
            return "ok"
        }()
        window["severity"] = severity

        let consumedKeys: Set<String> = [
            "limitId", "productKind", "unit", "resolvedFraction", "fraction",
            "percentUsed", "remainingFraction", "windowSeconds", "label",
            "used", "limit", "resetsAtMs", "resetCredits",
        ]
        for (key, value) in limit where !consumedKeys.contains(key) {
            window[key] = value
        }
        return window
    }
    var object: [String: Any] = [
        "schemaVersion": schemaVersion,
        "requestId": requestId,
        "providerId": "fixture",
        "connectorId": "fixture",
        "accountRef": testAccountRef,
        "status": "ok",
        "completedAtMs": fetchedAtMs,
        "report": [
            "productKind": productKind,
            "sourceKind": "localObserved",
            "fetchedAtMs": fetchedAtMs,
            "connectorVersion": "fixture-test-1",
            "windows": windows,
        ],
    ]
    extraFields.forEach { object[$0.key] = $0.value }
    return try JSONSerialization.data(withJSONObject: object)
}

func usageErrorData(
    code: String,
    message: String = "upstream failure",
    retryAfterMs: Int? = nil,
    requestId: String = testRequestId,
    refreshedCredential: BridgeCredential? = nil,
    rawRefreshedCredential: Any? = nil
) throws -> Data {
    var errorObject: [String: Any] = ["kind": code, "message": message]
    if let retryAfterMs { errorObject["retryAfterMs"] = retryAfterMs }
    var envelope: [String: Any] = [
        "schemaVersion": "1.2.0",
        "requestId": requestId,
        "providerId": "fixture",
        "connectorId": "fixture",
        "accountRef": testAccountRef,
        "status": "error",
        "completedAtMs": testNowMs,
        "error": errorObject,
    ]
    if let refreshedCredential {
        envelope["refreshedCredential"] = try jsonObject(
            from: JSONEncoder().encode(refreshedCredential)
        )
    } else if let rawRefreshedCredential {
        envelope["refreshedCredential"] = rawRefreshedCredential
    }
    return try JSONSerialization.data(withJSONObject: envelope)
}

func jsonObject(from data: Data) throws -> [String: Any] {
    guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        throw NSError(domain: "token-meter-tests", code: 1, userInfo: [
            NSLocalizedDescriptionKey: "expected a JSON object"
        ])
    }
    return object
}

/// Recursively collects every key of a JSON object tree.
func collectJSONKeys(_ value: Any) -> Set<String> {
    switch value {
    case let dictionary as [String: Any]:
        var keys = Set(dictionary.keys)
        for nested in dictionary.values { keys.formUnion(collectJSONKeys(nested)) }
        return keys
    case let array as [Any]:
        var keys = Set<String>()
        for nested in array { keys.formUnion(collectJSONKeys(nested)) }
        return keys
    default:
        return []
    }
}

// MARK: - Temporary directories

func makeTempDirectory() -> URL {
    let url = FileManager.default.temporaryDirectory
        .appendingPathComponent("token-meter-tests-\(UUID().uuidString)")
    try! FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

// MARK: - Error expectations

/// Runs `body` and asserts it throws exactly the expected typed bridge error.
func expectBridgeError(
    _ expected: BridgeServiceError,
    file: StaticString = #filePath,
    line: UInt = #line,
    _ body: () throws -> Void
) {
    do {
        try body()
        XCTFail("expected \(expected) to be thrown", file: file, line: line)
    } catch let error as BridgeServiceError {
        XCTAssertEqual(error, expected, file: file, line: line)
    } catch {
        XCTFail("expected BridgeServiceError \(expected), got \(error)", file: file, line: line)
    }
}
