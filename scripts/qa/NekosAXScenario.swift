import AppKit
import ApplicationServices
import Foundation

@MainActor
func runNekosScenario(_ arguments: [String]) async throws {
    guard arguments.count == 4, AXIsProcessTrusted() else {
        throw DriverFailure.accessibilityDisabled
    }
    let launched = try await launchNekosApplication(path: arguments[2])
    let pid = launched.processIdentifier
    let result: Result<Void, Error>
    do {
        try await exerciseNekos(pid: pid, screenshot: arguments[3], baseline: arguments[1] == "nekos-baseline")
        result = .success(())
    } catch { result = .failure(error) }
    try await cleanupNekosApplication(pid: pid)
    try result.get()
    print("PASS: fixture-backed Nekos registration + refresh; NOT live upstream authentication")
    print("NEKOS_QA_COMPLETE")
}

@MainActor
private func exerciseNekos(pid: Int32, screenshot: String, baseline: Bool) async throws {
    let ready = LaunchEventBox()
    let notifications = DistributedNotificationCenter.default()
    let queue = OperationQueue()
    queue.maxConcurrentOperationCount = 1
    let subscription = notifications.addObserver(forName: Notification.Name("dev.herdr.token-meter.qa.front-ready"),
        object: nil, queue: queue) { notification in
        if let notified = notification.userInfo?["pid"] as? NSNumber, notified.int32Value == pid {
            ready.resolve(.success(notified.int32Value))
        }
    }
    defer { notifications.removeObserver(subscription) }
    notifications.postNotificationName(Notification.Name("dev.herdr.token-meter.qa.bring-front"),
        object: nil, userInfo: nil, deliverImmediately: true)
    _ = try await ready.wait(timeout: 10, label: "hosted window front ready")
    if baseline { try await captureNekosWindow(for: pid, at: screenshot) }
    let app = AXUIElementCreateApplication(pid)
    let signal = try NekosAXSignal(pid: pid)
    try signal.wait("provider management exposed", until: {
        element(withIdentifier: "provider-management-window", in: $0) != nil
    }) {
        _ = NSRunningApplication(processIdentifier: pid)?.activate(options: [.activateAllWindows])
        let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        let windows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? []
        guard let bounds = windows.first(where: {
            guard ($0[kCGWindowOwnerPID as String] as? Int32) == pid,
                  let bounds = $0[kCGWindowBounds as String] as? [String: Double] else { return false }
            return (bounds["Width"] ?? 0) > 100 && (bounds["Height"] ?? 0) > 100
        })?[kCGWindowBounds as String] as? [String: Double],
              let x = bounds["X"], let y = bounds["Y"], let width = bounds["Width"] else {
            throw DriverFailure.noVisibleWindow(pid)
        }
        for kind in [CGEventType.leftMouseDown, .leftMouseUp] {
            CGEvent(mouseEventSource: nil, mouseType: kind,
                mouseCursorPosition: CGPoint(x: x + width / 2, y: y + 12), mouseButton: .left)?
                .post(tap: .cghidEventTap)
        }
    }
    if baseline {
        try await captureNekosWindow(for: pid, at: screenshot)
        _ = try requireElement("provider-action-nekos", in: app)
        throw DriverFailure.unexpectedState("baseline unexpectedly contains Nekos")
    }
    let registration = try requireElement("provider-action-nekos", in: app)
    try signal.wait("Nekos API-key sheet opened", until: {
        element(withIdentifier: "provider-field-nekos-apiKey", in: $0) != nil
    }) { try perform("open Nekos registration", on: registration) }
    // A synthetic key is assigned in-process only. It never enters argv/env/logs.
    let field = try requireElement("provider-field-nekos-apiKey", in: app)
    try signal.wait("registration enabled", until: {
        element(withIdentifier: "provider-save-nekos", in: $0).map(isEnabled) == true
    }) { try setValue(UUID().uuidString, on: field, action: "enter fixture-only key") }
    let save = try requireElement("provider-save-nekos", in: app)
    try signal.wait("fixture-backed registration and real decoded quota rows", until: {
        contains("전체 · 주간, 18%", in: $0) && contains("fable · 주간, 34%", in: $0)
    }) { try perform("register Nekos", on: save) }
    _ = try assertNekosRows(app)
    let refresh = try requireElement("provider-refresh-nekos", in: app)
    try signal.wait("manual refresh completed", until: {
        element(withIdentifier: "nekos-qa-refresh-count", in: $0).map {
            text(kAXValueAttribute, of: $0) == "2"
        } == true
    }) { try perform("refresh Nekos through BridgeClient", on: refresh) }
    let rows = try assertNekosRows(app)
    guard let panel = collect(from: app).first(where: {
        role(of: $0) == kAXScrollAreaRole && contains("전체 · 주간", in: descendants(of: $0))
    }) else { throw DriverFailure.missingElement("Nekos quota scroll viewport") }
    try await captureNekosWindow(for: pid, at: screenshot)
    for (index, row) in rows.enumerated() {
        if !frame(of: panel).contains(frame(of: row)) {
            try signal.wait("quota row \(index + 1) fully visible", until: { _ in
                frame(of: panel).contains(frame(of: row))
            }) {
                let result = AXUIElementPerformAction(row, "AXScrollToVisible" as CFString)
                guard result == .success else { throw DriverFailure.actionFailed("reveal quota row", result) }
            }
            let extra = URL(fileURLWithPath: screenshot).deletingPathExtension().path + "-row-\(index + 1).png"
            try await captureNekosWindow(for: pid, at: extra)
        }
        print("VISIBLE: row=\(index + 1) panel=\(frame(of: panel)) row=\(frame(of: row))")
    }
}

