// Production clock and jitter implementations. All scheduling code depends
// only on the `WallClock` / `JitterSource` protocols so tests (and QA
// fixtures) stay deterministic.
import Foundation

public struct SystemWallClock: WallClock {
    public init() {}

    public func nowMs() -> Int64 {
        Int64((Date().timeIntervalSince1970 * 1000).rounded())
    }
}

public struct SystemJitterSource: JitterSource {
    public init() {}

    public func nextUnitInterval() -> Double {
        Double.random(in: 0..<1)
    }
}
