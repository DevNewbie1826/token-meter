import Foundation
import XCTest
@testable import TokenMeterCore

final class LoginProtocolTests: XCTestCase {
    func testEncodesLoginRequestWithExactInputShape() throws {
        let request = LoginRequest(
            providerId: "github-copilot",
            method: .device,
            requestedAtMs: testNowMs,
            deadlineAtMs: testNowMs + 60_000,
            inputs: LoginInputs(
                apiKey: "ghp-token",
                apiBaseUrl: "https://api.github.example",
                cookieHeader: "session=abc",
                enterpriseHost: "github.example"
            )
        )

        let data = try LoginRequestEncoder().encode(request)
        let object = try jsonObject(from: data)
        XCTAssertLessThanOrEqual(data.count, LoginRequestEncoder.maximumRequestBytes)
        XCTAssertEqual(
            Set(object.keys),
            ["schemaVersion", "providerId", "method", "requestedAtMs", "deadlineAtMs", "inputs"]
        )
        XCTAssertEqual(object["schemaVersion"] as? String, "1.2.0")
        XCTAssertEqual(object["providerId"] as? String, "github-copilot")
        XCTAssertEqual(object["method"] as? String, "device")
        XCTAssertEqual(object["requestedAtMs"] as? Int, Int(testNowMs))
        XCTAssertEqual(object["deadlineAtMs"] as? Int, Int(testNowMs + 60_000))
        let inputs = try XCTUnwrap(object["inputs"] as? [String: Any])
        XCTAssertEqual(
            Set(inputs.keys),
            ["apiKey", "apiBaseUrl", "cookieHeader", "enterpriseHost"]
        )
        XCTAssertEqual(inputs["apiKey"] as? String, "ghp-token")
        XCTAssertEqual(inputs["apiBaseUrl"] as? String, "https://api.github.example")
        XCTAssertEqual(inputs["cookieHeader"] as? String, "session=abc")
        XCTAssertEqual(inputs["enterpriseHost"] as? String, "github.example")
        XCTAssertEqual(try LoginRequestEncoder().encode(request), data)
    }

    func testLoginRequestOmitsAbsentInputs() throws {
        let data = try LoginRequestEncoder().encode(LoginRequest(
            providerId: "anthropic",
            method: .browser,
            requestedAtMs: testNowMs,
            deadlineAtMs: testNowMs + 60_000
        ))
        let object = try jsonObject(from: data)

        XCTAssertNil(object["inputs"])
        XCTAssertEqual(
            Set(object.keys),
            ["schemaVersion", "providerId", "method", "requestedAtMs", "deadlineAtMs"]
        )
    }

    func testLoginRequestOnlyEmitsPresentInputFields() throws {
        let data = try LoginRequestEncoder().encode(LoginRequest(
            providerId: "synthetic",
            method: .apiKey,
            requestedAtMs: testNowMs,
            deadlineAtMs: testNowMs + 60_000,
            inputs: LoginInputs(apiKey: "key-only")
        ))
        let object = try jsonObject(from: data)
        let inputs = try XCTUnwrap(object["inputs"] as? [String: Any])

        XCTAssertEqual(Set(inputs.keys), ["apiKey"])
        XCTAssertEqual(inputs["apiKey"] as? String, "key-only")
    }

    func testRejectsOversizedLoginRequest() {
        let request = LoginRequest(
            providerId: "synthetic",
            method: .apiKey,
            requestedAtMs: testNowMs,
            deadlineAtMs: testNowMs + 60_000,
            inputs: LoginInputs(apiKey: String(repeating: "x", count: 70_000))
        )
        expectBridgeError(.invalidProtocol("login request exceeds 64 KiB")) {
            _ = try LoginRequestEncoder().encode(request)
        }
    }

    func testDecodesLoginSuccessWithNoneCredential() throws {
        let data = try JSONSerialization.data(withJSONObject: [
            "schemaVersion": "1.2.0",
            "providerId": "ollama",
            "status": "ok",
            "completedAtMs": testNowMs,
            "credential": ["kind": "none"],
            "accountLabel": "Local (no key)",
        ])

        XCTAssertEqual(
            try LoginResponseDecoder().decode(data),
            .success(LoginSuccess(
                providerId: "ollama",
                completedAtMs: testNowMs,
                credential: .none,
                accountLabel: "Local (no key)"
            ))
        )
    }

