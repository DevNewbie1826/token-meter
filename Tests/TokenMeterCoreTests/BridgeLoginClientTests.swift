import Darwin
import Foundation
import XCTest
@testable import TokenMeterCore

final class BridgeLoginClientTests: XCTestCase {
    func testLoginPromptRoundTripStreamsEventsAndDecodesSuccess() async throws {
        let directory = makeTempDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let helper = try makeHelperScript(in: directory, body: """
            IFS= read -r request_line || exit 3
            printf '%s\n' '{"type":"openUrl","url":"https://example.com/auth"}' >&2
            printf '%s\n' '{"type":"prompt","requestId":"prompt-1","prompt":"Paste the code","inputKind":"code","sensitive":true}' >&2
            IFS= read -r prompt_response || exit 3
            case "$prompt_response" in *'"type":"promptResponse"'*) ;; *) exit 4 ;; esac
            case "$prompt_response" in *'"requestId":"prompt-1"'*) ;; *) exit 4 ;; esac
            case "$prompt_response" in *'"value":"duplex-unit-value"'*) ;; *) exit 4 ;; esac
            printf '%s\n' '{"type":"pasteHint","detail":"Response received"}' >&2
            printf '%s\n' '{"type":"waiting","detail":"Validating"}' >&2
            printf '%s\n' '{"type":"code","code":"ABCD","verificationUrl":"https://example.com/device"}' >&2
            printf '%s\n' '{"schemaVersion":"1.3.0","providerId":"synthetic","status":"ok","completedAtMs":1787011200123,"credential":{"kind":"apiKey","secret":"sk-live"},"accountLabel":"Team"}'
            """)
        let client = BridgeClient(
            executableURL: helper,
            clock: ManualClock(nowMs: testNowMs)
        )
        let session = client.login(request: LoginRequest(
            providerId: "synthetic",
            method: .apiKey,
            requestedAtMs: testNowMs,
            deadlineAtMs: testNowMs + 10_000,
            inputs: LoginInputs(apiKey: "sk-input")
        ))

        var iterator = session.events.makeAsyncIterator()
        let openEvent = await iterator.next()
        XCTAssertEqual(openEvent, .openUrl(url: "https://example.com/auth"))
        guard case let .prompt(requestId, prompt, inputKind, sensitive) = await iterator.next() else {
            return XCTFail("expected a live prompt event")
        }
        XCTAssertEqual(requestId, "prompt-1")
        XCTAssertEqual(prompt, "Paste the code")
        XCTAssertEqual(inputKind, .code)
        XCTAssertTrue(sensitive)

        session.sendPromptResponse(id: requestId, value: "duplex-unit-value")

        var remaining: [AuthEvent] = []
        while let event = await iterator.next() {
            remaining.append(event)
        }
        XCTAssertEqual(remaining, [
            .pasteHint(detail: "Response received"),
            .waiting(detail: "Validating"),
            .code(code: "ABCD", verificationUrl: "https://example.com/device"),
        ])
        let result = await session.result.value
        XCTAssertEqual(
            result,
            .success(LoginSuccess(
                providerId: "synthetic",
                completedAtMs: 1_787_011_200_123,
                credential: .staticCredential(kind: .apiKey, secret: "sk-live"),
                accountLabel: "Team"
            ))
        )
    }

