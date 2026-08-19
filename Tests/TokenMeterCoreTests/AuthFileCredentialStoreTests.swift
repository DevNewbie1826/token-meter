// File-based credential store contracts. Secrets live only in auth.json;
// tests isolate each case to its own temporary directory.
import Foundation
import XCTest
@testable import TokenMeterCore

final class AuthFileCredentialStoreTests: XCTestCase {
    func testStaticSecretSaveRoundTripsAndBumpsRevisions() throws {
        let (store, directory) = makeIsolatedStore()
        defer { try? FileManager.default.removeItem(at: directory) }

        XCTAssertEqual(try store.save(secret: "first-secret", for: testAccountRef), 1)
        XCTAssertEqual(
            try store.load(for: testAccountRef),
            StoredCredential(
                credential: .staticCredential(kind: .bearer, secret: "first-secret"),
                revision: 1
            )
        )

        XCTAssertEqual(try store.save(secret: "second-secret", for: testAccountRef), 2)
        XCTAssertEqual(
            try store.load(for: testAccountRef),
            StoredCredential(
                credential: .staticCredential(kind: .bearer, secret: "second-secret"),
                revision: 2
            )
        )
    }

    func testOAuthCredentialRoundTrips() throws {
        let (store, directory) = makeIsolatedStore()
        defer { try? FileManager.default.removeItem(at: directory) }
        let credential = BridgeCredential.oauth(
            access: "oauth-access",
            refresh: "oauth-refresh",
            expiresAtMs: testNowMs + 3_600_000,
            refreshEndpoint: "https://oauth.example.com/token",
            clientId: "client-id",
            identity: ["login": "octocat", "accountId": "42"]
        )

        XCTAssertEqual(try store.save(credential: credential, for: testAccountRef), 1)
        XCTAssertEqual(
            try store.load(for: testAccountRef),
            StoredCredential(credential: credential, revision: 1)
        )
    }

    func testNoneCredentialReturnsRevisionZeroAndClearsTheEntry() throws {
        let (store, directory) = makeIsolatedStore()
        defer { try? FileManager.default.removeItem(at: directory) }

        XCTAssertEqual(
            try store.save(
                credential: .staticCredential(kind: .apiKey, secret: "replace-me"),
                for: testAccountRef
            ),
            1
        )
        XCTAssertEqual(try store.save(credential: .none, for: testAccountRef), 0)
        XCTAssertNil(try store.load(for: testAccountRef))
    }

    func testDeleteThenLoadReturnsNil() throws {
        let (store, directory) = makeIsolatedStore()
        defer { try? FileManager.default.removeItem(at: directory) }

        XCTAssertEqual(try store.save(secret: "to-delete", for: testAccountRef), 1)
        try store.delete(for: testAccountRef)
        XCTAssertNil(try store.load(for: testAccountRef))
        try store.delete(for: testAccountRef)
        XCTAssertNil(try store.load(for: testAccountRef))
    }

    func testDataPersistsAcrossASecondStoreInstance() throws {
        let directory = makeTempDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let fileURL = directory.appendingPathComponent("auth.json")
        let first = AuthFileCredentialStore(fileURL: fileURL)

        XCTAssertEqual(try first.save(secret: "persisted-secret", for: testAccountRef), 1)

        let second = AuthFileCredentialStore(fileURL: fileURL)
        XCTAssertEqual(
            try second.load(for: testAccountRef),
            StoredCredential(
                credential: .staticCredential(kind: .bearer, secret: "persisted-secret"),
                revision: 1
            )
        )
    }

    func testCorruptFileMakesLoadThrowAndLaterSaveRecoversTheStore() throws {
        let directory = makeTempDirectory()
        defer { try? FileManager.default.removeItem(at: directory) }
        let fileURL = directory.appendingPathComponent("auth.json")
        try Data("{not-json".utf8).write(to: fileURL)
        let store = AuthFileCredentialStore(fileURL: fileURL)

        XCTAssertThrowsError(try store.load(for: testAccountRef)) { error in
            XCTAssertTrue(error is AuthFileCredentialStoreError)
        }

        XCTAssertEqual(try store.save(secret: "recovered-secret", for: testAccountRef), 1)
        XCTAssertEqual(
            try store.load(for: testAccountRef),
            StoredCredential(
                credential: .staticCredential(kind: .bearer, secret: "recovered-secret"),
                revision: 1
            )
        )
    }

    func testSavedFileHasOwnerReadWritePermissions() throws {
        let (store, directory) = makeIsolatedStore()
        defer { try? FileManager.default.removeItem(at: directory) }

        XCTAssertEqual(try store.save(secret: "permission-secret", for: testAccountRef), 1)

        let attributes = try FileManager.default.attributesOfItem(atPath: store.fileURL.path)
        let permissions = try XCTUnwrap(attributes[.posixPermissions] as? NSNumber)
        XCTAssertEqual(permissions.intValue, 0o600)
    }

    private func makeIsolatedStore() -> (AuthFileCredentialStore, URL) {
        let directory = makeTempDirectory()
        let store = AuthFileCredentialStore(
            fileURL: directory.appendingPathComponent("auth.json")
        )
        return (store, directory)
    }
}
