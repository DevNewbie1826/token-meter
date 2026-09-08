// Process transport for the TokenMeter/1.3.0 bridge protocol.
//
// Usage runs as `usage --stdin`; login runs as a duplex `login --stdin`
// NDJSON session. Request objects — the only places credentials or login
// inputs travel — are written to stdin, never argv or the environment. Usage
// reads one strict response object from stdout. Login keeps stdin open for
// correlated promptResponse lines while AuthEvent NDJSON arrives on stderr.
import Darwin
import Foundation

public final class LoginSession: @unchecked Sendable {
    public let events: AsyncStream<AuthEvent>
    public let result: Task<LoginResult, Never>

    private let control: LoginProcessControl

    fileprivate init(
        events: AsyncStream<AuthEvent>,
        result: Task<LoginResult, Never>,
        control: LoginProcessControl
    ) {
        self.events = events
        self.result = result
        self.control = control
    }

    /// Sends one correlated prompt response over the helper's stdin. The
    /// value is serialized only into the NDJSON pipe, never argv, env or logs.
    public func sendPromptResponse(id: String, value: String) {
        control.sendPromptResponse(id: id, value: value)
    }

    /// Requests cancellation. The result task completes only after the helper
    /// has exited and Foundation has reaped it.
    public func cancel() {
        control.cancel()
    }
}

public struct BridgeClient: Sendable {
    public static let bridgeArguments = ["usage", "--stdin"]
    public static let loginArguments = ["login", "--stdin"]
    public static let maximumStderrBytes = 64 * 1024
    /// Watchdog upper bound so absurd deadlines cannot overflow the sleep.
    private static let maximumWatchdogMs: Int64 = 3_600_000

    private let executableURL: URL
    private let arguments: [String]
    private let clock: WallClock

    public init(
        executableURL: URL,
        arguments: [String] = BridgeClient.bridgeArguments,
        clock: WallClock = SystemWallClock()
    ) {
        self.executableURL = executableURL
        self.arguments = arguments
        self.clock = clock
    }

    /// Location of the bridge helper embedded in an app bundle
    /// (`Contents/Resources/token-meter-bridge`).
    public static func bundledExecutableURL(bundle: Bundle = .main) -> URL? {
        if let url = bundle.url(
            forResource: "token-meter-bridge",
            withExtension: nil,
            subdirectory: "Contents/Resources"
        ) {
            return url
        }
        return bundle.url(forResource: "token-meter-bridge", withExtension: nil)
    }

    /// Performs one usage fetch. Typed bridge errors come back as
    /// `.failure`; transport-level failures also map into the typed
    /// taxonomy, so this call never throws.
    public func fetchUsage(_ request: UsageRequest) async -> UsageResponse {
        let encoded: Data
        do {
            encoded = try UsageRequestEncoder().encode(request)
        } catch let error as BridgeServiceError {
            return .failure(error)
        } catch {
            return .failure(.internalError("request encoding failed"))
        }

        let process = Process()
        process.executableURL = executableURL
        process.arguments = arguments
        let stdinPipe = Pipe()
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardInput = stdinPipe
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe
        let termination = ProcessTermination()
        termination.install(on: process)
        do {
            try process.run()
        } catch {
            return .failure(.dependency("failed to launch bridge helper: \(error.localizedDescription)"))
        }

        // The request deadline becomes a watchdog that terminates the helper;
        // readers then observe EOF instead of hanging.
        let remainingMs = max(0, min(request.deadlineAtMs - clock.nowMs(), Self.maximumWatchdogMs))
        let timedOut = TimeoutFlag()
        let watchdog = Task { [process] in
            do {
                try await Task.sleep(nanoseconds: UInt64(remainingMs) * 1_000_000)
            } catch {
                return
            }
            timedOut.set()
            if process.isRunning { process.terminate() }
        }
        defer { watchdog.cancel() }

        do {
            try stdinPipe.fileHandleForWriting.write(contentsOf: encoded)
        } catch {
            // The helper may have exited first; the exit path reports it.
        }
        try? stdinPipe.fileHandleForWriting.close()

        // Read both pipes concurrently so a chatty helper cannot deadlock on
        // a full pipe buffer.
        let stdoutHandle = stdoutPipe.fileHandleForReading
        let stderrHandle = stderrPipe.fileHandleForReading
        async let stdoutData = Self.readUpTo(
            handle: stdoutHandle,
            limit: UsageResponseDecoder.maximumResponseBytes
        )
        async let stderrData = Self.readUpTo(
            handle: stderrHandle,
            limit: Self.maximumStderrBytes
        )

        _ = await termination.wait()
        let (stdout, stderr) = await (stdoutData, stderrData)

        guard !stdout.isEmpty else {
            if timedOut.isSet || remainingMs == 0 {
                return .failure(.timeout)
            }
            return .failure(.transport(Self.noOutputDetail(
                stderr: stderr,
                secrets: request.credential?.redactionSecrets ?? []
            )))
        }
        do {
            let response = try UsageResponseDecoder().decode(
                stdout,
                expectingRequestId: request.requestId,
                expectingProviderId: request.providerId,
                expectingConnectorId: request.connectorId,
                expectingAccountRef: request.accountRef
            )
            if case .failure(let error) = response {
                let secrets = (request.credential?.redactionSecrets ?? [])
                    + (error.refreshedCredential?.redactionSecrets ?? [])
                return .failure(error.redacting(secrets: secrets))
            }
            return response
        } catch let error as BridgeServiceError {
            return .failure(error.redacting(
                secrets: (request.credential?.redactionSecrets ?? [])
                    + (error.refreshedCredential?.redactionSecrets ?? [])
            ))
        } catch {
            return .failure(.internalError("undecodable bridge response"))
        }
    }