    func testLoginRedactsSensitivePromptResponseFromError() async throws {
        let directory = makeTempDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let helper = try makeHelperScript(in: directory, body: """
            IFS= read -r request_line || exit 3
            printf '%s\n' '{"type":"prompt","requestId":"sensitive-1","prompt":"Paste secret","inputKind":"text","sensitive":true}' >&2
            IFS= read -r prompt_response || exit 3
            printf '%s\n' '{"schemaVersion":"1.3.0","providerId":"synthetic","status":"error","completedAtMs":1787011200123,"error":{"kind":"invalidRequest","message":"rejected swift-prompt-unit-secret"}}'
            exit 1
            """)
        let client = BridgeClient(
            executableURL: helper,
            clock: ManualClock(nowMs: testNowMs)
        )
        let session = client.login(request: LoginRequest(
            providerId: "synthetic",
            method: .apiKey,
            requestedAtMs: testNowMs,
            deadlineAtMs: testNowMs + 10_000
        ))

        var iterator = session.events.makeAsyncIterator()
        guard case let .prompt(requestId, _, _, _) = await iterator.next() else {
            return XCTFail("expected a sensitive prompt")
        }
        session.sendPromptResponse(id: requestId, value: "swift-prompt-unit-secret")
        let result = await session.result.value
        XCTAssertEqual(
            result,
            .failure(.invalidRequest("rejected [redacted]"))
        )
    }

    func testLoginMapsTypedErrorEnvelope() async throws {
        let directory = makeTempDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let helper = try makeHelperScript(in: directory, body: """
            IFS= read -r request_line || exit 3
            printf '%s\n' '{"schemaVersion":"1.3.0","providerId":"synthetic","status":"error","completedAtMs":1787011200123,"error":{"kind":"rateLimited","message":"slow down","retryAfterMs":30000}}'
            exit 1
            """)
        let client = BridgeClient(
            executableURL: helper,
            clock: ManualClock(nowMs: testNowMs)
        )
        let session = client.login(request: LoginRequest(
            providerId: "synthetic",
            method: .apiKey,
            requestedAtMs: testNowMs,
            deadlineAtMs: testNowMs + 10_000
        ))

        let result = await session.result.value
        XCTAssertEqual(
            result,
            .failure(.rateLimited(retryAfterMs: 30_000))
        )
    }

    func testLoginMapsCliMisuseExitCode() async throws {
        let directory = makeTempDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let helper = try makeHelperScript(in: directory, body: """
            IFS= read -r request_line || exit 3
            printf '%s\n' 'usage: helper login --stdin' >&2
            exit 2
            """)
        let client = BridgeClient(
            executableURL: helper,
            clock: ManualClock(nowMs: testNowMs)
        )
        let session = client.login(request: LoginRequest(
            providerId: "synthetic",
            method: .apiKey,
            requestedAtMs: testNowMs,
            deadlineAtMs: testNowMs + 10_000
        ))

        let result = await session.result.value
        XCTAssertEqual(
            result,
            .failure(.invalidRequest("bridge login helper rejected its arguments"))
        )
    }

    func testLoginKillsHelperPastDeadline() async throws {
        let directory = makeTempDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let gate = directory.appendingPathComponent("deadline.fifo")
        let helper = try makeHelperScript(in: directory, body: """
            IFS= read -r request_line || exit 3
            mkfifo '\(gate.path)'
            read never_signaled < '\(gate.path)'
            """)
        let client = BridgeClient(
            executableURL: helper,
            clock: ManualClock(nowMs: testNowMs)
        )
        let session = client.login(request: LoginRequest(
            providerId: "synthetic",
            method: .apiKey,
            requestedAtMs: testNowMs,
            deadlineAtMs: testNowMs + 250
        ))

        let result = await session.result.value
        XCTAssertEqual(result, .failure(.timeout))
    }

