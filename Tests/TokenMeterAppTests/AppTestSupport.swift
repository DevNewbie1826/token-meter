import Foundation
import TokenMeterCore
@testable import TokenMeterApp

// Deterministic, network-free fakes for the app test target.
//
// Secret discipline: no secret value is ever placed in argv, the
// environment, an accessibility identifier or a failure message. Assertions
// that compare secrets use `XCTAssertTrue(a == b, "<label>")` so a failure
// prints only the label.

// MARK: - Credential store

/// Mirrors `AuthFileCredentialStore` semantics, including the honest
/// `none`-credential behavior: saving `none` removes the item and returns
/// revision 0, and a subsequent load reports no stored credential.
final class AppTestCredentialStore: CredentialStoreProtocol, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: StoredCredential] = [:]
    private var deletedStorage: [String] = []

    @discardableResult
    func save(credential: BridgeCredential, for accountRef: String) throws -> Int {
        lock.lock()
        defer { lock.unlock() }
        if credential == .none {
            values.removeValue(forKey: accountRef)
            return 0
        }
        let revision = (values[accountRef]?.revision ?? 0) + 1
        values[accountRef] = StoredCredential(credential: credential, revision: revision)
        return revision
    }

    func load(for accountRef: String) throws -> StoredCredential? {
        lock.lock()
        defer { lock.unlock() }
        return values[accountRef]
    }

    func delete(for accountRef: String) throws {
        lock.lock()
        defer { lock.unlock() }
        values.removeValue(forKey: accountRef)
        deletedStorage.append(accountRef)
    }

    func stored(for accountRef: String) -> StoredCredential? {
        lock.lock()
        defer { lock.unlock() }
        return values[accountRef]
    }

    var deleted: [String] {
        lock.lock()
        defer { lock.unlock() }
        return deletedStorage
    }
}

// MARK: - Login session

/// Duplex login-session double. Prepared events are yielded before the
/// outcome can run, and AsyncStream buffers yields made before consumption
/// starts, so ordering is deterministic without any sleeps.
final class AppTestLoginSession: BridgeLoginSession, @unchecked Sendable {
    struct PromptResponseRecord: Equatable {
        let id: String
        let value: String
    }

    /// The handle login-outcome closures drive the duplex flow with.
    protocol Control: Sendable {
        func emit(_ event: AuthEvent)
        func awaitResponse() async -> PromptResponseRecord?
        var recordedPromptResponses: [PromptResponseRecord] { get }
        var wasCancelled: Bool { get }
    }

    let events: AsyncStream<AuthEvent>
    let result: Task<LoginResult, Never>

    private let state: State

    init(
        preparedEvents: [AuthEvent] = [],
        outcome: @escaping (any Control) async -> LoginResult
    ) {
        let (stream, continuation) = AsyncStream<AuthEvent>.makeStream()
        self.events = stream
        let state = State(continuation: continuation)
        self.state = state
        self.result = Task {
            for event in preparedEvents {
                continuation.yield(event)
            }
            let outcomeResult = await outcome(state)
            continuation.finish()
            return outcomeResult
        }
    }

    var recordedPromptResponses: [PromptResponseRecord] {
        state.recordedPromptResponses
    }

    var wasCancelled: Bool {
        state.wasCancelled
    }

    func sendPromptResponse(id: String, value: String) {
        state.sendPromptResponse(id: id, value: value)
    }

    func cancel() {
        state.cancel()
    }

    /// Lock-protected duplex state. Extracted so the session can be fully
    /// initialized before the outcome task captures it.
    private final class State: Control, @unchecked Sendable {
        private let lock = NSLock()
        private let continuation: AsyncStream<AuthEvent>.Continuation
        private var responses: [PromptResponseRecord] = []
        private var cancelledFlag = false
        private var responseWaiters: [CheckedContinuation<PromptResponseRecord?, Never>] = []

        init(continuation: AsyncStream<AuthEvent>.Continuation) {
            self.continuation = continuation
        }

        func emit(_ event: AuthEvent) {
            continuation.yield(event)
        }

        /// Suspends until exactly one prompt response arrives, or until the
        /// session is cancelled (returns nil). Never time-based.
        func awaitResponse() async -> PromptResponseRecord? {
            await withCheckedContinuation { continuation in
                lock.lock()
                responseWaiters.append(continuation)
                lock.unlock()
            }
        }

        func sendPromptResponse(id: String, value: String) {
            lock.lock()
            let record = PromptResponseRecord(id: id, value: value)
            responses.append(record)
            let waiters = responseWaiters
            responseWaiters = []
            lock.unlock()
            for waiter in waiters {
                waiter.resume(returning: record)
            }
        }

        func cancel() {
            lock.lock()
            cancelledFlag = true
            let waiters = responseWaiters
            responseWaiters = []
            lock.unlock()
            for waiter in waiters {
                waiter.resume(returning: nil)
            }
        }

