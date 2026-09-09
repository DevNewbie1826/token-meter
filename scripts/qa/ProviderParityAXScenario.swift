import AppKit
import ApplicationServices
import Foundation

private let parityScenarios = ["management", "empty", "xai-80", "xai-87.5", "xai-89.9", "xai-95", "xai-99.9",
    "xai-overage", "zai-mixed", "ag-remaining", "ag-weekly", "cursor-used", "opencode-12", "nekos"]

@MainActor
func runProviderParity(_ arguments: [String]) async throws {
    guard arguments.count == 5 else { throw DriverFailure.invalidArguments }
    guard AXIsProcessTrusted() else { throw DriverFailure.accessibilityDisabled }
    let scenario = arguments[1] == "provider-management" ? "management"
        : arguments[1] == "quota-panel" ? "empty" : arguments[3]
    guard parityScenarios.contains(scenario) else { throw DriverFailure.invalidArguments }
    let application = try await launchNekosApplication(path: arguments[2], scenario: scenario)
    let pid = application.processIdentifier
    let outcome: Result<Void, Error>
    do {
        let driver = try ParityDriver(pid: pid, screenshot: arguments[4])
        if scenario == "empty" { try await driver.emptyMenu() }
        else {
            try driver.exposeWindow()
            if scenario == "management" { try await driver.management() }
            else { try await driver.data(scenario) }
        }
        outcome = .success(())
    } catch { outcome = .failure(error) }
    try await cleanupNekosApplication(pid: pid)
    try outcome.get()
    print("PASS: offline native scenario=\(scenario); not live upstream authentication")
}

@MainActor
private final class ParityDriver {
    let pid: Int32
    let app: AXUIElement
    let signal: NekosAXSignal
    let screenshot: String
    private var captureIndex = 0

    init(pid: Int32, screenshot: String) throws {
        self.pid = pid
        self.app = AXUIElementCreateApplication(pid)
        self.signal = try NekosAXSignal(pid: pid)
        self.screenshot = screenshot
    }

    func exposeWindow() throws {
        try signal.wait("production management window exposed", until: {
            element(withIdentifier: "provider-management-window", in: $0) != nil
        }) {
            _ = NSRunningApplication(processIdentifier: pid)?.activate(options: [.activateAllWindows])
            let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
                as? [[String: Any]] ?? []
            guard let bounds = windows.first(where: {
                ($0[kCGWindowOwnerPID as String] as? Int32) == pid
                    && (($0[kCGWindowBounds as String] as? [String: Double])?["Width"] ?? 0) > 100
            })?[kCGWindowBounds as String] as? [String: Double],
                  let x = bounds["X"], let y = bounds["Y"], let width = bounds["Width"] else {
                throw DriverFailure.noVisibleWindow(pid)
            }
            for kind in [CGEventType.leftMouseDown, .leftMouseUp] {
                CGEvent(mouseEventSource: nil, mouseType: kind,
                    mouseCursorPosition: CGPoint(x: x + width / 2, y: y + 12), mouseButton: .left)?.post(tap: .cghidEventTap)
            }
        }
    }

    func capture(_ state: String, sheet: Bool = false) async throws {
        captureIndex += 1
        let path = captureIndex == 1 ? screenshot
            : URL(fileURLWithPath: screenshot).deletingPathExtension().path + "-\(captureIndex)-\(state).png"
        let receipt = try await captureNekosWindow(for: pid, at: path, state: state,
            target: sheet ? "attached-sheet-content" : "parent-content")
        guard visibleWindowIDs(for: pid).contains(receipt.windowID) else {
            throw DriverFailure.captureFailed("selected window is not on screen")
        }
        if sheet {
            // AX uses the primary display's top-left; receipt uses AppKit's
            // screen coordinates. Check every current sheet field/control,
            // including the internal close button, without reading secrets.
            let controls = collect(from: app).filter { control in
                ["provider-field-", "provider-account-label-", "provider-save-",
                 "provider-login-cancel-", "provider-prompt-", "provider-prompt-send-"].contains { prefix in
                    identifier(of: control).hasPrefix(prefix)
                }
            }
            var bounds = controls.map { frame(of: $0) }
            if let close = sheetCloseButton(in: collect(from: app)) { bounds.append(frame(of: close)) }
            guard let primary = NSScreen.screens.first else { throw DriverFailure.captureFailed("no primary screen") }
            try receipt.validateControls(bounds.map {
                CGRect(x: $0.minX, y: primary.frame.maxY - $0.maxY, width: $0.width, height: $0.height)
            })
            print("AX-PASS: complete sheet control bounds count=\(bounds.count) window=\(receipt.windowID)")
        }
        print("STATE: \(state) capture=\(path)")
    }

