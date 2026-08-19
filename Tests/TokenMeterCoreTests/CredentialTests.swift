import Foundation
import XCTest
@testable import TokenMeterCore

final class CredentialTests: XCTestCase {
    func testNoneCredentialRoundTripsWithOnlyItsDiscriminator() throws {
        let credential = BridgeCredential.none
        let data = try encoded(credential)
        let object = try jsonObject(from: data)

        XCTAssertEqual(credential.kind, .none)
        XCTAssertEqual(credential.secret, "")
        XCTAssertEqual(Set(object.keys), ["kind"])
        XCTAssertEqual(object["kind"] as? String, "none")
        XCTAssertEqual(
            try JSONDecoder().decode(BridgeCredential.self, from: data),
            credential
        )
        assertCredentialDecodeFails(#"{"kind":"none","secret":"must-not-exist"}"#)
    }

    func testStaticCredentialArmsRoundTripWithExactWireKeys() throws {
        for kind in [StaticCredentialKind.bearer, .apiKey] {
            let credential = BridgeCredential.staticCredential(
                kind: kind,
                secret: "secret-\(kind.rawValue)"
            )
            let data = try encoded(credential)
            let object = try jsonObject(from: data)

            XCTAssertEqual(Set(object.keys), ["kind", "secret"])
            XCTAssertEqual(object["kind"] as? String, kind.rawValue)
            XCTAssertEqual(object["secret"] as? String, "secret-\(kind.rawValue)")
            XCTAssertEqual(
                try JSONDecoder().decode(BridgeCredential.self, from: data),
                credential
            )
        }
    }

    func testOAuthCredentialRoundTripsWithNestedOAuthObject() throws {
        let credential = BridgeCredential.oauth(
            access: "access-1",
            refresh: "refresh-1",
            expiresAtMs: 1_900_000_000_000,
            refreshEndpoint: "https://oauth.example.com/token",
            clientId: "client-1",
            identity: ["login": "octocat", "project": "demo"]
        )
        let data = try encoded(credential)
        let object = try jsonObject(from: data)

        XCTAssertEqual(credential.kind, .oauth)
        XCTAssertEqual(credential.secret, "access-1")
        XCTAssertEqual(Set(object.keys), ["kind", "secret", "oauth"])
        XCTAssertEqual(object["kind"] as? String, "oauth")
        XCTAssertEqual(object["secret"] as? String, "access-1")
        let oauth = try XCTUnwrap(object["oauth"] as? [String: Any])
        XCTAssertEqual(
            Set(oauth.keys),
            ["access", "refresh", "expiresAtMs", "refreshEndpoint", "clientId", "identity"]
        )
        XCTAssertEqual(oauth["access"] as? String, "access-1")
        XCTAssertEqual(oauth["refresh"] as? String, "refresh-1")
        XCTAssertEqual(oauth["expiresAtMs"] as? Int64, 1_900_000_000_000)
        XCTAssertEqual(oauth["refreshEndpoint"] as? String, "https://oauth.example.com/token")
        XCTAssertEqual(oauth["clientId"] as? String, "client-1")
        let identity = try XCTUnwrap(oauth["identity"] as? [String: Any])
        XCTAssertEqual(identity["login"] as? String, "octocat")
        XCTAssertEqual(identity["project"] as? String, "demo")
        XCTAssertEqual(
            try JSONDecoder().decode(BridgeCredential.self, from: data),
            credential
        )
    }

    func testOAuthCredentialOmitsAbsentOptionals() throws {
        let credential = BridgeCredential.oauth(access: "access-only")
        let object = try jsonObject(from: encoded(credential))
        let oauth = try XCTUnwrap(object["oauth"] as? [String: Any])

        XCTAssertEqual(Set(object.keys), ["kind", "secret", "oauth"])
        XCTAssertEqual(Set(oauth.keys), ["access"])
        XCTAssertEqual(oauth["access"] as? String, "access-only")
    }

    func testRejectsUnknownCredentialKind() {
        assertCredentialDecodeFails(#"{"kind":"cookie","secret":"s"}"#)
    }

    func testRejectsOAuthWithoutAccess() {
        assertCredentialDecodeFails(#"{"kind":"oauth","secret":"s","oauth":{"refresh":"r"}}"#)
    }

    func testRejectsOAuthWithoutNestedObject() {
        assertCredentialDecodeFails(#"{"kind":"oauth","secret":"s"}"#)
    }

    func testRejectsUnknownOAuthField() {
        assertCredentialDecodeFails(
            #"{"kind":"oauth","secret":"s","oauth":{"access":"a","tokenType":"Bearer"}}"#
        )
    }

    func testRejectsUnknownStaticCredentialField() {
        assertCredentialDecodeFails(
            #"{"kind":"bearer","secret":"s","oauth":{"access":"a"}}"#
        )
    }

    func testRejectsEmptyOAuthAccessAndSecret() {
        assertCredentialDecodeFails(#"{"kind":"oauth","secret":"s","oauth":{"access":""}}"#)
        assertCredentialDecodeFails(#"{"kind":"oauth","secret":"","oauth":{"access":"a"}}"#)
    }

    func testRejectsInvalidOAuthIdentityAndExpiry() {
        assertCredentialDecodeFails(
            #"{"kind":"oauth","secret":"s","oauth":{"access":"a","identity":{"id":1}}}"#
        )
        assertCredentialDecodeFails(
            #"{"kind":"oauth","secret":"s","oauth":{"access":"a","expiresAtMs":0}}"#
        )
        assertCredentialDecodeFails(
            #"{"kind":"oauth","secret":"s","oauth":{"access":"a","expiresAtMs":9007199254740992}}"#
        )
    }

    func testRejectsExplicitNullOAuthOptionals() {
        for field in ["refresh", "expiresAtMs", "refreshEndpoint", "clientId", "identity"] {
            assertCredentialDecodeFails(
                "{\"kind\":\"oauth\",\"secret\":\"s\",\"oauth\":{\"access\":\"a\",\"\(field)\":null}}"
            )
        }
    }

    private func encoded(_ credential: BridgeCredential) throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(credential)
    }

    private func assertCredentialDecodeFails(
        _ json: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertThrowsError(
            try JSONDecoder().decode(BridgeCredential.self, from: Data(json.utf8)),
            file: file,
            line: line
        )
    }
}
