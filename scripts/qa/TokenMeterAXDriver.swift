import ApplicationServices
import AppKit
import Foundation

// QA accessibility driver for the TokenMeter menu-bar app.
//
// Scenarios:
//   provider-management <app> <capture-app> <png>
//     Launches the final app with the hosted provider-management window and,
//     through real AX actions only, verifies the CURRENT UI: all 16 provider
//     rows, every auth-method action button (identifier, title, enabled),
//     open/cancel of the API-key, browser and device sheets, the Alibaba
//     extra fields plus duplex prompt UI, GitHub's device enterprise-host
//     field, and both Codex methods. No credential value is ever entered,
//     transmitted, or persisted; device codes and verification URLs are
//     never printed. Finishes by capturing the hosted window.
//   live-acceptance <app> <provider> <method>
//     Opt-in live harness backing scripts/qa/live-provider-acceptance.sh.
//     The credential (if any) arrives on stdin only - never argv, never the
//     environment, never a log line - and is assigned straight into the
//     sheet's secure field through AXUIElementSetAttributeValue. Reports
//     only the registration outcome; without a credential it reports SKIP.
//   quota-panel <app> <capture-app> <png>
//     Current-build empty quota-panel scenario; no fixture usage data.

enum Scenario: String {
    case providerManagement = "provider-management"
    case quotaPanel = "quota-panel"
    case liveAcceptance = "live-acceptance"
}

enum DriverFailure: Error, CustomStringConvertible, Sendable {
    case invalidArguments
    case accessibilityDisabled
    case applicationLaunch(String)
    case statusItemUnavailable
    case actionFailed(String, AXError)
    case eventTimeout(String)
    case missingElement(String)
    case unexpectedState(String)
    case noVisibleWindow(Int32)
    case captureFailed(String)

    var description: String {
        switch self {
        case .invalidArguments:
            return "usage: TokenMeterAXDriver provider-management <app> <capture-app> <png> | live-acceptance <app> <provider> <method> | quota-panel <app> <capture-app> <png>"
        case .accessibilityDisabled:
            return "Accessibility permission is not enabled"
        case let .applicationLaunch(message):
            return "TokenMeter launch failed: \(message)"
        case .statusItemUnavailable:
            return "Token Meter status item is unavailable"
        case let .actionFailed(action, error):
            return "\(action) failed with AXError \(error.rawValue)"
        case let .eventTimeout(action):
            return "timed out waiting for AX event after \(action)"
        case let .missingElement(element):
            return "required UI element is missing: \(element)"
        case let .unexpectedState(state):
            return "UI did not reach the expected state: \(state)"
        case let .noVisibleWindow(pid):
            return "no visible TokenMeter window belongs to PID \(pid)"
        case let .captureFailed(message):
            return "screenshot capture failed: \(message)"
        }
    }
}

final class LaunchEventBox: @unchecked Sendable {
    private let lock = NSLock()
    private var result: Result<Int32, Error>?
    private var continuation: CheckedContinuation<Result<Int32, Error>, Never>?
    private var output = Data()

    func resolve(_ newResult: Result<Int32, Error>) {
        lock.lock()
        guard result == nil else {
            lock.unlock()
            return
        }
        result = newResult
        let waitingContinuation = continuation
        continuation = nil
        lock.unlock()
        waitingContinuation?.resume(returning: newResult)
    }

    func consume(_ data: Data, pid: Int32) {
        lock.lock()
        output.append(data)
        let isReady = output.range(of: Data("TOKEN_METER_QA_READY\n".utf8)) != nil
        lock.unlock()
        if isReady {
            resolve(.success(pid))
        }
    }

    func wait(timeout: TimeInterval, label: String) async throws -> Int32 {
        let pendingResult = await withCheckedContinuation {
            (continuation: CheckedContinuation<Result<Int32, Error>, Never>) in
            lock.lock()
            if let result {
                lock.unlock()
                continuation.resume(returning: result)
            } else {
                self.continuation = continuation
                lock.unlock()
                DispatchQueue.global().asyncAfter(deadline: .now() + timeout) { [self] in
                    resolve(.failure(DriverFailure.eventTimeout(label)))
                }
            }
        }
        return try pendingResult.get()
    }
}

// MARK: - AX primitives

func attribute(_ name: String, of element: AXUIElement) -> CFTypeRef? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success else {
        return nil
    }
    return value
}

func text(_ name: String, of element: AXUIElement) -> String {
    attribute(name, of: element) as? String ?? ""
}

func children(of element: AXUIElement) -> [AXUIElement] {
    attribute(kAXChildrenAttribute, of: element) as? [AXUIElement] ?? []
}

func descendants(of root: AXUIElement, depth: Int = 0) -> [AXUIElement] {
    guard depth < 16 else { return [] }
    return children(of: root).flatMap { child in
        [child] + descendants(of: child, depth: depth + 1)
    }
}

/// The whole current element tree of an application element.
func collect(from application: AXUIElement) -> [AXUIElement] {
    [application] + descendants(of: application)
}

func observableText(of element: AXUIElement) -> [String] {
    [
        text(kAXTitleAttribute, of: element),
        text(kAXDescriptionAttribute, of: element),
        text(kAXIdentifierAttribute, of: element),
        text(kAXValueAttribute, of: element),
    ].filter { !$0.isEmpty }
}

func contains(_ expected: String, in elements: [AXUIElement]) -> Bool {
    elements
        .flatMap(observableText)
        .contains(where: { $0.localizedCaseInsensitiveContains(expected) })
}

func identifier(of element: AXUIElement) -> String {
    text(kAXIdentifierAttribute, of: element)
}

/// SwiftUI buttons on this OS expose their label through AXDescription
/// (AXTitle stays empty); prefer the description and fall back to the title.
func label(of element: AXUIElement) -> String {
    let description = text(kAXDescriptionAttribute, of: element)
    return description.isEmpty ? text(kAXTitleAttribute, of: element) : description
}

func role(of element: AXUIElement) -> String {
    text(kAXRoleAttribute, of: element)
}

func subrole(of element: AXUIElement) -> String {
    text(kAXSubroleAttribute, of: element)
}

func isEnabled(_ element: AXUIElement) -> Bool {
    attribute(kAXEnabledAttribute, of: element) as? Bool ?? false
}

func element(withIdentifier identifierToFind: String, in root: AXUIElement) -> AXUIElement? {
    ([root] + descendants(of: root))
        .first { text(kAXIdentifierAttribute, of: $0) == identifierToFind }
}

func element(withIdentifier identifierToFind: String, in elements: [AXUIElement]) -> AXUIElement? {
    elements.first { identifier(of: $0) == identifierToFind }
}

func requireElement(
    _ identifier: String,
    in application: AXUIElement
) throws -> AXUIElement {
    guard let found = element(withIdentifier: identifier, in: application) else {
        throw DriverFailure.missingElement(identifier)
    }
    return found
}

func identifiers(withPrefix prefix: String, in elements: [AXUIElement]) -> [String] {
    elements
        .map(identifier(of:))
        .filter { $0.hasPrefix(prefix) }
}

let observerCallback: AXObserverCallback = { _, _, notification, _ in
    print("EVENT: \(notification)")
}