func assertNekosRows(_ app: AXUIElement) throws -> [AXUIElement] {
    let elements = collect(from: app)
    let labels = ["전체 · 3시간, 0%", "전체 · 일간, 0%", "전체 · 주간, 18%",
                  "fable · 일간, 0%", "fable · 주간, 34%"]
    var rows: [AXUIElement] = []
    for expected in labels {
        guard let row = elements.first(where: { element in
            observableText(of: element).contains(where: { $0.hasPrefix(expected) })
        }) else {
            throw DriverFailure.missingElement(expected)
        }
        let bounds = frame(of: row)
        guard bounds.width > 0, bounds.height > 0 else {
            throw DriverFailure.unexpectedState("quota row has no visible bounds")
        }
        rows.append(row)
        print("ROW: \(observableText(of: row)) frame=\(bounds)")
    }
    print("AX-PASS: five independently labeled quota rows; percentages 0/0/18/0/34")
    return rows
}

func captureNekosWindow(for pid: Int32, at path: String) async throws {
    let done = LaunchEventBox()
    let notifications = DistributedNotificationCenter.default()
    let queue = OperationQueue()
    queue.maxConcurrentOperationCount = 1
    let observer = notifications.addObserver(
        forName: Notification.Name("dev.herdr.token-meter.qa.capture-done"), object: nil, queue: queue
    ) { notification in
        if let captured = notification.userInfo?["pid"] as? NSNumber, captured.int32Value == pid {
            done.resolve(.success(pid))
        }
    }
    defer { notifications.removeObserver(observer) }
    let temporary = FileManager.default.temporaryDirectory
        .appendingPathComponent("TokenMeter-QA-\(pid)-settings")
        .appendingPathComponent("window-\(UUID().uuidString).png").path
    if FileManager.default.fileExists(atPath: path) { try FileManager.default.removeItem(atPath: path) }
    notifications.postNotificationName(Notification.Name("dev.herdr.token-meter.qa.capture-window"),
        object: nil, userInfo: ["path": temporary, "targetPID": pid], deliverImmediately: true)
    _ = try await done.wait(timeout: 10, label: "native hosted window capture")
    try verifyScreenshot(at: temporary)
    try FileManager.default.moveItem(atPath: temporary, toPath: path)
    print("CAPTURE: native hosted NSWindow pid=\(pid) path=\(path)")
}
