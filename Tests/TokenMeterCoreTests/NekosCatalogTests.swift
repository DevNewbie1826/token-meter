import Foundation
import XCTest
@testable import TokenMeterCore

final class NekosCatalogTests: XCTestCase {
    func testThreeHourDecodesWhenDeclaredByRegistry() throws {
        // Given
        let data = Data(#""3h""#.utf8)
        // When
        let window = try JSONDecoder().decode(DeclaredWindow.self, from: data)
        // Then
        XCTAssertEqual(window.rawValue, "3h")
    }

    func testNekosCapabilitiesWhenShippedCatalogLoads() throws {
        // Given
        let catalog = ProviderCatalog.locked
        // When
        let nekos = try XCTUnwrap(catalog.providers.first { $0.id == "nekos" })
        // Then
        XCTAssertEqual(nekos.connectorTransport, .builtin("nekos"))
        XCTAssertEqual(nekos.authMethods, [.apiKey])
        XCTAssertEqual(nekos.credentialKinds, [.apiKey])
        XCTAssertEqual(nekos.registrySupportTier, .bestEffort)
        XCTAssertEqual(nekos.productKind, .quota)
        XCTAssertEqual(nekos.sourceKind, .firstPartyApi)
        XCTAssertEqual(nekos.authorizationBasis, .apiKey)
        XCTAssertEqual(nekos.declaredUnit, .percent)
        XCTAssertEqual(nekos.declaredWindows.map(\.rawValue), ["3h", "daily", "weekly"])
        XCTAssertEqual(nekos.pollingPolicy, .notPolled)
    }
}