func waitForEvent(after action: String, timeout: CFTimeInterval = 5) throws {
    let result = CFRunLoopRunInMode(.defaultMode, timeout, true)
    guard result != .timedOut else {
        throw DriverFailure.eventTimeout(action)
    }
}

func perform(_ action: String, on element: AXUIElement) throws {
    let result = AXUIElementPerformAction(element, kAXPressAction as CFString)
    guard result == .success else {
        throw DriverFailure.actionFailed(action, result)
    }
}

func setValue(_ value: String, on element: AXUIElement, action: String) throws {
    let result = AXUIElementSetAttributeValue(
        element,
        kAXValueAttribute as CFString,
        value as CFTypeRef
    )
    guard result == .success else {
        throw DriverFailure.actionFailed(action, result)
    }
}

// MARK: - Bounded polling

/// Polls a condition over freshly collected element trees with a hard
/// deadline. UI transitions in the app are observed by re-reading the tree,
/// so no fixed sleeps are used anywhere.
func waitUntil(
    _ timeout: TimeInterval,
    _ label: String,
    in application: AXUIElement,
    _ condition: ([AXUIElement]) -> Bool
) throws {
    let deadline = Date().addingTimeInterval(timeout)
    while true {
        if condition(collect(from: application)) {
            return
        }
        guard Date() < deadline else {
            throw DriverFailure.unexpectedState(label)
        }
        CFRunLoopRunInMode(.defaultMode, 0.2, true)
    }
}

func waitForIdentifier(
    _ identifierToFind: String,
    timeout: TimeInterval,
    in application: AXUIElement,
    matching predicate: (AXUIElement) -> Bool = { _ in true }
) throws -> AXUIElement {
    let deadline = Date().addingTimeInterval(timeout)
    while true {
        if let found = element(withIdentifier: identifierToFind, in: application), predicate(found) {
            return found
        }
        guard Date() < deadline else {
            throw DriverFailure.missingElement(identifierToFind)
        }
        CFRunLoopRunInMode(.defaultMode, 0.2, true)
    }
}

// MARK: - Window helpers

func visibleWindowIDs(for pid: Int32) -> [Int] {
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    let windows = CGWindowListCopyWindowInfo(options, kCGNullWindowID)
        as? [[String: Any]] ?? []
    return windows.compactMap { window in
        guard (window[kCGWindowOwnerPID as String] as? Int32) == pid else {
            return nil
        }
        return window[kCGWindowNumber as String] as? Int
    }
}

func frame(of element: AXUIElement) -> CGRect {
    guard
        let positionValue = attribute(kAXPositionAttribute, of: element),
        let sizeValue = attribute(kAXSizeAttribute, of: element),
        CFGetTypeID(positionValue) == AXValueGetTypeID(),
        CFGetTypeID(sizeValue) == AXValueGetTypeID()
    else {
        return .zero
    }
    var point = CGPoint.zero
    var dimensions = CGSize.zero
    AXValueGetValue(positionValue as! AXValue, .cgPoint, &point)
    AXValueGetValue(sizeValue as! AXValue, .cgSize, &dimensions)
    return CGRect(origin: point, size: dimensions)
}

// On this OS the window content of a freshly launched background-style
// app is not exposed to AX (its windows come back corrupt) until one real
// user-equivalent interaction lands on the window. Post a single real
// title-bar click - the title bar has no row buttons - and the tree becomes
// readable. This mirrors what a human tester's first click does.
func unlockWindowContent(pid: Int32) throws {
    _ = NSRunningApplication(processIdentifier: pid)?.activate(options: [.activateAllWindows])
    var bounds: CGRect?
    let deadline = Date().addingTimeInterval(8)
    while true {
        let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        let infos = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? []
        for info in infos where (info[kCGWindowOwnerPID as String] as? Int32) == pid {
            guard
                let raw = info[kCGWindowBounds as String] as? [String: Any],
                let x = raw["X"] as? Double,
                let y = raw["Y"] as? Double,
                let width = raw["Width"] as? Double,
                let height = raw["Height"] as? Double,
                width > 100, height > 100
            else { continue }
            bounds = CGRect(x: x, y: y, width: width, height: height)
            break
        }
        if bounds != nil { break }
        guard Date() < deadline else {
            throw DriverFailure.noVisibleWindow(pid)
        }
        CFRunLoopRunInMode(.defaultMode, 0.25, true)
    }
    guard let windowBounds = bounds else {
        throw DriverFailure.noVisibleWindow(pid)
    }
    let titleBarCenter = CGPoint(x: windowBounds.midX, y: windowBounds.minY + 12)
    for kind in [CGEventType.leftMouseDown, .leftMouseUp] {
        let click = CGEvent(
            mouseEventSource: nil,
            mouseType: kind,
            mouseCursorPosition: titleBarCenter,
            mouseButton: .left
        )
        click?.post(tap: .cghidEventTap)
    }
}

func verifyVisibleWindow(for expectedPID: Int32, screenshotPath: String) throws {
    let windowIDs = visibleWindowIDs(for: expectedPID)
    guard !windowIDs.isEmpty else {
        throw DriverFailure.noVisibleWindow(expectedPID)
    }
    print(
        "CAPTURE: pid=\(expectedPID) windows=\(windowIDs) " +
            "path=\(screenshotPath)"
    )
}

func verifyScreenshot(at screenshotPath: String) throws {
    guard
        let attributes = try? FileManager.default.attributesOfItem(atPath: screenshotPath),
        let size = attributes[.size] as? NSNumber,
        size.intValue > 0
    else {
        throw DriverFailure.captureFailed("PNG was not created")
    }
}

func captureFrontmostWindow(for pid: Int32, at screenshotPath: String) throws {
    guard let windowID = visibleWindowIDs(for: pid).first else {
        throw DriverFailure.noVisibleWindow(pid)
    }
    try? FileManager.default.removeItem(atPath: screenshotPath)
    let capture = Process()
    capture.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    capture.arguments = ["-x", "-l", String(windowID), screenshotPath]
    try capture.run()
    capture.waitUntilExit()
    guard capture.terminationStatus == 0 else {
        throw DriverFailure.captureFailed("screencapture exited \(capture.terminationStatus)")
    }
    try verifyScreenshot(at: screenshotPath)
    print("CAPTURE: pid=\(pid) window=\(windowID) path=\(screenshotPath)")
}

func terminateAndWait(_ process: Process) {
    guard process.isRunning else { return }
    let exited = DispatchSemaphore(value: 0)
    process.terminationHandler = { _ in exited.signal() }
    process.terminate()
    if exited.wait(timeout: .now() + 5) == .timedOut {
        kill(process.processIdentifier, SIGKILL)
    }
    process.waitUntilExit()
}

func removeQAStoreDirectories(for pid: Int32) {
    for scope in ["menu", "settings"] {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("TokenMeter-QA-\(pid)-\(scope)", isDirectory: true)
        try? FileManager.default.removeItem(at: directory)
    }
}