    func press(_ id: String, expecting condition: @escaping ([AXUIElement]) -> Bool) throws {
        let target = try requireElement(id, in: app)
        try signal.wait(id, until: condition) { try perform(id, on: target) }
    }

    private func fingerprint(in viewport: AXUIElement) -> [String] {
        collect(from: viewport).filter { role(of: $0) == kAXRowRole }
            .map { String(describing: frame(of: $0)) }
    }

    private func scroll(in viewport: AXUIElement, lines: Int) throws {
        let before = fingerprint(in: viewport)
        let outline = collect(from: viewport).first { role(of: $0) == kAXOutlineRole } ?? viewport
        let rectangle = frame(of: outline).intersection(frame(of: viewport))
        guard !rectangle.isEmpty else { throw DriverFailure.missingElement("scroll viewport bounds") }
        let savedCursor = CGEvent(source: nil)?.location ?? .zero
        defer {
            CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: savedCursor,
                mouseButton: .left)?.post(tap: .cghidEventTap)
        }
        try signal.wait("native scroll changed viewport", until: { [self] _ in fingerprint(in: viewport) != before }) {
            CGEvent(mouseEventSource: nil, mouseType: .mouseMoved,
                mouseCursorPosition: CGPoint(x: rectangle.midX, y: rectangle.midY), mouseButton: .left)?.post(tap: .cghidEventTap)
            let wheel = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 1,
                wheel1: Int32(lines), wheel2: 0, wheel3: 0)
            wheel?.location = CGPoint(x: rectangle.midX, y: rectangle.midY)
            wheel?.post(tap: .cghidEventTap)
        }
    }

    private func listViewport() throws -> AXUIElement {
        var viewport: AXUIElement?
        try signal.wait("provider list scroll area", until: { elements in
            viewport = elements.first { element in
                role(of: element) == kAXScrollAreaRole
                    && collect(from: element).contains { identifier(of: $0).hasPrefix("provider-action-") }
            }
            return viewport != nil
        }) {}
        guard let viewport else {
            throw DriverFailure.missingElement("provider list scroll area")
        }
        return viewport
    }

    private func reveal(_ initialElement: AXUIElement, in viewport: AXUIElement) throws {
        let targetID = identifier(of: initialElement)
        let current = {
            let rows = collect(from: viewport).filter { role(of: $0) == kAXOutlineRole }
                .flatMap { attribute(kAXRowsAttribute, of: $0) as? [AXUIElement] ?? [] }
            return rows.compactMap { element(withIdentifier: targetID, in: $0) }.first
                ?? element(withIdentifier: targetID, in: viewport)
        }
        let visible = {
            guard let target = current() else { return false }
            let bounds = frame(of: target)
            let intersection = frame(of: viewport).intersection(bounds)
            if !bounds.isEmpty && !intersection.isNull,
               intersection.width * intersection.height >= bounds.width * bounds.height * 0.9 { return true }
            return false
        }
        if visible() { return }
        // SwiftUI's offscreen controls can advertise AXScrollToVisible but
        // return notImplemented/illegalArgument. Wheel input targets the real
        // outline and each event must move row geometry before continuing.
        for _ in 0..<30 {
            guard let target = current() else { throw DriverFailure.missingElement(targetID) }
            try scroll(in: viewport, lines: frame(of: target).midY < frame(of: viewport).minY ? 4 : -4)
            if visible() {
                print("AX-PASS: reveal visible identifier=\(targetID)")
                return
            }
        }
        throw DriverFailure.unexpectedState("reveal visibility \(targetID)")
    }

    private func seek(_ action: String) throws {
        let list = try listViewport()
        // A dismissed sheet can recreate the list before its buttons enter the
        // application's AX tree. Wait for rows, then discover virtualized rows.
        try signal.wait("provider rows ready for \(action)", until: { _ in
            collect(from: list).contains { role(of: $0) == kAXRowRole }
        }) {}
        for _ in 0..<expectedProviders.count {
            if element(withIdentifier: action, in: app) != nil {
                try signal.wait("action exposed \(action)", until: {
                    element(withIdentifier: action, in: $0) != nil
                }) {}
                try reveal(requireElement(action, in: app), in: list)
                return
            }
            let targetIndex = expectedProviders.firstIndex { $0.actionIdentifiers.contains(action) } ?? 0
            let indices = expectedProviders.indices.filter { index in
                expectedProviders[index].actionIdentifiers.contains { element(withIdentifier: $0, in: app) != nil }
            }
            try scroll(in: list, lines: targetIndex < (indices.min() ?? 0) ? 4 : -4)
        }
        throw DriverFailure.missingElement(action)
    }

    func management() async throws {
        print("POLICY: management pending auth is simulated UI progress, not provider-auth proof")
        var evidence = RowEvidence()
        let expected = Set(expectedProviders.flatMap(\.actionIdentifiers))
        let viewport = try listViewport()
        guard let outline = collect(from: viewport).first(where: { role(of: $0) == kAXOutlineRole }) else {
            throw DriverFailure.missingElement("provider outline")
        }
        // AXRows exposes all rows; AXChildren omits some offscreen rows.
        scanRows(into: &evidence, application: outline)
        for row in attribute(kAXRowsAttribute, of: outline) as? [AXUIElement] ?? [] {
            scanRows(into: &evidence, application: row)
            print("OUTLINE-ROW: frame=\(frame(of: row)) identifiers=\(identifiers(withPrefix: "provider-action-", in: collect(from: row))) captions=\(collect(from: row).filter { role(of: $0) == kAXStaticTextRole }.map { text(kAXValueAttribute, of: $0) })")
        }
        print("COVERAGE: collected=\(evidence.allActionIds.sorted()) expected=\(expected.sorted())")
        print("COVERAGE: missing=\(expected.subtracting(evidence.allActionIds).sorted()) unexpected=\(evidence.allActionIds.subtracting(expected).sorted()) disabled=\(evidence.disabledButtons.sorted())")
        guard expectedProviders.count == 17, evidence.allActionIds == expected,
              evidence.disabledButtons.isEmpty else { throw DriverFailure.unexpectedState("canonical17 action coverage") }
        for provider in expectedProviders {
            guard evidence.idCaptions.contains(provider.id) else { throw DriverFailure.missingElement(provider.id) }
            for (index, method) in provider.methods.enumerated() {
                let id = provider.actionIdentifiers[index]
                guard evidence.buttonTitles[id] == actionTitle(for: method) else { throw DriverFailure.unexpectedState(id) }
                print("ACTION: \(id) enabled=true method=\(method)")
            }
        }
        print("AX-PASS: canonical17 providers, all declared actions observed in AXRows")
        // Discovery is complete. Scrolling now proves visual coverage only.
        for (position, provider) in expectedProviders.enumerated() {
            let rows = attribute(kAXRowsAttribute, of: outline) as? [AXUIElement] ?? []
            guard let target = rows.compactMap({ element(withIdentifier: provider.actionIdentifiers[0], in: $0) }).first else {
                throw DriverFailure.missingElement(provider.actionIdentifiers[0])
            }
            try reveal(target, in: viewport)
            try await capture("management-scroll-\(position)")
            let path = captureIndex == 1 ? screenshot
                : URL(fileURLWithPath: screenshot).deletingPathExtension().path + "-\(captureIndex)-management-scroll-\(position).png"
            let receipt = try JSONDecoder().decode(QACaptureReceipt.self, from: Data(contentsOf: URL(fileURLWithPath: path + ".json")))
            print("SCROLL-CAPTURE: position=\(position) provider=\(provider.id) sha256=\(receipt.sha256)")
        }
        for (id, method, fields) in [
            ("opencode-go", "apiKey", ["apiKey", "account-label"]),
            ("alibaba-token-plan", "apiKey", ["apiKey", "cookieHeader", "apiBaseUrl", "account-label"]),
            ("github-copilot", "device", ["enterpriseHost"]),
        ] {
            let action = "provider-action-\(id)" + (method == expectedProvider(id).methods[0] ? "" : "-\(method)")
            try seek(action)
            try press(action) { element(withIdentifier: "provider-save-\(id)", in: $0) != nil }
            for field in fields {
                let identifier = field == "account-label" ? "provider-account-label-\(id)" : "provider-field-\(id)-\(field)"
                let element = try requireElement(identifier, in: app)
                let secure = field == "apiKey" || field == "cookieHeader"
                guard (subrole(of: element) == "AXSecureTextField") == secure else { throw DriverFailure.unexpectedState(identifier) }
            }
            guard sheetCloseButton(in: collect(from: app)) != nil else { throw DriverFailure.missingElement("sheet close") }
            try await capture("sheet-\(id)-\(method)", sheet: true)
            try close(id)
            try await capture("management-restored-\(id)-\(method)")
        }
        // Actual duplex protocol prompts, but deliberately simulated provider
        // progress. No key is ever entered in the management-only scenario.
        try seek("provider-action-alibaba-token-plan")
        try press("provider-action-alibaba-token-plan") { element(withIdentifier: "provider-save-alibaba-token-plan", in: $0) != nil }
        try press("provider-save-alibaba-token-plan") { element(withIdentifier: "provider-prompt-alibaba-token-plan", in: $0) != nil }
        try await capture("alibaba-region", sheet: true)
        try setValue("1", on: requireElement("provider-prompt-alibaba-token-plan", in: app), action: "QA region input")
        try press("provider-prompt-send-alibaba-token-plan") {
            element(withIdentifier: "provider-prompt-alibaba-token-plan", in: $0).map { subrole(of: $0) == "AXSecureTextField" } == true
        }
        try await capture("alibaba-sensitive-prompt", sheet: true)
        try await cancel("alibaba-token-plan")
        for (id, method) in [("anthropic", "browser"), ("kimi-code", "device"), ("openai-codex", "browser"), ("openai-codex", "device")] {
            let action = "provider-action-\(id)" + (method == expectedProvider(id).methods[0] ? "" : "-\(method)")
            try seek(action)
            try press(action) {
                element(withIdentifier: "provider-login-cancel-\(id)", in: $0) != nil
                    && contains("https://example.invalid/qa-pending", in: $0)
                    && (method != "device" || contains("QA-ONLY", in: $0))
            }
            try await capture("pending-\(id)-\(method)", sheet: true)
            try await cancel(id, method: method)
        }
        let authFile = FileManager.default.temporaryDirectory
            .appendingPathComponent("TokenMeter-QA-\(pid)-credentials/auth.json")
        guard !FileManager.default.fileExists(atPath: authFile.path) else {
            throw DriverFailure.unexpectedState("management scenario persisted credentials")
        }
        print("AX-PASS: management final auth-file absent; both openai-codex methods completed")
    }

    private func close(_ id: String) throws {
        guard let button = sheetCloseButton(in: collect(from: app)) else { throw DriverFailure.missingElement("sheet close") }
        try signal.wait("sheet dismissed \(id)", until: {
            element(withIdentifier: "provider-save-\(id)", in: $0) == nil && sheetCloseButton(in: $0) == nil
                && element(withIdentifier: "provider-management-window", in: $0) != nil
        }) { try perform("close sheet", on: button) }
    }

    private func cancel(_ id: String, method: String? = nil) async throws {
        try press("provider-login-cancel-\(id)") {
            element(withIdentifier: "provider-login-cancel-\(id)", in: $0) == nil
                && element(withIdentifier: "provider-save-\(id)", in: $0) != nil
        }
        try await capture("cancelled-\(id)" + (method.map { "-\($0)" } ?? ""), sheet: true)
        try close(id)
        print("AX-PASS: cancel reaped login and restored input provider=\(id)")
    }

    func emptyMenu() async throws {
        // MenuBarExtra propagates the panel identifier to its children on this
        // OS. Require the actual registration button, not just that identifier.
        let registrationButton: ([AXUIElement]) -> AXUIElement? = { elements in
            elements.first {
                role(of: $0) == kAXButtonRole && (identifier(of: $0) == "provider-management-button"
                    || (identifier(of: $0) == "token-meter-menu-panel" && label(of: $0) == "프로바이더 등록/관리"))
            }
        }
        do {
            try signal.wait("native status window available", until: { [self] _ in
                let windows = CGWindowListCopyWindowInfo([.excludeDesktopElements], kCGNullWindowID)
                    as? [[String: Any]] ?? []
                return windows.contains { ($0[kCGWindowOwnerPID as String] as? Int32) == pid }
                    || attribute(kAXExtrasMenuBarAttribute, of: app) != nil
            }) {
                _ = NSRunningApplication(processIdentifier: pid)?.activate(options: [.activateAllWindows])
            }
        } catch {
            let windows = CGWindowListCopyWindowInfo([.excludeDesktopElements], kCGNullWindowID)
                as? [[String: Any]] ?? []
            print("STATUS-WINDOWS: \(windows.filter { ($0[kCGWindowOwnerPID as String] as? Int32) == pid })")
            throw error
        }
        try signal.wait("actual empty menu panel", until: {
            let windows = CGWindowListCopyWindowInfo([.excludeDesktopElements], kCGNullWindowID)
                as? [[String: Any]] ?? []
            print("STATUS-WINDOWS-AFTER: \(windows.filter { ($0[kCGWindowOwnerPID as String] as? Int32) == self.pid })")
            for item in $0 where [kAXWindowRole, kAXButtonRole, kAXStaticTextRole].contains(role(of: item)) {
                print("STATUS-AX: role=\(role(of: item)) id=\(identifier(of: item)) frame=\(frame(of: item)) text=\(observableText(of: item))")
            }
            return contains("등록된 프로바이더가 없습니다", in: $0)
                && registrationButton($0) != nil
        }) {
            _ = NSRunningApplication(processIdentifier: pid)?.activate(options: [.activateAllWindows])
            let windows = CGWindowListCopyWindowInfo([.excludeDesktopElements], kCGNullWindowID)
                as? [[String: Any]] ?? []
            let bounds = windows.compactMap { info -> CGRect? in
                guard (info[kCGWindowOwnerPID as String] as? Int32) == pid,
                      (info[kCGWindowLayer as String] as? Int) == Int(CGWindowLevelForKey(.statusWindow)),
                      let raw = info[kCGWindowBounds as String] as? [String: Double],
                      let x = raw["X"], let y = raw["Y"], let width = raw["Width"], let height = raw["Height"],
                      width > 0, width < 200, height > 0, height <= 40,
                      NSScreen.screens.contains(where: { abs(y - (NSScreen.screens[0].frame.maxY - $0.frame.maxY)) < 40 })
                else { return nil }
                return CGRect(x: x, y: y, width: width, height: height)
            }
            if let rectangle = bounds.first {
                print("STATUS-ITEM: pid=\(pid) bounds=\(rectangle) source=CGWindowList")
                for kind in [CGEventType.leftMouseDown, .leftMouseUp] {
                    CGEvent(mouseEventSource: nil, mouseType: kind,
                        mouseCursorPosition: CGPoint(x: rectangle.midX, y: rectangle.midY), mouseButton: .left)?.post(tap: .cghidEventTap)
                }
            } else {
                let extraRoot = attribute(kAXExtrasMenuBarAttribute, of: app)
                let candidates = extraRoot.map { collect(from: $0 as! AXUIElement) }
                    ?? collect(from: AXUIElementCreateSystemWide())
                let extras = candidates.filter { element in
                    var owner: pid_t = 0
                    AXUIElementGetPid(element, &owner)
                    return owner == pid && role(of: element) == kAXMenuBarItemRole
                }
                guard let item = extras.first else {
                    print("STATUS-WINDOWS: \(windows.filter { ($0[kCGWindowOwnerPID as String] as? Int32) == pid })")
                    throw DriverFailure.statusItemUnavailable
                }
                print("STATUS-ITEM: pid=\(pid) source=AXExtrasMenuBar action=AXPress")
                try perform("native status item", on: item)
            }
        }
        try await captureObservedWindow(identifier: "token-meter-menu-panel", state: "empty-menu", path: screenshot)
        guard let button = registrationButton(collect(from: app)) else {
            throw DriverFailure.missingElement("empty panel registration button")
        }
        try signal.wait("empty panel registration navigation", until: {
            element(withIdentifier: "provider-management-window", in: $0) != nil
        }) { try perform("empty panel registration button", on: button) }
        let path = URL(fileURLWithPath: screenshot).deletingPathExtension().path + "-registration.png"
        try await captureObservedWindow(identifier: "provider-management-window", state: "empty-registration", path: path)
    }

    private func captureObservedWindow(identifier: String, state: String, path: String) async throws {
        guard let window = collect(from: app).first(where: {
            role(of: $0) == kAXWindowRole && element(withIdentifier: identifier, in: $0) != nil
        }) else { throw DriverFailure.missingElement("capture window \(identifier)") }
        let bounds = frame(of: window)
        let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
            as? [[String: Any]] ?? []
        let matches = windows.filter {
            guard ($0[kCGWindowOwnerPID as String] as? Int32) == pid,
                  let raw = $0[kCGWindowBounds as String] as? [String: Double],
                  let rectangle = CGRect(dictionaryRepresentation: raw as CFDictionary) else { return false }
            return rectangle == bounds
        }
        guard matches.count == 1, let number = matches[0][kCGWindowNumber as String] as? Int else {
            throw DriverFailure.captureFailed("ambiguous observed window \(identifier)")
        }
        let receipt = try await captureNekosWindow(for: pid, at: path, state: state,
            target: "parent-content", windowNumber: number)
        guard visibleWindowIDs(for: pid).contains(receipt.windowID) else {
            throw DriverFailure.captureFailed("captured panel is no longer onscreen")
        }
    }

    func data(_ scenario: String) async throws {
        let id: String
        if scenario.hasPrefix("xai-") { id = "xai-oauth" }
        else if scenario.hasPrefix("ag-") { id = "google-antigravity" }
        else { id = ["zai-mixed": "zai", "cursor-used": "cursor", "opencode-12": "opencode-go", "nekos": "nekos"][scenario]! }
        let action = "provider-action-\(id)" + (id == "cursor" ? "-apiKey" : "")
        try seek(action)
        let keyMethod = !scenario.hasPrefix("xai-") && !scenario.hasPrefix("ag-")
        if keyMethod {
            try press(action) { element(withIdentifier: "provider-field-\(id)-apiKey", in: $0) != nil }
            try setValue(UUID().uuidString, on: requireElement("provider-field-\(id)-apiKey", in: app), action: "enter fixture-only key")
            try press("provider-save-\(id)") { element(withIdentifier: "nekos-qa-refresh-count", in: $0).map { text(kAXValueAttribute, of: $0) == "1" } == true }
        } else {
            try press(action) { element(withIdentifier: "nekos-qa-refresh-count", in: $0).map { text(kAXValueAttribute, of: $0) == "1" } == true }
        }
        var viewport: AXUIElement?
        try signal.wait("quota viewport", until: { elements in
            viewport = elements.first { element in
                role(of: element) == kAXScrollAreaRole
                    && collect(from: element).contains {
                        identifier(of: $0) == "provider-management-button"
                            || identifier(of: $0).hasPrefix("quota-row-")
                    }
            }
            return viewport != nil
        }) {}
        guard let panel = viewport else { throw DriverFailure.missingElement("quota viewport") }
        try await capture("\(scenario)-registered")
        let expected = expectedRows(scenario)
        for (index, parts) in expected.enumerated() {
            var found: AXUIElement?
            for _ in 0..<20 {
                found = collect(from: panel).first { element in
                    guard identifier(of: element).hasPrefix("quota-row-") else { return false }
                    let values = observableText(of: element)
                    return values.contains { value in
                        let amount = value.components(separatedBy: ", ").dropFirst().first ?? ""
                        return parts.allSatisfy { part in
                            if part.hasSuffix("%") { return amount == "\(part) 사용" }
                            if part.hasSuffix(" 남음") || part.hasSuffix(" 사용") { return amount == part }
                            return value.contains(part)
                        }
                    }
                }
                if found != nil { break }
                try scroll(in: panel, lines: -3)
            }
            guard let row = found else { throw DriverFailure.missingElement("quota row \(parts)") }
            try reveal(row, in: panel)
            if scenario == "ag-remaining" || scenario == "cursor-used" {
                guard !label(of: row).contains("%") else { throw DriverFailure.unexpectedState("invented fraction") }
            }
            print("ROW: scenario=\(scenario) index=\(index) label=\(label(of: row)) frame=\(frame(of: row))")
            try await capture("\(scenario)-row-\(index)")
        }
        if scenario == "nekos" {
            try press("provider-refresh-nekos") { element(withIdentifier: "nekos-qa-refresh-count", in: $0).map { text(kAXValueAttribute, of: $0) == "2" } == true }
            try await capture("nekos-refreshed")
        }
    }
}

