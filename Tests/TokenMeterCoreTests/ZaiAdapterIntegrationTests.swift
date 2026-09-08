import Foundation
import XCTest
@testable import TokenMeterCore

final class ZaiAdapterIntegrationTests: XCTestCase {
    private var executable: URL?

    override func setUpWithError() throws {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("zai-probe-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock {
            try FileManager.default.removeItem(at: directory)
            print("zai cleanup=removed-isolated-probe path=\(directory.path)")
        }
        let binary = directory.appendingPathComponent("zai-wire-probe")
        let compiler = Process()
        compiler.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        compiler.currentDirectoryURL = root.appendingPathComponent("bridge")
        compiler.arguments = ["bun", "build", "test/zai-wire-probe.ts", "--compile", "--outfile", binary.path]
        compiler.standardOutput = FileHandle.standardError
        compiler.standardError = FileHandle.standardError
        try compiler.run()
        compiler.waitUntilExit()
        guard compiler.terminationStatus == 0 else {
            throw NSError(domain: "ZaiProbeCompilation", code: Int(compiler.terminationStatus))
        }
        executable = binary
    }

    private func fetch(_ scenario: String) async throws -> UsageReport {
        let executable = try XCTUnwrap(executable)
        XCTAssertTrue(FileManager.default.isExecutableFile(atPath: executable.path))
        let request = UsageRequest(
            requestId: testRequestId, operation: .fetchUsage,
            providerId: "zai", connectorId: "zai", accountRef: testAccountRef,
            requestedAtMs: testNowMs, deadlineAtMs: testNowMs + 10_000,
            credential: .staticCredential(kind: .apiKey, secret: "zai-synthetic-stdin-only")
        )
        let result = await BridgeClient(
            executableURL: executable, arguments: [scenario], clock: ManualClock(nowMs: testNowMs)
        ).fetchUsage(request)
        guard case let .report(report) = result else {
            XCTFail("actual Z.ai adapter report rejected: \(result)")
            throw BridgeServiceError.noData
        }
        return report
    }

    func testCreditOnlyReportAcceptedWithGenuineUnitsAndExactRatios() async throws {
        let report = try await fetch("credits")
        XCTAssertEqual(report.limits.map(\.limitId), ["zai:credits:5h", "zai:credits:1w"])
        XCTAssertEqual(report.limits.map(\.unit), [.credits, .credits])
        XCTAssertEqual(report.limits.map(\.utilization.fraction), [1438.0 / 12000, 0.95])
        XCTAssertEqual(report.limits.map(\.utilization.remaining), [10562, 3000])
        XCTAssertEqual(report.limits.map { QuotaSeverity.resolve(fraction: $0.utilization.fraction) }, [.ok, .critical])
    }

    func testMixedMetersRemainIndependentAndCrossSeverityBoundariesExactly() async throws {
        let report = try await fetch("mixed")
        XCTAssertEqual(report.limits.map(\.limitId), ["zai:credits:5h", "zai:tokens:5h", "zai:requests:5h", "zai:credits:1w"])
        XCTAssertEqual(report.limits.map(\.unit), [.credits, .tokens, .requests, .credits])
        XCTAssertEqual(report.limits.map(\.utilization.fraction), [0.8, 0.7999, 0.9499, 0.9999])
        XCTAssertEqual(report.limits.map { QuotaSeverity.resolve(fraction: $0.utilization.fraction) }, [.warning, .ok, .warning, .critical])
    }

    func testAbsoluteRatiosOverrideRoundingAndPreserveOverQuota() async throws {
        let report = try await fetch("precision")
        XCTAssertEqual(report.limits.map(\.utilization.fraction), [0.7999, 1.01])
        XCTAssertEqual(report.limits.map { QuotaSeverity.resolve(fraction: $0.utilization.fraction) }, [.ok, .exhausted])
    }

    func testReleaseBrowserEntryRetriesInvalidStateAndCancelsDuplexSession() async throws {
        let root = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let executable = root.appendingPathComponent("bridge/build/token-meter-bridge")
        XCTAssertTrue(FileManager.default.isExecutableFile(atPath: executable.path))
        let nowMs = Int64(Date().timeIntervalSince1970 * 1000)
        let session = BridgeClient(executableURL: executable).login(request: LoginRequest(
            providerId: "zai", method: .browser,
            requestedAtMs: nowMs, deadlineAtMs: nowMs + 5000
        ))
        defer { session.cancel() }
        var openedURLs: [String] = []
        var promptIDs: Set<String> = []
        for await event in session.events {
            switch event {
            case .openUrl(let url):
                // Controlled opener: observe the actual App-facing URL, no OS launch.
                openedURLs.append(url)
                let components = try XCTUnwrap(URLComponents(string: url))
                XCTAssertEqual(components.host, "chat.z.ai")
                XCTAssertEqual(components.queryItems?.first { $0.name == "redirect_uri" }?.value, "zcode://zai-auth/callback")
            case .prompt(let id, _, let inputKind, let sensitive):
                XCTAssertEqual(inputKind, .redirectUrl)
                XCTAssertTrue(sensitive)
                XCTAssertTrue(promptIDs.insert(id).inserted)
                if promptIDs.count == 1 {
                    session.sendPromptResponse(id: id, value: "zcode://zai-auth/callback?code=synthetic&state=forged")
                } else if promptIDs.count == 2 {
                    session.sendPromptResponse(id: id, value: "synthetic-stateless-code")
                } else {
                    session.cancel()
                }
            default:
                break
            }
        }
        let result = await session.result.value
        XCTAssertEqual(result, .failure(.timeout))
        XCTAssertEqual(openedURLs.count, 1)
        XCTAssertEqual(promptIDs.count, 3)
    }
}