func verifyLiveKimiQuota(application: AXUIElement) throws {
    do {
        try waitUntil(45, "Kimi live quota rows did not appear", in: application) { elements in
            guard let status = element(withIdentifier: "kimi-live-status", in: elements) else {
                return false
            }
            return text(kAXValueAttribute, of: status).contains("rows:kimi:7d,kimi:5h")
        }
    } catch {
        let elements = collect(from: application)
        if let status = element(withIdentifier: "kimi-live-status", in: elements) {
            print("KIMI-LIVE-STATUS: label=\(label(of: status)) value=\(text(kAXValueAttribute, of: status))")
        }
        let relevantLabels = Set(elements.map(label(of:)).filter { value in
            let lower = value.lowercased()
            return lower.contains("kimi")
                || lower.contains("quota")
                || lower.contains("limit")
                || value.contains("사용")
                || value.contains("한도")
                || value.contains("인증")
                || value.contains("표시")
        }).sorted()
        print("KIMI-AX-LABELS: \(relevantLabels)")
        throw error
    }
    print("USAGE: provider=kimi-code windows=7d+5h status=visible")
}

func removeLiveKimiRegistration(application: AXUIElement) throws {
    let manage = try waitForIdentifier(
        "provider-action-kimi-code",
        timeout: 10,
        in: application
    )
    try perform("open Kimi management sheet for cleanup", on: manage)
    let remove = try waitForIdentifier(
        "provider-remove-kimi-code",
        timeout: 10,
        in: application
    )
    try perform("remove temporary Kimi registration", on: remove)
    try waitUntil(10, "temporary Kimi registration was not removed", in: application) { elements in
        identifiers(withPrefix: "provider-remove-kimi-code", in: elements).isEmpty
            && identifiers(withPrefix: "provider-action-kimi-code", in: elements).contains("provider-action-kimi-code")
    }
    print("CLEANUP: provider=kimi-code keychain+metadata=removed")
}

// MARK: - Expected catalog (locked registry 1.2.0, 16 providers)

struct ExpectedProvider {
    let id: String
    let displayName: String
    let methods: [String]

    var expectedRowLabel: String {
        "\(displayName), 모델 목록 없음"
    }

    var actionIdentifiers: [String] {
        methods.enumerated().map { index, method in
            index == 0 ? "provider-action-\(id)" : "provider-action-\(id)-\(method)"
        }
    }
}

func actionTitle(for method: String) -> String {
    switch method {
    case "apiKey": "API 키로 등록"
    case "browser": "브라우저로 로그인"
    case "device": "기기 인증"
    default: method
    }
}

let expectedProviders: [ExpectedProvider] = [
    ExpectedProvider(id: "alibaba-token-plan", displayName: "Alibaba Token Plan", methods: ["apiKey"]),
    ExpectedProvider(id: "anthropic", displayName: "Anthropic", methods: ["browser"]),
    ExpectedProvider(id: "cursor", displayName: "Cursor", methods: ["browser", "apiKey"]),
    ExpectedProvider(id: "github-copilot", displayName: "GitHub Copilot", methods: ["apiKey", "device"]),
    ExpectedProvider(id: "google-antigravity", displayName: "Google Antigravity", methods: ["browser"]),
    ExpectedProvider(id: "google-gemini-cli", displayName: "Google Gemini CLI", methods: ["browser"]),
    ExpectedProvider(id: "kimi-code", displayName: "Kimi Code", methods: ["device", "apiKey"]),
    ExpectedProvider(id: "minimax-code", displayName: "MiniMax Code", methods: ["apiKey"]),
    ExpectedProvider(id: "ollama", displayName: "Ollama", methods: ["apiKey"]),
    ExpectedProvider(id: "ollama-cloud", displayName: "Ollama Cloud", methods: ["apiKey"]),
    ExpectedProvider(id: "openai-codex", displayName: "OpenAI Codex", methods: ["browser", "device"]),
    ExpectedProvider(id: "opencode-go", displayName: "OpenCode Go", methods: ["apiKey"]),
    ExpectedProvider(id: "synthetic", displayName: "Synthetic", methods: ["apiKey"]),
    ExpectedProvider(id: "umans", displayName: "Umans", methods: ["apiKey"]),
    ExpectedProvider(id: "xai-oauth", displayName: "xAI OAuth", methods: ["device"]),
    ExpectedProvider(id: "zai", displayName: "Z.ai", methods: ["apiKey", "browser"]),
]

// MARK: - Provider-management UI exercise

/// The sheet's close button while a login is not running. Window-chrome
/// buttons are excluded by subrole so only the sheet's 닫기 matches.
func sheetCloseButton(in elements: [AXUIElement]) -> AXUIElement? {
    elements.first { element in
        role(of: element) == kAXButtonRole
            && label(of: element) == "닫기"
            && subrole(of: element) != "AXCloseButton"
            && subrole(of: element) != "AXMinimizeButton"
            && subrole(of: element) != "AXZoomButton"
    }
}

// MARK: - Row exposure
//
// The provider List virtualizes its rows, so a single AX snapshot only
// contains the rows near the viewport. Row evidence is therefore
// accumulated across a real scroll sweep: every snapshot merges button
// titles/enabled states, row labels and id captions into one evidence
// record, and the sweep ends back at the top of the list.

struct RowEvidence {
    var buttonTitles: [String: String] = [:]
    var disabledButtons: [String] = []
    var rowLabels: Set<String> = []
    var idCaptions: Set<String> = []
    var allActionIds: Set<String> = []
}

@MainActor
final class ListScrollController {
    private let application: AXUIElement
    private let listPoint: CGPoint
    private let savedCursor: CGPoint

    init(application: AXUIElement) throws {
        self.application = application
        guard let window = ([application] + descendants(of: application))
            .first(where: { role(of: $0) == kAXWindowRole && !frame(of: $0).isEmpty })
        else {
            throw DriverFailure.missingElement("provider management window")
        }
        let windowFrame = frame(of: window)
        // A point safely inside the scrollable list, below the header.
        listPoint = CGPoint(x: windowFrame.midX, y: windowFrame.midY + 40)
        savedCursor = CGEvent(source: nil)?.location ?? listPoint
        let move = CGEvent(
            mouseEventSource: nil,
            mouseType: .mouseMoved,
            mouseCursorPosition: listPoint,
            mouseButton: .left
        )
        move?.post(tap: .cghidEventTap)
    }

    deinit {
        let restore = CGEvent(
            mouseEventSource: nil,
            mouseType: .mouseMoved,
            mouseCursorPosition: savedCursor,
            mouseButton: .left
        )
        restore?.post(tap: .cghidEventTap)
    }

    func scroll(lines: Int) {
        let scroll = CGEvent(
            scrollWheelEvent2Source: nil,
            units: .line,
            wheelCount: 1,
            wheel1: Int32(lines),
            wheel2: 0,
            wheel3: 0
        )
        scroll?.post(tap: .cghidEventTap)
        CFRunLoopRunInMode(.defaultMode, 0.15, true)
    }

    func isRealized(_ identifierToFind: String) -> Bool {
        element(withIdentifier: identifierToFind, in: application) != nil
    }

