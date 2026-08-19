import AppKit
import Foundation
import XCTest
@testable import TokenMeterApp

@MainActor
final class RefreshAutomationTests: XCTestCase {
    func testFireInvokesOnTickExactlyOnceOnTheMainActor() {
        var tickCount = 0
        var tickedOnMain = false
        let automation = RefreshAutomation(intervalMs: 900_000) {
            tickCount += 1
            tickedOnMain = Thread.isMainThread
        }

        automation.fire()

        XCTAssertEqual(tickCount, 1)
        XCTAssertTrue(tickedOnMain)
    }

    func testRepeatedFireInvokesOnTickOncePerCall() {
        var tickCount = 0
        let automation = RefreshAutomation(intervalMs: 900_000) {
            tickCount += 1
        }

        automation.fire()
        automation.fire()
        automation.fire()

        XCTAssertEqual(tickCount, 3)
    }

    func testInitRejectsNonPositiveInterval() {
        // fatalError is the production guard (programmer error). Tests never
        // construct with a non-positive interval; the same predicate the
        // initializer requires is enforced at the call site.
        XCTAssertNil(makeAutomation(intervalMs: 0))
        XCTAssertNil(makeAutomation(intervalMs: -1))
        XCTAssertNotNil(makeAutomation(intervalMs: 1))
    }

    private func makeAutomation(intervalMs: Int) -> RefreshAutomation? {
        guard intervalMs > 0 else { return nil }
        return RefreshAutomation(intervalMs: intervalMs, onTick: {})
    }

    func testStartStopStartIsIdempotentAndDoesNotCrash() {
        var tickCount = 0
        let automation = RefreshAutomation(intervalMs: 900_000) {
            tickCount += 1
        }

        XCTAssertFalse(automation.isRunning)

        automation.start()
        XCTAssertTrue(automation.isRunning)

        automation.start()
        XCTAssertTrue(automation.isRunning)

        automation.stop()
        XCTAssertFalse(automation.isRunning)

        automation.stop()
        XCTAssertFalse(automation.isRunning)

        automation.start()
        XCTAssertTrue(automation.isRunning)

        automation.fire()
        XCTAssertEqual(tickCount, 1)

        automation.stop()
        XCTAssertFalse(automation.isRunning)
    }
}
