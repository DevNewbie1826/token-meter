import AppKit
import Foundation

/// Turns wall-clock interval and Mac wake-from-sleep into `onTick` calls.
///
/// This type has no provider knowledge. The app wires `onTick` to whatever
/// should refresh; the coordinator still owns cadence, jitter and backoff.
@MainActor
final class RefreshAutomation {
    private let intervalMs: Int
    private let onTick: @MainActor () -> Void
    // nonisolated so `deinit` can call `stop()`; mutation stays on the
    // main actor for `start()`, and `stop()` is the only other writer.
    private nonisolated(unsafe) var timer: Timer?
    private nonisolated(unsafe) var wakeObserver: NSObjectProtocol?

    /// Whether a repeating timer and wake observer are currently installed.
    var isRunning: Bool { timer != nil }

    init(intervalMs: Int = 900_000, onTick: @escaping @MainActor () -> Void) {
        guard intervalMs > 0 else {
            fatalError("RefreshAutomation intervalMs must be > 0")
        }
        self.intervalMs = intervalMs
        self.onTick = onTick
    }

    deinit {
        stop()
    }

    /// Installs the repeating timer and the wake observer. A second call
    /// while already running is a no-op.
    func start() {
        guard !isRunning else { return }

        let interval = TimeInterval(intervalMs) / 1_000
        let scheduled = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.fire()
            }
        }
        timer = scheduled

        wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.fire()
            }
        }
    }

    /// Invalidates the timer and removes the wake observer. Idempotent.
    nonisolated func stop() {
        timer?.invalidate()
        timer = nil
        if let wakeObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(wakeObserver)
            self.wakeObserver = nil
        }
    }

    /// Invokes `onTick` exactly once. Timer callbacks and the wake handler
    /// both route through this method so every tick is the same event.
    func fire() {
        onTick()
    }
}