        var recordedPromptResponses: [PromptResponseRecord] {
            lock.lock()
            defer { lock.unlock() }
            return responses
        }

        var wasCancelled: Bool {
            lock.lock()
            defer { lock.unlock() }
            return cancelledFlag
        }
    }
}

// MARK: - Bridge

final class AppTestBridge: BridgeServing, @unchecked Sendable {
    private let lock = NSLock()
    private var usageRequestsStorage: [UsageRequest] = []
    private var loginRequestsStorage: [LoginRequest] = []

    var usageHandler: @Sendable (UsageRequest) -> UsageResponse = { request in
        .report(testReport(for: request))
    }
    var onUsage: (@Sendable () -> Void)?
    var initialLoginEvents: @Sendable (LoginRequest) -> [AuthEvent] = { _ in [] }
    var loginOutcome: (@Sendable (LoginRequest, any AppTestLoginSession.Control) async -> LoginResult)?

    var usageRequests: [UsageRequest] {
        lock.lock()
        defer { lock.unlock() }
        return usageRequestsStorage
    }

    var loginRequests: [LoginRequest] {
        lock.lock()
        defer { lock.unlock() }
        return loginRequestsStorage
    }

    func fetchUsage(_ request: UsageRequest) async -> UsageResponse {
        let (handler, callback) = recordUsage(request)
        callback?()
        return handler(request)
    }

    func login(request: LoginRequest) -> BridgeLoginSession {
        let (events, outcome) = recordLogin(request)
        return AppTestLoginSession(preparedEvents: events) { control in
            guard let outcome else {
                return .failure(.internalError("unstubbed login"))
            }
            return await outcome(request, control)
        }
    }

    /// Convenience for one-shot logins with no duplex prompting.
    func stubLoginOutcome(_ make: @escaping @Sendable (LoginRequest) -> LoginResult) {
        loginOutcome = { request, _ in make(request) }
    }

    // Locked accessors are extracted into synchronous helpers so no lock is
    // taken from an asynchronous context.

    private func recordUsage(
        _ request: UsageRequest
    ) -> (@Sendable (UsageRequest) -> UsageResponse, (@Sendable () -> Void)?) {
        lock.lock()
        defer { lock.unlock() }
        usageRequestsStorage.append(request)
        return (usageHandler, onUsage)
    }

    private func recordLogin(
        _ request: LoginRequest
    ) -> ([AuthEvent], (@Sendable (LoginRequest, any AppTestLoginSession.Control) async -> LoginResult)?) {
        lock.lock()
        defer { lock.unlock() }
        loginRequestsStorage.append(request)
        return (initialLoginEvents(request), loginOutcome)
    }
}

// MARK: - Clock and report helpers

struct AppTestClock: WallClock {
    let value: Int64

    func nowMs() -> Int64 { value }
}

func testReport(
    for request: UsageRequest,
    limits: [QuotaLimit] = [],
    refreshedCredential: BridgeCredential? = nil
) -> UsageReport {
    UsageReport(
        schemaVersion: "1.2.0",
        requestId: request.requestId,
        providerId: request.providerId,
        connectorId: request.connectorId,
        accountRef: request.accountRef,
        fetchedAtMs: request.requestedAtMs,
        limits: limits,
        refreshedCredential: refreshedCredential
    )
}

/// A bridge-minted credential for a provider/method pair, mirroring what
/// the bridge auth modules actually mint: OAuth-family methods return
/// `oauth` (including GitHub's device flow), API-key flows return the
/// declared static arm. The secret never equals what the UI typed, so any
/// test comparing stored credentials can prove the credential came from
/// the bridge, not from the app.
func mintedCredential(for provider: ProviderCapability, method: AuthMethod) -> BridgeCredential {
    let marker = "minted-\(provider.id)-\(method.rawValue)"
    if method == .browser || method == .device {
        return .oauth(access: marker)
    }
    if provider.credentialKinds.contains(.bearer) {
        return .staticCredential(kind: .bearer, secret: marker)
    }
    return .staticCredential(kind: .apiKey, secret: marker)
}

func temporaryStoreDirectory() -> URL {
    FileManager.default.temporaryDirectory
        .appendingPathComponent("token-meter-app-tests", isDirectory: true)
        .appendingPathComponent(UUID().uuidString, isDirectory: true)
}

/// Thread-safe box so login-outcome closures can hand the live session
/// control back to the test body without a data race.
final class LoginSessionHolder: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: (any AppTestLoginSession.Control)?

    var value: (any AppTestLoginSession.Control)? {
        get {
            lock.lock()
            defer { lock.unlock() }
            return stored
        }
        set {
            lock.lock()
            stored = newValue
            lock.unlock()
        }
    }
}