    /// Brings one row's action button into the realized set by scrolling
    /// down first, then up, in small batches.
    func ensureRowRealized(_ identifierToFind: String) throws {
        if isRealized(identifierToFind) { return }
        for _ in 0..<10 {
            scroll(lines: -4)
            if isRealized(identifierToFind) { return }
        }
        for _ in 0..<24 {
            scroll(lines: 4)
            if isRealized(identifierToFind) { return }
        }
        throw DriverFailure.missingElement("row never entered the AX tree: \(identifierToFind)")
    }
}

func scanRows(into evidence: inout RowEvidence, application: AXUIElement) {
    let elements = collect(from: application)
    for element in elements {
        let id = identifier(of: element)
        guard !id.isEmpty else { continue }
        if id.hasPrefix("provider-action-") {
            evidence.allActionIds.insert(id)
            if role(of: element) == kAXButtonRole {
                if isEnabled(element) {
                    evidence.buttonTitles[id] = label(of: element)
                } else {
                    evidence.disabledButtons.append(id)
                }
            }
        }
    }
    evidence.rowLabels.formUnion(
        elements
            .filter { role(of: $0) == kAXGroupRole }
            .map(label(of:))
            .filter { $0.hasSuffix("모델 목록 없음") }
    )
    evidence.idCaptions.formUnion(
        elements
            .filter { role(of: $0) == kAXStaticTextRole }
            .map { text(kAXValueAttribute, of: $0) }
            .filter { value in expectedProviders.contains { $0.id == value } }
    )
}

/// Settles, then sweeps the list downward with real scroll events until no
/// new rows appear, accumulating evidence; scrolls back to the top.
@MainActor
func gatherRowEvidence(_ application: AXUIElement) throws -> (RowEvidence, ListScrollController) {
    var evidence = RowEvidence()
    // Settle pass: rows materialize asynchronously right after launch.
    let settleDeadline = Date().addingTimeInterval(4)
    var previousCounts = (0, 0)
    while Date() < settleDeadline {
        scanRows(into: &evidence, application: application)
        let counts = (evidence.allActionIds.count, evidence.idCaptions.count)
        if counts == previousCounts, counts.0 >= 16 { break }
        previousCounts = counts
        CFRunLoopRunInMode(.defaultMode, 0.3, true)
    }
    let controller = try ListScrollController(application: application)
    let expectedIds = Set(expectedProviders.flatMap(\.actionIdentifiers))
    if evidence.allActionIds != expectedIds {
        print("NOTICE: list virtualizes rows; sweeping with real scroll events to enumerate all 16")
        var stagnantBatches = 0
        for _ in 0..<40 {
            let before = evidence.allActionIds.count
            for _ in 0..<3 {
                controller.scroll(lines: -4)
                scanRows(into: &evidence, application: application)
            }
            if evidence.allActionIds.count == before {
                stagnantBatches += 1
                if stagnantBatches >= 2 { break }
            } else {
                stagnantBatches = 0
            }
            if evidence.allActionIds == expectedIds { break }
        }
        // Return to the top of the list.
        for _ in 0..<40 {
            if controller.isRealized("provider-action-alibaba-token-plan")
                && controller.isRealized("provider-action-anthropic") {
                break
            }
            controller.scroll(lines: 4)
            scanRows(into: &evidence, application: application)
        }
    }
    return (evidence, controller)
}

