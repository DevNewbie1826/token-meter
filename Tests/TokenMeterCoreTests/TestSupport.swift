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
        schemaVersion: "1.3.0",
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
    schemaVersion: String = "1.3.0",
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
        for key in ["label", "used", "limit", "remaining", "remainingFraction", "resetsAtMs", "resetCredits"] {
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
            "used", "limit", "remaining", "resetsAtMs", "resetCredits",
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
        "schemaVersion": "1.3.0",
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


// Raw wire fixtures deliberately do not normalize utilization before decoding.
func rawUsageResponseData(
    windows: [[String: Any]],
    overrides: [String: Any] = [:],
    rotation: BridgeCredential? = nil
) throws -> Data {
    var envelope = try jsonObject(from: usageResponseData(limits: []))
    var report = envelope["report"] as! [String: Any]
    report["windows"] = windows
    envelope["report"] = report
    if let rotation {
        envelope["refreshedCredential"] = try jsonObject(from: JSONEncoder().encode(rotation))
    }
    envelope.merge(overrides) { _, new in new }
    return try JSONSerialization.data(withJSONObject: envelope, options: [.sortedKeys])
}

// Shared raw counterexamples exercise exactly the same bytes directly and over stdin.
func decoderBoundaryRejections(rotation: BridgeCredential) throws -> [(String, Data, String)] {
    let marker = rotation.secret
    let base = try jsonObject(from: usageErrorData(code: "upstreamError", refreshedCredential: rotation))
    var cases: [(String, Data, String)] = []
    for (name, changes, code): (String, [String: Any], String) in [
        ("unknown-key", [marker: true], "invalidProtocol"),
        ("unknown-status", ["status": marker], "invalidProtocol"),
        ("unknown-schema", ["schemaVersion": marker], "invalidProtocol"),
        ("unknown-error-kind", ["error": ["kind": marker, "message": marker]], "malformedPayload"),
        ("unknown-error-key", ["error": ["kind": "upstreamError", "message": marker, marker: true]], "invalidProtocol"),
        ("invalid-rotation", ["refreshedCredential": ["kind": "oauth", "secret": marker], marker: true], "invalidProtocol"),
    ] {
        var object = base
        object.merge(changes) { _, new in new }
        cases.append((name, try JSONSerialization.data(withJSONObject: object), code))
    }
    for key in ["requestId", "providerId", "connectorId", "accountRef"] {
        for (variant, value): (String, Any?) in [
            ("wrong", "unrelated"), ("missing", nil), ("null", NSNull()),
            ("number", 1), ("empty", ""), ("array", ["fixture"]),
        ] {
            var object = base
            object[key] = value
            cases.append(("\(key)-\(variant)", try JSONSerialization.data(withJSONObject: object), "invalidProtocol"))
        }
    }
    return cases
}

// Literal JSON fragments preserve invalid types, numeric spellings and nonfinite
// tokens through both decoders and the process boundary; no fixture normalization.
func invalidTypedErrorPayloads(message: String) throws -> [(name: String, payload: String?, code: String)] {
    let messageJSON = String(decoding: try JSONEncoder().encode(message), as: UTF8.self)
    var cases: [(name: String, payload: String?, code: String)] = []
    for (name, value): (String, String?) in [
        ("absent", nil), ("null", "null"), ("number", "42"), ("empty", "\"\""),
        ("bool", "true"), ("array", "[]"), ("object", "{}"),
    ] {
        let field = value.map { ",\"message\":\($0)" } ?? ""
        cases.append(("message-\(name)", "{\"kind\":\"upstreamError\"\(field)}", "invalidProtocol"))
        let kind = value.map { "\"kind\":\($0)," } ?? ""
        cases.append(("kind-\(name)", "{\(kind)\"message\":\(messageJSON)}", "invalidProtocol"))
    }
    for (name, value): (String, String?) in [
        ("absent", nil), ("null", "null"), ("number", "42"), ("string", #""failure""#),
        ("bool", "false"), ("array", "[]"),
    ] {
        cases.append(("payload-\(name)", value, "invalidProtocol"))
    }
    cases.append(("kind-unknown", "{\"kind\":\"unknown\",\"message\":\(messageJSON)}", "malformedPayload"))
    cases.append(("payload-unknown-key", "{\"kind\":\"upstreamError\",\"message\":\(messageJSON),\"extra\":0}", "invalidProtocol"))
    for (name, value) in [
        ("negative", "-1"), ("fractional", "0.5"), ("negative-fractional", "-0.5"),
        ("near-integer", "1.0000000000000002"), ("null", "null"),
        ("true", "true"), ("false", "false"), ("string", #""0""#),
        ("array", "[]"), ("object", "{}"),
        ("int-overflow", "9223372036854775808"), ("uint-max", "18446744073709551615"),
        ("uint-overflow", "18446744073709551616"), ("huge-finite", "1e308"),
        ("int-min", "-9223372036854775808"), ("int-underflow", "-9223372036854775809"),
        ("positive-infinity", "1e309"), ("negative-infinity", "-1e309"),
        ("nan-token", "NaN"), ("infinity-token", "Infinity"),
    ] {
        // Even taxonomy cases that drop retry metadata must validate it first.
        for kind in ["rateLimited", "upstreamError", "timeout"] {
            cases.append(("\(kind)-retry-\(name)",
                          "{\"kind\":\"\(kind)\",\"message\":\(messageJSON),\"retryAfterMs\":\(value)}",
                          "invalidProtocol"))
        }
    }
    return cases
}

func validTypedErrorPayloads() -> [(name: String, payload: String, code: String, retry: Int?)] {
    var cases: [(name: String, payload: String, code: String, retry: Int?)] = []
    for kind in [
        "invalidRequest", "invalidProtocol", "invalidProvider", "invalidPolicy",
        "missingCredential", "authRequired", "permissionDenied", "rateLimited",
        "noData", "transport", "timeout", "malformedPayload", "partialPayload",
        "upstreamError", "dependencyUnavailable", "internalError",
    ] {
        cases.append(("\(kind)-omitted-retry", "{\"kind\":\"\(kind)\",\"message\":\"failure\"}", kind, nil))
        cases.append(("\(kind)-whitespace-zero", "{\"kind\":\"\(kind)\",\"message\":\" \\t\\n\",\"retryAfterMs\":0}", kind, 0))
    }
    for (name, token, expected): (String, String, Int) in [
        ("negative-zero", "-0", 0), ("decimal-zero", "0.0", 0), ("one", "1", 1),
        ("decimal-integer", "1.0", 1), ("exponent-integer", "3e4", 30_000),
        ("beyond-double-exact", "9007199254740993", 9_007_199_254_740_993),
        ("large-exponent", "1e18", 1_000_000_000_000_000_000),
        ("int-max-minus-one", "9223372036854775806", Int.max - 1),
        ("int-max", "9223372036854775807", Int.max),
    ] {
        cases.append(("retry-\(name)", "{\"kind\":\"rateLimited\",\"message\":\"failure\",\"retryAfterMs\":\(token)}", "rateLimited", expected))
    }
    return cases
}

func rawTypedErrorResponseData(_ payload: String?, rotation: BridgeCredential? = nil, login: Bool = false) throws -> Data {
    let identities = login ? "" : "\"requestId\":\"\(testRequestId)\",\"connectorId\":\"fixture\",\"accountRef\":\"\(testAccountRef)\","
    let errorField = payload.map { ",\"error\":\($0)" } ?? ""
    let rotationField = try rotation.map {
        ",\"refreshedCredential\":" + String(decoding: try JSONEncoder().encode($0), as: UTF8.self)
    } ?? ""
    return Data("{\"schemaVersion\":\"1.3.0\",\(identities)\"providerId\":\"fixture\",\"status\":\"error\",\"completedAtMs\":\(testNowMs)\(errorField)\(rotationField)}".utf8)
}

func decodeBoundaryResponse(_ data: Data, correlated: Bool = true) throws -> UsageResponse {
    try UsageResponseDecoder().decode(
        data, expectingRequestId: correlated ? testRequestId : nil,
        expectingProviderId: correlated ? "fixture" : nil,
        expectingConnectorId: correlated ? "fixture" : nil,
        expectingAccountRef: correlated ? testAccountRef : nil
    )
}

func assertBoundaryFailure(
    _ body: () throws -> UsageResponse,
    code: String,
    secrets: [String],
    rotation: BridgeCredential? = nil,
    scenario: String,
    file: StaticString = #filePath,
    line: UInt = #line
) {
    let failure: BridgeServiceError
    do {
        guard case .failure(let error) = try body() else {
            return XCTFail("accepted rejected response: \(scenario)", file: file, line: line)
        }
        failure = error
    } catch let error as BridgeServiceError {
        failure = error
    } catch {
        return XCTFail("untyped decoder failure: \(scenario)", file: file, line: line)
    }
    XCTAssertEqual(failure.wireCode, code, scenario, file: file, line: line)
    // Boolean comparisons never print a credential on RED.
    XCTAssertTrue(failure.refreshedCredential == rotation, "rotation authorization: \(scenario)", file: file, line: line)
    for secret in secrets {
        XCTAssertFalse(failure.wireMessage?.contains(secret) == true, "diagnostic disclosure: \(scenario)", file: file, line: line)
    }
}