    func testCancellationTerminatesAndReapsHelperWithinBound() async throws {
        let directory = makeTempDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let pidFile = directory.appendingPathComponent("helper.pid")
        let gate = directory.appendingPathComponent("cancel.fifo")
        let helper = try makeHelperScript(in: directory, body: """
            IFS= read -r request_line || exit 3
            mkfifo '\(gate.path)'
            trap '' TERM
            printf '%s' "$$" > '\(pidFile.path)'
            printf '%s\n' '{"type":"waiting","detail":"ready-to-cancel"}' >&2
            read never_signaled < '\(gate.path)'
            """)
        let client = BridgeClient(
            executableURL: helper,
            clock: ManualClock(nowMs: testNowMs)
        )
        let session = client.login(request: LoginRequest(
            providerId: "synthetic",
            method: .apiKey,
            requestedAtMs: testNowMs,
            deadlineAtMs: testNowMs + 30_000
        ))

        var iterator = session.events.makeAsyncIterator()
        let readyEvent = await iterator.next()
        XCTAssertEqual(readyEvent, .waiting(detail: "ready-to-cancel"))
        let pidText = try String(contentsOf: pidFile, encoding: .utf8)
        let pid = try XCTUnwrap(pid_t(pidText))

        session.cancel()
        let result = try await boundedValue(of: session.result)
        XCTAssertEqual(result, .failure(.timeout))
        let firstAfterFinish = await iterator.next()
        let secondAfterFinish = await iterator.next()
        XCTAssertNil(firstAfterFinish)
        XCTAssertNil(secondAfterFinish, "finished event streams remain closed")

        errno = 0
        XCTAssertEqual(Darwin.kill(pid, 0), -1)
        XCTAssertEqual(errno, ESRCH, "result completed before the helper was reaped")
    }

    func testCompiledBridgeReturnsNoneForCredentialFreeOllamaLogin() async throws {
        let executable = compiledBridgeURL()
        XCTAssertTrue(
            FileManager.default.isExecutableFile(atPath: executable.path),
            "build the compiled bridge before running Swift integration tests"
        )
        let nowMs = Int64(Date().timeIntervalSince1970 * 1_000)
        let client = BridgeClient(
            executableURL: executable,
            clock: ManualClock(nowMs: nowMs)
        )
        let session = client.login(request: LoginRequest(
            providerId: "ollama",
            method: .apiKey,
            requestedAtMs: nowMs,
            deadlineAtMs: nowMs + 30_000
        ))

        guard case let .success(success) = await session.result.value else {
            return XCTFail("expected credential-free Ollama login success")
        }
        XCTAssertEqual(success.credential, .none)
        XCTAssertEqual(success.accountLabel, "Local (no key)")
    }

    func testCompiledBridgeLoginReturnsTypedUnknownProviderError() async throws {
        let executable = compiledBridgeURL()
        XCTAssertTrue(
            FileManager.default.isExecutableFile(atPath: executable.path),
            "build the compiled bridge before running Swift integration tests"
        )
        let client = BridgeClient(
            executableURL: executable,
            clock: ManualClock(nowMs: testNowMs)
        )
        let session = client.login(request: LoginRequest(
            providerId: "fixture",
            method: .apiKey,
            requestedAtMs: testNowMs,
            deadlineAtMs: testNowMs + 30_000
        ))

        guard case let .failure(.invalidProvider(message)) = await session.result.value else {
            return XCTFail("expected invalidProvider from compiled bridge")
        }
        XCTAssertTrue(message.contains("fixture"))
    }

    private func compiledBridgeURL() -> URL {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        return root.appendingPathComponent("bridge/build/token-meter-bridge")
    }

    private enum BoundedWaitError: Error {
        case timedOut
    }

    private func boundedValue<T: Sendable>(
        of task: Task<T, Never>,
        timeoutNanoseconds: UInt64 = 2_000_000_000
    ) async throws -> T {
        try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask { await task.value }
            group.addTask {
                try await Task.sleep(nanoseconds: timeoutNanoseconds)
                throw BoundedWaitError.timedOut
            }
            defer { group.cancelAll() }
            guard let value = try await group.next() else {
                throw BoundedWaitError.timedOut
            }
            return value
        }
    }

    private func makeHelperScript(in directory: URL, body: String) throws -> URL {
        let url = directory.appendingPathComponent("login-helper")
        try "#!/bin/sh\n\(body)\n".write(to: url, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes(
            [.posixPermissions: NSNumber(value: Int16(0o755))],
            ofItemAtPath: url.path
        )
        return url
    }
}