@MainActor
func exerciseProviderManagement(_ application: AXUIElement) throws {
    // 1. Hosted window and honest header copy.
    guard element(withIdentifier: "provider-management-window", in: application) != nil else {
        throw DriverFailure.missingElement("provider-management-window")
    }
    let headerElements = collect(from: application)
    for expected in ["프로바이더 관리", "OMP usage registry에서 동기화한 16개 프로바이더입니다", "모델 목록은 가져오지 않습니다"] {
        guard contains(expected, in: headerElements) else {
            throw DriverFailure.missingElement(expected)
        }
    }
    print("WINDOW: provider-management-window present; header copy verified")

    // 2. All 16 rows, every auth-method action, titles, enabled state.
    let (evidence, list) = try gatherRowEvidence(application)
    let expectedActionIds = Set(expectedProviders.flatMap(\.actionIdentifiers))
    for provider in expectedProviders {
        guard evidence.idCaptions.contains(provider.id) else {
            throw DriverFailure.missingElement("row caption \(provider.id)")
        }
        guard evidence.rowLabels.contains(provider.expectedRowLabel) else {
            throw DriverFailure.missingElement("row label \(provider.expectedRowLabel)")
        }
        for (index, method) in provider.methods.enumerated() {
            let actionID = index == 0
                ? "provider-action-\(provider.id)"
                : "provider-action-\(provider.id)-\(method)"
            guard let observedTitle = evidence.buttonTitles[actionID] else {
                throw DriverFailure.missingElement(actionID)
            }
            guard observedTitle == actionTitle(for: method) else {
                throw DriverFailure.unexpectedState(
                    "\(actionID) title \"\(observedTitle)\" != \"\(actionTitle(for: method))\""
                )
            }
            print("ACTION: \(actionID) title=\"\(observedTitle)\" enabled=true")
        }
        print("ROW: \(provider.id) methods=\(provider.methods.joined(separator: "+"))")
    }
    guard evidence.disabledButtons.isEmpty else {
        throw DriverFailure.unexpectedState("disabled row buttons: \(evidence.disabledButtons.sorted())")
    }
    guard evidence.allActionIds == expectedActionIds else {
        let unexpected = evidence.allActionIds.subtracting(expectedActionIds).sorted()
        throw DriverFailure.unexpectedState("unexpected provider-action identifiers: \(unexpected)")
    }
    let topElements = collect(from: application)
    let registeredArtifacts = identifiers(withPrefix: "provider-remove-", in: topElements)
        + identifiers(withPrefix: "provider-save-", in: topElements)
    guard registeredArtifacts.isEmpty else {
        throw DriverFailure.unexpectedState(
            "sheets/registrations leaked into the row list: \(registeredArtifacts)"
        )
    }
    print("ROWS: present=16 unique=16 expected=16; action-identifiers expected=\(expectedActionIds.count) unexpected=0 disabled=0")

    // 3. Plain API-key sheet: fields visible, closed without saving.
    try list.ensureRowRealized("provider-action-opencode-go")
    try perform("open opencode-go API-key sheet", on: requireElement(
        "provider-action-opencode-go",
        in: application
    ))
    _ = try waitForIdentifier(
        "provider-field-opencode-go-apiKey",
        timeout: 5,
        in: application,
        matching: { subrole(of: $0) == "AXSecureTextField" }
    )
    _ = try waitForIdentifier("provider-account-label-opencode-go", timeout: 5, in: application)
    print("SHEET: opencode-go apiKey fields=[provider-field-opencode-go-apiKey(secure), provider-account-label-opencode-go]")
    try closeSheet(application, providerID: "opencode-go")

    // 4. Alibaba extra fields: cookie header + base URL beside the key.
    try list.ensureRowRealized("provider-action-alibaba-token-plan")
    try perform("open alibaba-token-plan API-key sheet", on: requireElement(
        "provider-action-alibaba-token-plan",
        in: application
    ))
    let alibabaKeyField = try waitForIdentifier(
        "provider-field-alibaba-token-plan-apiKey",
        timeout: 5,
        in: application
    )
    guard subrole(of: alibabaKeyField) == "AXSecureTextField" else {
        throw DriverFailure.unexpectedState("alibaba API-key field is not secure")
    }
    let cookieField = try waitForIdentifier(
        "provider-field-alibaba-token-plan-cookieHeader",
        timeout: 5,
        in: application
    )
    guard subrole(of: cookieField) == "AXSecureTextField" else {
        throw DriverFailure.unexpectedState("alibaba cookie field is not secure")
    }
    let baseUrlField = try waitForIdentifier(
        "provider-field-alibaba-token-plan-apiBaseUrl",
        timeout: 5,
        in: application
    )
    guard subrole(of: baseUrlField).isEmpty, role(of: baseUrlField) == kAXTextFieldRole else {
        throw DriverFailure.unexpectedState("alibaba base-URL field is not a plain text field")
    }
    _ = try waitForIdentifier("provider-account-label-alibaba-token-plan", timeout: 5, in: application)
    print("SHEET: alibaba-token-plan apiKey extra-fields=[cookieHeader(secure), apiBaseUrl(plain)] verified")
    try closeSheet(application, providerID: "alibaba-token-plan")

    // 5. Alibaba duplex prompt: empty save -> region prompt -> respond ->
    //    sensitive API-key prompt -> bounded cancel. This opens one real
    //    OAuth page in the browser (the app's own openUrl handling).
    try list.ensureRowRealized("provider-action-alibaba-token-plan")
    try perform("open alibaba-token-plan API-key sheet again", on: requireElement(
        "provider-action-alibaba-token-plan",
        in: application
    ))
    _ = try waitForIdentifier("provider-save-alibaba-token-plan", timeout: 5, in: application)
    try perform("start alibaba-token-plan login with empty fields", on: requireElement(
        "provider-save-alibaba-token-plan",
        in: application
    ))
    let regionPrompt = try waitForIdentifier(
        "provider-prompt-alibaba-token-plan",
        timeout: 10,
        in: application
    )
    guard subrole(of: regionPrompt).isEmpty else {
        throw DriverFailure.unexpectedState("alibaba region prompt should be a plain field")
    }
    _ = try waitForIdentifier("provider-prompt-send-alibaba-token-plan", timeout: 5, in: application)
    _ = try waitForIdentifier("provider-login-cancel-alibaba-token-plan", timeout: 5, in: application)
    print("PROMPT: alibaba-token-plan step=region secure=false")
    try setValue("1", on: regionPrompt, action: "answer alibaba region prompt")
    try perform("send alibaba region answer", on: requireElement(
        "provider-prompt-send-alibaba-token-plan",
        in: application
    ))
    let deadline = Date().addingTimeInterval(15)
    var keyPrompt: AXUIElement?
    while keyPrompt == nil {
        let candidates = collect(from: application).filter {
            identifier(of: $0) == "provider-prompt-alibaba-token-plan"
        }
        if let candidate = candidates.first, subrole(of: candidate) == "AXSecureTextField" {
            keyPrompt = candidate
            break
        }
        guard Date() < deadline else {
            throw DriverFailure.missingElement("alibaba sensitive API-key prompt")
        }
        CFRunLoopRunInMode(.defaultMode, 0.2, true)
    }
    print("PROMPT: alibaba-token-plan step=api-key secure=true (sensitive prompt editor)")
    print("NOTICE: the app opened its real subscribe/auth URL in the default browser (openUrl event)")
    try perform("cancel alibaba-token-plan login", on: requireElement(
        "provider-login-cancel-alibaba-token-plan",
        in: application
    ))
    try waitUntil(10, "alibaba sheet back to input state after cancel", in: application) { elements in
        element(withIdentifier: "provider-save-alibaba-token-plan", in: elements) != nil
            && element(withIdentifier: "provider-login-cancel-alibaba-token-plan", in: elements) == nil
    }
    print("LOGIN-CANCEL: alibaba-token-plan returned-to-input=true")
    try closeSheet(application, providerID: "alibaba-token-plan")

    // 6. Browser sheet: auto-starts, shows progress + cancel; bounded cancel.
    try openOAuthSheetAndCancel(application, list: list, providerID: "anthropic", method: "browser")

    // 7. Device sheet: device code section appears; bounded cancel.
    try openOAuthSheetAndCancel(application, list: list, providerID: "kimi-code", method: "device")

    // 8. GitHub Copilot dual methods: apiKey + device buttons exist (checked
    //    in step 2); the device sheet carries the enterprise-host field.
    try list.ensureRowRealized("provider-action-github-copilot-device")
    try perform("open github-copilot device sheet", on: requireElement(
        "provider-action-github-copilot-device",
        in: application
    ))
    _ = try waitForIdentifier(
        "provider-field-github-copilot-enterpriseHost",
        timeout: 5,
        in: application,
        matching: { role(of: $0) == kAXTextFieldRole && subrole(of: $0).isEmpty }
    )
    guard element(withIdentifier: "provider-login-cancel-github-copilot", in: application) == nil else {
        throw DriverFailure.unexpectedState("github device sheet must not auto-start (it has an upfront field)")
    }
    print("SHEET: github-copilot device fields=[provider-field-github-copilot-enterpriseHost(plain)] auto-start=false")
    try closeSheet(application, providerID: "github-copilot")

    // 9. Codex two methods: both sheets open and are cancelled in turn.
    try openOAuthSheetAndCancel(application, list: list, providerID: "openai-codex", method: "browser")
    try openOAuthSheetAndCancel(application, list: list, providerID: "openai-codex", method: "device")

    print("PASS: 16 rows enumerated; \(expectedActionIds.count) auth-method actions verified (identifier, title, enabled)")
    print("PASS: api-key/browser/device sheets open and cancel; alibaba extra fields + duplex prompts; codex browser+device; github device enterprise-host field")
    print("PASS: no credential value was entered or persisted; device codes and verification URLs were never printed")
}