    /// Starts one duplex login command and returns its live session.
    public func login(request: LoginRequest) -> LoginSession {
        let (events, continuation) = AsyncStream<AuthEvent>.makeStream()
        let control = LoginProcessControl(events: continuation)
        let executableURL = self.executableURL
        let clock = self.clock
        let result = Task.detached(priority: .utility) {
            await Self.runLogin(
                request: request,
                executableURL: executableURL,
                clock: clock,
                control: control
            )
        }
        return LoginSession(events: events, result: result, control: control)
    }

    /// Compatibility adapter for the current app service protocol. New code
    /// should retain the LoginSession so it can answer prompts or cancel.
    @_disfavoredOverload
    public func login(request: LoginRequest) -> (
        events: AsyncStream<AuthEvent>,
        result: Task<LoginResult, Never>
    ) {
        let session: LoginSession = login(request: request)
        return (session.events, session.result)
    }

    // MARK: - Login internals

    private static func runLogin(
        request: LoginRequest,
        executableURL: URL,
        clock: WallClock,
        control: LoginProcessControl
    ) async -> LoginResult {
        defer { control.finishEvents() }
        if control.isCancelled {
            return .failure(.timeout)
        }

        let encoded: Data
        do {
            encoded = try LoginRequestEncoder().encode(request)
        } catch let error as BridgeServiceError {
            return .failure(error)
        } catch {
            return .failure(.internalError("login request encoding failed"))
        }

        let process = Process()
        process.executableURL = executableURL
        process.arguments = Self.loginArguments
        let stdinPipe = Pipe()
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardInput = stdinPipe
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe
        let termination = ProcessTermination()
        termination.install(on: process)
        control.attach(process: process, stdin: stdinPipe.fileHandleForWriting)
        do {
            try process.run()
        } catch {
            control.closeAfterExit()
            if control.isCancelled {
                return .failure(.timeout)
            }
            return .failure(.dependency("failed to launch bridge helper: \(error.localizedDescription)"))
        }
        control.terminateIfCancelled()

        let remainingMs = max(
            0,
            min(request.deadlineAtMs - clock.nowMs(), Self.maximumWatchdogMs)
        )
        let timedOut = TimeoutFlag()
        let watchdog = Task {
            do {
                try await Task.sleep(
                    nanoseconds: UInt64(remainingMs) * 1_000_000
                )
            } catch {
                return
            }
            timedOut.set()
            control.terminateForDeadline()
        }
        defer { watchdog.cancel() }

        control.sendInitialRequest(encoded)

        // stdout and stderr must drain concurrently. stderr decoding happens
        // line-by-line as bytes arrive so the AsyncStream is truly live.
        async let stdoutData = Self.readUpTo(
            handle: stdoutPipe.fileHandleForReading,
            limit: LoginResponseDecoder.maximumResponseBytes
        )
        async let stderrDone: Void = Self.streamAuthEvents(
            from: stderrPipe.fileHandleForReading,
            into: control
        )
        let terminationStatus = await termination.wait()
        await stderrDone
        let stdout = await stdoutData
        control.closeAfterExit()

        if control.isCancelled || timedOut.isSet || remainingMs == 0 {
            return .failure(.timeout)
        }
        if control.didWriteFail {
            return .failure(.transport("failed to write to bridge login helper"))
        }
        switch terminationStatus {
        case 0, 1:
            break
        case 2:
            return .failure(.invalidRequest("bridge login helper rejected its arguments"))
        default:
            return .failure(.transport(
                "bridge login helper exited with status \(terminationStatus)"
            ))
        }
        guard !stdout.isEmpty else {
            return .failure(.transport("bridge login helper produced no output"))
        }
        do {
            let result = try LoginResponseDecoder().decode(stdout)
            if case .failure(let error) = result {
                return .failure(error.redacting(
                    secrets: Self.loginSecrets(request) + control.redactionSecrets
                ))
            }
            return result
        } catch let error as BridgeServiceError {
            return .failure(error.redacting(
                secrets: Self.loginSecrets(request) + control.redactionSecrets
            ))
        } catch {
            return .failure(.internalError("undecodable bridge login response"))
        }
    }