    func testDecodesLoginSuccessWithOAuthCredential() throws {
        let data = try JSONSerialization.data(withJSONObject: [
            "schemaVersion": "1.2.0",
            "providerId": "anthropic",
            "status": "ok",
            "completedAtMs": testNowMs,
            "credential": [
                "kind": "oauth",
                "secret": "access",
                "oauth": [
                    "access": "access",
                    "refresh": "refresh",
                    "expiresAtMs": testNowMs + 3_600_000,
                    "clientId": "client",
                    "identity": ["login": "team@example.com"],
                ],
            ],
            "accountLabel": "Team",
        ])

        XCTAssertEqual(
            try LoginResponseDecoder().decode(data),
            .success(LoginSuccess(
                providerId: "anthropic",
                completedAtMs: testNowMs,
                credential: .oauthCredential(
                    secret: "access",
                    access: "access",
                    refresh: "refresh",
                    expiresAtMs: testNowMs + 3_600_000,
                    clientId: "client",
                    identity: ["login": "team@example.com"]
                ),
                accountLabel: "Team"
            ))
        )
    }

    func testDecodesLoginTypedError() throws {
        let data = try JSONSerialization.data(withJSONObject: [
            "schemaVersion": "1.2.0",
            "providerId": "synthetic",
            "status": "error",
            "completedAtMs": testNowMs,
            "error": [
                "kind": "rateLimited",
                "message": "slow down",
                "retryAfterMs": 30_000,
            ],
        ])

        XCTAssertEqual(
            try LoginResponseDecoder().decode(data),
            .failure(.rateLimited(retryAfterMs: 30_000))
        )
    }

    func testRejectsWrongLoginResponseVersionAndUnknownFields() throws {
        let wrongVersion = try JSONSerialization.data(withJSONObject: [
            "schemaVersion": "1.0.0",
            "providerId": "synthetic",
            "status": "ok",
            "completedAtMs": testNowMs,
            "credential": ["kind": "apiKey", "secret": "k"],
        ])
        expectBridgeError(.invalidProtocol("unsupported schemaVersion: 1.0.0")) {
            _ = try LoginResponseDecoder().decode(wrongVersion)
        }

        let unknownField = try JSONSerialization.data(withJSONObject: [
            "schemaVersion": "1.2.0",
            "providerId": "synthetic",
            "status": "ok",
            "completedAtMs": testNowMs,
            "credential": ["kind": "apiKey", "secret": "k"],
            "unexpected": true,
        ])
        expectBridgeError(.invalidProtocol("unknown field: unexpected")) {
            _ = try LoginResponseDecoder().decode(unknownField)
        }
    }

    func testRejectsInvalidCredentialInLoginSuccess() throws {
        let data = try JSONSerialization.data(withJSONObject: [
            "schemaVersion": "1.2.0",
            "providerId": "anthropic",
            "status": "ok",
            "completedAtMs": testNowMs,
            "credential": [
                "kind": "oauth",
                "secret": "access",
                "oauth": ["refresh": "missing-access"],
            ],
        ])
        expectBridgeError(.invalidProtocol("invalid credential")) {
            _ = try LoginResponseDecoder().decode(data)
        }
    }

    func testParsesEveryAuthEventVariantStrictly() {
        XCTAssertEqual(
            AuthEvent.parse(#"{"type":"openUrl","url":"https://example.com/auth"}"#),
            .openUrl(url: "https://example.com/auth")
        )
        XCTAssertEqual(
            AuthEvent.parse(#"{"type":"code","code":"ABCD","verificationUrl":"https://example.com/device"}"#),
            .code(code: "ABCD", verificationUrl: "https://example.com/device")
        )
        XCTAssertEqual(
            AuthEvent.parse(#"{"type":"waiting","detail":"Waiting for approval"}"#),
            .waiting(detail: "Waiting for approval")
        )
        XCTAssertEqual(
            AuthEvent.parse(#"{"type":"pasteHint","detail":"Paste your key"}"#),
            .pasteHint(detail: "Paste your key")
        )
        for inputKind in AuthInputKind.allCases {
            let line = """
                {"type":"prompt","requestId":"prompt-1","prompt":"Enter value","inputKind":"\(inputKind.rawValue)","sensitive":true}
                """
            XCTAssertEqual(
                AuthEvent.parse(line),
                .prompt(
                    requestId: "prompt-1",
                    prompt: "Enter value",
                    inputKind: inputKind,
                    sensitive: true
                )
            )
        }

        XCTAssertNil(AuthEvent.parse(#"{"type":"prompt","requestId":"prompt-1","prompt":"Enter","inputKind":"password","sensitive":true}"#))
        XCTAssertNil(AuthEvent.parse(#"{"type":"prompt","requestId":"prompt-1","prompt":"Enter","inputKind":"text","sensitive":1}"#))
        XCTAssertNil(AuthEvent.parse(#"{"type":"prompt","requestId":"prompt-1","prompt":"Enter","inputKind":"text","sensitive":true,"extra":1}"#))
        XCTAssertNil(AuthEvent.parse(#"{"type":"unknown","detail":"no"}"#))
        XCTAssertNil(AuthEvent.parse(#"{"type":"openUrl"}"#))
        XCTAssertNil(AuthEvent.parse(#"{"type":"openUrl","url":"https://example.com","extra":true}"#))
        XCTAssertNil(AuthEvent.parse("not json"))
    }
}