/// Opens an OAuth-family sheet (auto-starting), verifies the live progress
/// UI, then cancels within a bound and closes the sheet.
@MainActor
func openOAuthSheetAndCancel(
    _ application: AXUIElement,
    list: ListScrollController,
    providerID: String,
    method: String
) throws {
    let actionID = "provider-action-\(providerID)\(method == expectedProvider(providerID).methods[0] ? "" : "-\(method)")"
    try list.ensureRowRealized(actionID)
    try perform("open \(providerID) \(method) sheet", on: requireElement(
        actionID,
        in: application
    ))
    _ = try waitForIdentifier("provider-login-cancel-\(providerID)", timeout: 10, in: application)
    print("SHEET: \(providerID) \(method) auto-started=true cancel-button=true")

    // Progress UI: a verification URL (browser) or the device-code section
    // (device) must render. Never print the URL or the code itself.
    let wantsCode = method == "device"
    let deadline = Date().addingTimeInterval(20)
    var progressSeen = false
    var codeSectionSeen = false
    while !progressSeen {
        let elements = collect(from: application)
        let sheetTexts = elements.flatMap(observableText)
        let urlShown = sheetTexts.contains { $0.hasPrefix("http") }
        codeSectionSeen = sheetTexts.contains { $0 == "인증 코드" }
        if wantsCode ? (urlShown && codeSectionSeen) : urlShown {
            progressSeen = true
            break
        }
        guard Date() < deadline else { break }
        CFRunLoopRunInMode(.defaultMode, 0.25, true)
    }
    if wantsCode {
        print("SHEET: \(providerID) device code-section=\(codeSectionSeen ? "shown" : "NOT-shown-within-20s") url=\(progressSeen ? "shown" : "not-shown-within-20s")")
    } else {
        print("SHEET: \(providerID) browser verification-url=\(progressSeen ? "shown" : "NOT-shown-within-20s")")
    }
    guard progressSeen else {
        // Honest failure: the sheet opened and can be cancelled, but the
        // provider produced no progress UI inside the bound.
        try perform("cancel \(providerID) \(method) login", on: requireElement(
            "provider-login-cancel-\(providerID)",
            in: application
        ))
        throw DriverFailure.unexpectedState("\(providerID) \(method) produced no progress UI within 20s")
    }

    try perform("cancel \(providerID) \(method) login", on: requireElement(
        "provider-login-cancel-\(providerID)",
        in: application
    ))
    try waitUntil(15, "\(providerID) sheet back to input state after cancel", in: application) { elements in
        element(withIdentifier: "provider-login-cancel-\(providerID)", in: elements) == nil
    }
    print("LOGIN-CANCEL: \(providerID) \(method) returned-to-input=true")
    try closeSheet(application, providerID: providerID)
}

func expectedProvider(_ id: String) -> ExpectedProvider {
    guard let provider = expectedProviders.first(where: { $0.id == id }) else {
        fatalError("unknown QA provider id: \(id)")
    }
    return provider
}

func closeSheet(_ application: AXUIElement, providerID: String) throws {
    let closeElement = try {
        let deadline = Date().addingTimeInterval(5)
        while true {
            if let button = sheetCloseButton(in: collect(from: application)) {
                return button
            }
            guard Date() < deadline else {
                throw DriverFailure.missingElement("sheet close button for \(providerID)")
            }
            CFRunLoopRunInMode(.defaultMode, 0.2, true)
        }
    }()
    try perform("close \(providerID) sheet", on: closeElement)
    try waitUntil(5, "\(providerID) sheet dismissed", in: application) { elements in
        element(withIdentifier: "provider-save-\(providerID)", in: elements) == nil
            && element(withIdentifier: "provider-login-cancel-\(providerID)", in: elements) == nil
            && element(withIdentifier: "provider-prompt-\(providerID)", in: elements) == nil
            && identifiers(withPrefix: "provider-field-\(providerID)", in: elements).isEmpty
    }
    print("SHEET-CLOSE: \(providerID) closed=true")
}

// MARK: - Live acceptance (opt-in)

enum LiveOutcome {
    case registered
    case rejected(String)
    case skipNoCredential
    case timeout
    case alreadyRegistered

    var token: String {
        switch self {
        case .registered: "REGISTERED"
        case .rejected(let kind): "REJECTED(\(kind))"
        case .skipNoCredential: "SKIP"
        case .timeout: "TIMEOUT"
        case .alreadyRegistered: "ALREADY-REGISTERED"
        }
    }
}

/// Maps the sheet's typed Korean error prose to a machine token. Only the
/// token is reported; no sheet text is echoed verbatim.
func errorToken(_ message: String) -> String {
    if message.contains("인증이 필요") { return "authRequired" }
    if message.contains("시간이 초과") { return "timeout" }
    if message.contains("권한이 없") { return "permissionDenied" }
    if message.contains("한도에 도달") { return "rateLimited" }
    if message.contains("표시할 사용량이 없") { return "noData" }
    if message.contains("저장하지 못했") { return "keychain-write-failed" }
    return "error"
}

/// Reads exactly one line from stdin (the credential channel) without ever
/// printing it. The caller keeps the value only in memory.
func readSecretLine() -> String {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard let line = String(data: data, encoding: .utf8) else { return "" }
    return line.trimmingCharacters(in: .whitespacesAndNewlines)
}

@MainActor
func runLiveAcceptance(
    _ application: AXUIElement,
    providerID: String,
    method: String,
    secret: String
) throws -> LiveOutcome {
    let provider = expectedProvider(providerID)
    guard provider.methods.contains(method) else {
        throw DriverFailure.unexpectedState("\(providerID) does not offer \(method)")
    }
    let actionID = provider.methods[0] == method
        ? "provider-action-\(providerID)"
        : "provider-action-\(providerID)-\(method)"

    let rowButton = element(withIdentifier: "provider-action-\(providerID)", in: application)
    if let rowButton, label(of: rowButton) == "관리" {
        return .alreadyRegistered
    }
    guard let button = element(withIdentifier: actionID, in: application) else {
        throw DriverFailure.missingElement(actionID)
    }
    try perform("open \(providerID) \(method) sheet", on: button)

    if method == "apiKey" {
        guard !secret.isEmpty else {
            try closeSheet(application, providerID: providerID)
            return .skipNoCredential
        }
        let keyField = try waitForIdentifier(
            "provider-field-\(providerID)-apiKey",
            timeout: 10,
            in: application
        )
        // The credential travels only through this in-process AX write.
        try setValue(secret, on: keyField, action: "enter \(providerID) credential")
        try perform("start \(providerID) login", on: requireElement(
            "provider-save-\(providerID)",
            in: application
        ))

        // Alibaba is the only apiKey flow with duplex prompts; answer the
        // region menu and skip the optional cookie prompt. An empty skip
        // answer is never a credential.
        if providerID == "alibaba-token-plan" {
            for _ in 0..<3 {
                let deadline = Date().addingTimeInterval(10)
                var prompt: AXUIElement?
                while prompt == nil {
                    prompt = element(
                        withIdentifier: "provider-prompt-\(providerID)",
                        in: application
                    )
                    if prompt == nil, Date() >= deadline { break }
                    CFRunLoopRunInMode(.defaultMode, 0.2, true)
                }
                guard let currentPrompt = prompt else { break }
                let sensitive = subrole(of: currentPrompt) == "AXSecureTextField"
                if !sensitive {
                    try setValue("1", on: currentPrompt, action: "answer alibaba region prompt")
                }
                try perform("send alibaba prompt answer", on: requireElement(
                    "provider-prompt-send-\(providerID)",
                    in: application
                ))
            }
        }
    }

    // Wait for a terminal state: sheet dismissed (registered) or the sheet
    // back at rest with an error label (rejected). OAuth methods rely on a
    // human finishing in the browser, so the bound is generous.
    let bound: TimeInterval = method == "apiKey" ? 180 : 420
    let deadline = Date().addingTimeInterval(bound)
    while true {
        let elements = collect(from: application)
        let sheetOpen = element(withIdentifier: "provider-save-\(providerID)", in: elements) != nil
            || element(withIdentifier: "provider-login-cancel-\(providerID)", in: elements) != nil
            || !identifiers(withPrefix: "provider-field-\(providerID)", in: elements).isEmpty
        let rowButtonNow = element(withIdentifier: "provider-action-\(providerID)", in: elements)
        if !sheetOpen, let rowButtonNow, label(of: rowButtonNow) == "관리" {
            return .registered
        }
        if sheetOpen, element(withIdentifier: "provider-save-\(providerID)", in: elements) != nil,
           method == "apiKey" || element(withIdentifier: "provider-login-cancel-\(providerID)", in: elements) == nil {
            // The login finished with an error while the sheet stayed open.
            let errorTexts = elements
                .filter { role(of: $0) == kAXImageRole || role(of: $0) == kAXStaticTextRole || role(of: $0) == kAXGroupRole }
                .flatMap(observableText)
                .filter { text in
                    text.contains("인증이 필요")
                        || text.contains("시간이 초과")
                        || text.contains("권한이 없")
                        || text.contains("한도에 도달")
                        || text.contains("표시할 사용량이 없")
                        || text.contains("완료하지 못했")
                        || text.contains("저장하지 못했")
                }
            if let message = errorTexts.first {
                try closeSheet(application, providerID: providerID)
                return .rejected(errorToken(message))
            }
        }
        guard Date() < deadline else {
            if let cancel = element(withIdentifier: "provider-login-cancel-\(providerID)", in: application) {
                try? perform("cancel \(providerID) login after timeout", on: cancel)
            }
            try? closeSheet(application, providerID: providerID)
            return .timeout
        }
        CFRunLoopRunInMode(.defaultMode, 0.5, true)
    }
}