    /// Reads stderr as it arrives, parsing complete NDJSON lines into the
    /// event stream. Unknown or non-JSON lines are skipped; they are advisory
    /// progress output, not the final response trust boundary.
    private static func streamAuthEvents(
        from handle: FileHandle,
        into control: LoginProcessControl
    ) async {
        await Task.detached(priority: .utility) {
            var buffer = Data()
            while true {
                let chunk = handle.availableData
                if chunk.isEmpty { break }
                buffer.append(chunk)
                while let newline = buffer.firstIndex(of: 0x0A) {
                    let line = buffer.subdata(in: buffer.startIndex..<newline)
                    buffer.removeSubrange(buffer.startIndex...newline)
                    if let text = String(data: line, encoding: .utf8),
                       let event = AuthEvent.parse(text) {
                        control.yield(event)
                    }
                }
                // Bound a single unterminated line while continuing to drain
                // subsequent chunks. Valid AuthEvent lines are tiny.
                if buffer.count > maximumStderrBytes {
                    buffer.removeAll(keepingCapacity: true)
                }
            }
            if !buffer.isEmpty,
               let text = String(data: buffer, encoding: .utf8),
               let event = AuthEvent.parse(text) {
                control.yield(event)
            }
        }.value
    }

    // MARK: - Shared internals

    private static func readUpTo(handle: FileHandle, limit: Int) async -> Data {
        await Task.detached(priority: .utility) { () -> Data in
            var data = Data()
            var overLimit = false
            while true {
                let chunk = handle.availableData
                if chunk.isEmpty { break }
                if !overLimit {
                    let remaining = max(0, limit + 1 - data.count)
                    data.append(chunk.prefix(remaining))
                    overLimit = data.count > limit
                }
            }
            return data
        }.value
    }

    private static func noOutputDetail(
        stderr: Data,
        secrets: [String]
    ) -> String {
        let tail = String(data: stderr.prefix(256), encoding: .utf8)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !tail.isEmpty else { return "bridge helper produced no output" }
        let safeTail = secrets.reduce(tail) { redacted, secret in
            guard !secret.isEmpty else { return redacted }
            return redacted.replacingOccurrences(of: secret, with: "[redacted]")
        }
        return "bridge helper produced no output: \(safeTail)"
    }

    private static func loginSecrets(_ request: LoginRequest) -> [String] {
        [request.inputs?.apiKey, request.inputs?.cookieHeader]
            .compactMap { value in
                guard let value, !value.isEmpty else { return nil }
                return value
            }
    }
}

/// Exact process-exit signal installed before launch so a fast helper cannot
/// terminate before the client starts waiting.
private final class ProcessTermination: @unchecked Sendable {
    private let lock = NSLock()
    private var status: Int32?
    private var continuation: CheckedContinuation<Int32, Never>?

    func install(on process: Process) {
        process.terminationHandler = { [weak self] process in
            self?.complete(status: process.terminationStatus)
        }
    }

    func wait() async -> Int32 {
        await withCheckedContinuation { continuation in
            lock.lock()
            if let status {
                lock.unlock()
                continuation.resume(returning: status)
            } else {
                self.continuation = continuation
                lock.unlock()
            }
        }
    }

    private func complete(status: Int32) {
        lock.lock()
        self.status = status
        let continuation = self.continuation
        self.continuation = nil
        lock.unlock()
        continuation?.resume(returning: status)
    }
}

private final class LoginProcessControl: @unchecked Sendable {
    private static let forceKillDelay: DispatchTimeInterval = .milliseconds(500)

    private let lock = NSLock()
    private let events: AsyncStream<AuthEvent>.Continuation
    private var process: Process?
    private var stdin: FileHandle?
    private var cancelled = false
    private var writeFailed = false
    private var eventsFinished = false
    private var sensitivePromptIds = Set<String>()
    private var sensitiveValues = Set<String>()

