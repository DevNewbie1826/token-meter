import AppKit
import ApplicationServices
import Foundation

/// Subscribe before acting; evaluate on AX notifications, never on a polling timer.
final class NekosAXSignal {
    private var observer: AXObserver?
    private let application: AXUIElement
    private var condition: ([AXUIElement]) -> Bool = { _ in false }
    private var complete = false
    private var expired = false
    private var ownsRunLoop = false

    init(pid: Int32) throws {
        application = AXUIElementCreateApplication(pid)
        let callback: AXObserverCallback = { _, _, _, context in
            guard let context else { return }
            let signal = Unmanaged<NekosAXSignal>.fromOpaque(context).takeUnretainedValue()
            signal.evaluate()
        }
        guard AXObserverCreate(pid, callback, &observer) == .success, let observer else {
            throw DriverFailure.accessibilityDisabled
        }
        for name in [kAXWindowCreatedNotification, kAXLayoutChangedNotification,
                     kAXValueChangedNotification, kAXFocusedUIElementChangedNotification,
                     kAXUIElementDestroyedNotification, kAXTitleChangedNotification] {
            let result = AXObserverAddNotification(observer, application, name as CFString,
                Unmanaged.passUnretained(self).toOpaque())
            guard result == .success || result == .notificationAlreadyRegistered else {
                throw DriverFailure.actionFailed("subscribe \(name)", result)
            }
        }
        CFRunLoopAddSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(observer), .defaultMode)
    }

    deinit {
        if let observer {
            CFRunLoopRemoveSource(CFRunLoopGetCurrent(), AXObserverGetRunLoopSource(observer), .defaultMode)
        }
    }

    private func evaluate() {
        if condition(collect(from: application)) {
            complete = true
            if ownsRunLoop { CFRunLoopStop(CFRunLoopGetCurrent()) }
        }
    }

    func wait(_ label: String, until condition: @escaping ([AXUIElement]) -> Bool,
              action: () throws -> Void) throws {
        self.condition = condition
        complete = false
        expired = false
        let timer = Timer(timeInterval: 15, repeats: false) { [self] _ in
            expired = true
            if ownsRunLoop { CFRunLoopStop(CFRunLoopGetCurrent()) }
        }
        RunLoop.current.add(timer, forMode: .default)
        defer { timer.invalidate() }
        try action()
        evaluate()
        while !complete && !expired {
            ownsRunLoop = true
            CFRunLoopRun()
            ownsRunLoop = false
        }
        guard complete else {
            for element in collect(from: application) where role(of: element) != kAXTextFieldRole {
                print("AX-STATE: role=\(role(of: element)) id=\(identifier(of: element)) label=\(text(kAXDescriptionAttribute, of: element))")
            }
            throw DriverFailure.eventTimeout(label)
        }
        print("AX-PASS: \(label)")
    }
}