// MARK: - Launch plumbing

@MainActor
func launchApp(scenario: Scenario, path: String) async throws -> (process: Process, pid: Int32) {
    let launchEvent = LaunchEventBox()
    let outputPipe = Pipe()
    let process = Process()
    process.executableURL = URL(fileURLWithPath: path)
    var launchEnvironment = ProcessInfo.processInfo.environment
    launchEnvironment["TOKEN_METER_QA_FIXTURE"] = "1"
    if scenario != .quotaPanel {
        launchEnvironment["TOKEN_METER_QA_OPEN_SETTINGS"] = "1"
    }
    if scenario == .liveAcceptance {
        launchEnvironment["TOKEN_METER_QA_LIVE_USAGE"] = "1"
    }
    process.environment = launchEnvironment
    process.standardOutput = outputPipe
    process.standardError = outputPipe
    outputPipe.fileHandleForReading.readabilityHandler = { handle in
        let data = handle.availableData
        guard !data.isEmpty else { return }
        launchEvent.consume(data, pid: process.processIdentifier)
    }
    do {
        try process.run()
    } catch {
        throw DriverFailure.applicationLaunch(error.localizedDescription)
    }
    let pid = process.processIdentifier
    print("PID: \(pid)")
    let launchedPID = try await launchEvent.wait(timeout: 15, label: "application launch")
    outputPipe.fileHandleForReading.readabilityHandler = nil
    guard launchedPID == pid else {
        process.terminate()
        throw DriverFailure.applicationLaunch("launch notification PID mismatch")
    }
    print("AX_READY: true")
    return (process, pid)
}