private func expectedRows(_ scenario: String) -> [[String]] {
    if scenario == "xai-overage" { return [["SuperGrok Monthly Included", "120%", "소진"], ["On-demand", "120%", "소진"]] }
    if scenario.hasPrefix("xai-") {
        let percent = String(scenario.dropFirst(4))
        return ["SuperGrok Weekly Credits", "Grok Build (Weekly)", "On-demand", "SuperGrok Monthly Included"].map {
            [$0, "\(percent)%", (Double(percent) ?? 0) >= 95 ? "위험" : "주의"]
        }
    }
    switch scenario {
    case "zai-mixed": return [["ZAI 5 Hours Credit Quota", "80%", "주의"], ["ZAI 5 Hours Token Quota", "79.99%", "주의"], ["ZAI Request Quota", "94.99%", "주의"], ["ZAI Weekly Credit Quota", "99.99%", "위험"]]
    case "ag-remaining": return [["Remaining quota", "42.5 units 남음", "알 수 없음"], ["Usage,", "0 units 남음", "알 수 없음"]]
    case "ag-weekly": return [["Usage", "99%", "위험", "리셋 정보 없음"], ["Usage", "10%", "정상"]]
    case "cursor-used": return [["coreRequests requests", "42.5 requests 사용", "알 수 없음"]]
    case "opencode-12": return [["5 Hour limit (rate-limited)", "12%", "정상"], ["Weekly limit", "20%"], ["Monthly limit", "30%"]]
    case "nekos": return [["전체 · 3시간", "0%"], ["전체 · 일간", "0%"], ["전체 · 주간", "18.39%"], ["fable · 일간", "0%"], ["fable · 주간", "33.55%"]]
    default: return []
    }
}