    init(events: AsyncStream<AuthEvent>.Continuation) {
        self.events = events
    }

    var isCancelled: Bool {
        lock.lock()
        defer { lock.unlock() }
        return cancelled
    }

    var didWriteFail: Bool {
        lock.lock()
        defer { lock.unlock() }
        return writeFailed
    }

    var redactionSecrets: [String] {
        lock.lock()
        defer { lock.unlock() }
        return Array(sensitiveValues)
    }

    func attach(process: Process, stdin: FileHandle) {
        lock.lock()
        self.process = process
        self.stdin = stdin
        let shouldClose = cancelled
        if shouldClose {
            self.stdin = nil
            try? stdin.close()
        }
        lock.unlock()
    }

    func sendInitialRequest(_ data: Data) {
        writeLine(data)
    }

    func sendPromptResponse(id: String, value: String) {
        guard !id.isEmpty else { return }
        lock.lock()
        if sensitivePromptIds.remove(id) != nil, !value.isEmpty {
            sensitiveValues.insert(value)
        }
        lock.unlock()
        let object: [String: Any] = [
            "type": "promptResponse",
            "requestId": id,
            "value": value,
        ]
        guard let data = try? JSONSerialization.data(
            withJSONObject: object,
            options: [.sortedKeys]
        ), data.count <= LoginRequestEncoder.maximumRequestBytes else {
            markWriteFailedAndTerminate()
            return
        }
        writeLine(data)
    }

    func cancel() {
        lock.lock()
        if cancelled {
            lock.unlock()
            return
        }
        cancelled = true
        let process = self.process
        let stdin = self.stdin
        self.stdin = nil
        try? stdin?.close()
        lock.unlock()
        if let process {
            Self.terminateAndEscalate(process)
        }
    }

    func terminateIfCancelled() {
        lock.lock()
        let shouldTerminate = cancelled
        let process = self.process
        lock.unlock()
        if shouldTerminate, let process {
            Self.terminateAndEscalate(process)
        }
    }

    func terminateForDeadline() {
        lock.lock()
        let process = self.process
        let stdin = self.stdin
        self.stdin = nil
        try? stdin?.close()
        lock.unlock()
        if let process {
            Self.terminateAndEscalate(process)
        }
    }

    func closeAfterExit() {
        lock.lock()
        let stdin = self.stdin
        self.stdin = nil
        process = nil
        try? stdin?.close()
        lock.unlock()
    }

    func yield(_ event: AuthEvent) {
        lock.lock()
        if case .prompt(let requestId, _, _, let sensitive) = event,
           sensitive {
            sensitivePromptIds.insert(requestId)
        }
        let canYield = !eventsFinished
        lock.unlock()
        if canYield {
            events.yield(event)
        }
    }

    func finishEvents() {
        lock.lock()
        guard !eventsFinished else {
            lock.unlock()
            return
        }
        eventsFinished = true
        lock.unlock()
        events.finish()
    }

    private func writeLine(_ data: Data) {
        var line = data
        line.append(0x0A)

        lock.lock()
        guard !cancelled, let stdin else {
            lock.unlock()
            return
        }
        do {
            try stdin.write(contentsOf: line)
            lock.unlock()
        } catch {
            writeFailed = true
            let process = self.process
            self.stdin = nil
            try? stdin.close()
            lock.unlock()
            if let process {
                Self.terminateAndEscalate(process)
            }
        }
    }

    private func markWriteFailedAndTerminate() {
        lock.lock()
        writeFailed = true
        let process = self.process
        let stdin = self.stdin
        self.stdin = nil
        try? stdin?.close()
        lock.unlock()
        if let process {
            Self.terminateAndEscalate(process)
        }
    }

    private static func terminateAndEscalate(_ process: Process) {
        guard process.isRunning else { return }
        let processIdentifier = process.processIdentifier
        process.terminate()
        DispatchQueue.global(qos: .utility).asyncAfter(
            deadline: .now() + forceKillDelay
        ) {
            if process.isRunning {
                _ = Darwin.kill(processIdentifier, SIGKILL)
            }
        }
    }
}

/// Watchdog-shared state: set immediately before the login process is
/// terminated, then read after exit to distinguish a deadline from a crash.
private final class TimeoutFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false

    var isSet: Bool {
        lock.lock()
        defer { lock.unlock() }
        return value
    }

    func set() {
        lock.lock()
        defer { lock.unlock() }
        value = true
    }
}