@MainActor
func run() async throws {
    let arguments = CommandLine.arguments
    if arguments.dropFirst().first == "nekos-cleanup-test" {
        try await testNekosProcessCleanup()
        return
    }
    if arguments.count > 1, ["nekos-quota", "nekos-baseline"].contains(arguments[1]) {
        try await runNekosScenario(arguments)
        return
    }
    guard arguments.count >= 3, let scenario = Scenario(rawValue: arguments[1]) else {
        throw DriverFailure.invalidArguments
    }
    guard AXIsProcessTrusted() else {
        throw DriverFailure.accessibilityDisabled
    }

    if scenario == .liveAcceptance {
        guard arguments.count == 5 || arguments.count == 6 else {
            throw DriverFailure.invalidArguments
        }
        let liveScreenshotPath = arguments.count == 6 ? arguments[5] : nil
        let distributed = DistributedNotificationCenter.default()
        let captureDoneEvent = LaunchEventBox()
        let notificationQueue = OperationQueue()
        notificationQueue.maxConcurrentOperationCount = 1
        let captureDoneObserver = distributed.addObserver(
            forName: Notification.Name("dev.herdr.token-meter.qa.capture-done"),
            object: nil,
            queue: notificationQueue
        ) { notification in
            guard let pid = notification.userInfo?["pid"] as? NSNumber else { return }
            captureDoneEvent.resolve(.success(pid.int32Value))
        }
        defer { distributed.removeObserver(captureDoneObserver) }
        // The credential arrives on stdin only; it is read before anything
        // is launched and never appears in argv, the environment, or output.
        let secret = readSecretLine()
        let launched = try await launchApp(scenario: scenario, path: arguments[2])
        defer {
            terminateAndWait(launched.process)
            removeQAStoreDirectories(for: launched.pid)
        }
        try unlockWindowContent(pid: launched.pid)
        _ = try waitForIdentifier("provider-management-window", timeout: 10, in: AXUIElementCreateApplication(launched.pid))
        let application = AXUIElementCreateApplication(launched.pid)
        let outcome = try runLiveAcceptance(
            application,
            providerID: arguments[3],
            method: arguments[4],
            secret: secret
        )
        if case .registered = outcome,
           arguments[3] == "kimi-code",
           arguments.count == 6 {
            try verifyLiveKimiQuota(application: application)
            guard let liveScreenshotPath else {
                throw DriverFailure.invalidArguments
            }
            try? FileManager.default.removeItem(atPath: liveScreenshotPath)
            distributed.postNotificationName(
                Notification.Name("dev.herdr.token-meter.qa.capture-window"),
                object: nil,
                userInfo: ["path": liveScreenshotPath],
                deliverImmediately: true
            )
            let capturedPID = try await captureDoneEvent.wait(
                timeout: 10,
                label: "Kimi live window self-capture"
            )
            guard capturedPID == launched.pid else {
                throw DriverFailure.captureFailed("Kimi live self-capture PID mismatch")
            }
            try verifyScreenshot(at: liveScreenshotPath)
            print("PASS: Kimi live quota window captured")
            try removeLiveKimiRegistration(application: application)
        }
        let detail: String
        if case .skipNoCredential = outcome {
            detail = " no-credential"
        } else {
            detail = ""
        }
        print("RESULT: provider=\(arguments[3]) method=\(arguments[4]) status=\(outcome.token)\(detail)")
        return
    }

    guard arguments.count == 5 else {
        throw DriverFailure.invalidArguments
    }
    let captureApp = arguments[3]
    let screenshotPath = arguments[4]

    let launched = try await launchApp(scenario: scenario, path: arguments[2])
    defer {
        terminateAndWait(launched.process)
        removeQAStoreDirectories(for: launched.pid)
    }
    let pid = launched.pid

    let captureSession = UUID().uuidString
    let distributed = DistributedNotificationCenter.default()
    let readyName = Notification.Name(
        "dev.herdr.token-meter.capture.ready.\(captureSession)"
    )
    let captureName = Notification.Name(
        "dev.herdr.token-meter.capture.\(captureSession)"
    )
    let doneName = Notification.Name(
        "dev.herdr.token-meter.capture.done.\(captureSession)"
    )
    let readyEvent = LaunchEventBox()
    let doneEvent = LaunchEventBox()
    let frontReadyEvent = LaunchEventBox()
    let selfCaptureDoneEvent = LaunchEventBox()
    let notificationQueue = OperationQueue()
    notificationQueue.maxConcurrentOperationCount = 1
    let readyObserver = distributed.addObserver(
        forName: readyName,
        object: nil,
        queue: notificationQueue
    ) { notification in
        guard let pid = notification.userInfo?["pid"] as? NSNumber else { return }
        readyEvent.resolve(.success(pid.int32Value))
    }
    let doneObserver = distributed.addObserver(
        forName: doneName,
        object: nil,
        queue: notificationQueue
    ) { _ in
        doneEvent.resolve(.success(0))
    }
    let frontReadyObserver = distributed.addObserver(
        forName: Notification.Name("dev.herdr.token-meter.qa.front-ready"),
        object: nil,
        queue: notificationQueue
    ) { notification in
        guard let pid = notification.userInfo?["pid"] as? NSNumber else { return }
        frontReadyEvent.resolve(.success(pid.int32Value))
    }
    let selfCaptureDoneObserver = distributed.addObserver(
        forName: Notification.Name("dev.herdr.token-meter.qa.capture-done"),
        object: nil,
        queue: notificationQueue
    ) { notification in
        guard let pid = notification.userInfo?["pid"] as? NSNumber else { return }
        selfCaptureDoneEvent.resolve(.success(pid.int32Value))
    }
    defer {
        distributed.removeObserver(readyObserver)
        distributed.removeObserver(doneObserver)
        distributed.removeObserver(frontReadyObserver)
        distributed.removeObserver(selfCaptureDoneObserver)
    }
    try? FileManager.default.removeItem(atPath: screenshotPath)
    let openCapture = Process()
    openCapture.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    openCapture.arguments = [
        "-n",
        captureApp,
        "--args",
        screenshotPath,
        captureSession,
    ]
    do {
        try openCapture.run()
        openCapture.waitUntilExit()
    } catch {
        throw DriverFailure.captureFailed(error.localizedDescription)
    }
    guard openCapture.terminationStatus == 0 else {
        throw DriverFailure.captureFailed(
            "LaunchServices exit \(openCapture.terminationStatus)"
        )
    }
    let captureHelperPID = try await readyEvent.wait(
        timeout: 5,
        label: "capture helper ready"
    )
    defer { kill(captureHelperPID, SIGTERM) }

    if scenario == .providerManagement {
        distributed.postNotificationName(
            Notification.Name("dev.herdr.token-meter.qa.bring-front"),
            object: nil,
            userInfo: nil,
            deliverImmediately: true
        )
        let frontPID = try await frontReadyEvent.wait(
            timeout: 5,
            label: "provider window front"
        )
        guard frontPID == pid else {
            throw DriverFailure.applicationLaunch("provider window PID mismatch")
        }
        try unlockWindowContent(pid: pid)
        print("AX-TREE: unlocked with one real title-bar click (this OS hides fresh background-app window content from AX until a user-equivalent interaction)")
        let application = AXUIElementCreateApplication(pid)
        try exerciseProviderManagement(application)
        distributed.postNotificationName(
            Notification.Name("dev.herdr.token-meter.qa.bring-front"),
            object: nil,
            userInfo: nil,
            deliverImmediately: true
        )
        _ = try await frontReadyEvent.wait(
            timeout: 5,
            label: "provider window front before capture"
        )
        distributed.postNotificationName(
            Notification.Name("dev.herdr.token-meter.qa.capture-window"),
            object: nil,
            userInfo: ["path": screenshotPath],
            deliverImmediately: true
        )
        let capturedPID = try await selfCaptureDoneEvent.wait(
            timeout: 10,
            label: "provider window self-capture"
        )
        guard capturedPID == pid else {
            throw DriverFailure.captureFailed("self-capture PID mismatch")
        }
        try verifyScreenshot(at: screenshotPath)
        print("PASS: hosted provider-management window captured from final build")
        return
    }

    do {
        let application = AXUIElementCreateApplication(pid)
        var observer: AXObserver?
        guard AXObserverCreate(pid, observerCallback, &observer) == .success,
              let observer
        else {
            throw DriverFailure.accessibilityDisabled
        }

        var subscribedNotificationCount = 0
        for notification in [
            kAXWindowCreatedNotification,
            kAXCreatedNotification,
            kAXFocusedUIElementChangedNotification,
        ] {
            let result = AXObserverAddNotification(
                observer,
                application,
                notification as CFString,
                nil
            )
            if result == .success || result == .notificationAlreadyRegistered {
                subscribedNotificationCount += 1
            } else {
                print("NOTICE: subscribe \(notification) unavailable with AXError \(result.rawValue)")
            }
        }
        guard subscribedNotificationCount > 0 else {
            throw DriverFailure.accessibilityDisabled
        }
        CFRunLoopAddSource(
            CFRunLoopGetMain(),
            AXObserverGetRunLoopSource(observer),
            .defaultMode
        )

        var elements = [application] + descendants(of: application)
        if scenario == .quotaPanel {
            let menuBars = children(of: application).filter {
                text(kAXRoleAttribute, of: $0) == kAXMenuBarRole
            }
            guard let statusItem = menuBars.last.flatMap({ children(of: $0).first }) else {
                throw DriverFailure.statusItemUnavailable
            }
            try perform("status item press", on: statusItem)
            try waitForEvent(after: "status item press")
            elements = [application] + descendants(of: application)
        }

        switch scenario {
        case .quotaPanel:
            for expected in [
                "등록된 프로바이더가 없습니다",
                "프로바이더를 등록하면 쿼터가 여기에 표시됩니다.",
                "프로바이더 등록/관리",
            ] where !contains(expected, in: elements) {
                throw DriverFailure.missingElement(expected)
            }
            guard let quotaWindow = elements.first(where: {
                text(kAXRoleAttribute, of: $0) == kAXWindowRole
                    && contains("등록된 프로바이더가 없습니다", in: [$0] + descendants(of: $0))
            }) else {
                throw DriverFailure.missingElement("quota panel window")
            }
            let raiseResult = AXUIElementPerformAction(
                quotaWindow,
                kAXRaiseAction as CFString
            )
            guard raiseResult == .success else {
                throw DriverFailure.actionFailed("raise quota window", raiseResult)
            }
            print("PASS: clean quota panel shows honest unregistered state")

        case .providerManagement, .liveAcceptance:
            break
        }

        try verifyVisibleWindow(
            for: pid,
            screenshotPath: screenshotPath
        )
        distributed.postNotificationName(
            captureName,
            object: nil,
            userInfo: nil,
            deliverImmediately: true
        )
        _ = try await doneEvent.wait(timeout: 10, label: "capture helper done")
        try verifyScreenshot(at: screenshotPath)
    } catch {
        throw error
    }
}

@main
struct TokenMeterAXDriver {
    static func main() async {
        do {
            try await run()
        } catch {
            fputs("ERROR: \(error)\n", stderr)
            exit(2)
        }
    }
}
