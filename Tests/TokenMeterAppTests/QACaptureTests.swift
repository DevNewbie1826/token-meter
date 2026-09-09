#if TOKEN_METER_QA
import AppKit
import CryptoKit
import XCTest
@testable import TokenMeterApp

final class QACaptureTests: XCTestCase {
    private func png() throws -> Data {
        let bitmap = try XCTUnwrap(NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 48,
            pixelsHigh: 32, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
            isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0))
        memset(try XCTUnwrap(bitmap.bitmapData), 0, bitmap.bytesPerRow * bitmap.pixelsHigh)
        return try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
    }

    private func receipt(_ data: Data) -> QACaptureReceipt {
        QACaptureReceipt(requestID: "request-1", pid: 123, state: "sheet-open", path: "/qa/capture.png",
            target: "attached-sheet-content", windowID: 22, parentWindowID: 11,
            contentBounds: CGRect(x: 10, y: 20, width: 24, height: 16), scale: 2,
            width: 48, height: 32, sha256: SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined(),
            compositing: "captured", ownWindowResult: "image")
    }

    private func validate(_ receipt: QACaptureReceipt, _ data: Data) throws {
        try receipt.validate(data: data, requestID: "request-1", pid: 123, state: "sheet-open",
            path: "/qa/capture.png", target: "attached-sheet-content")
    }

    func testPNGRequiresSignatureCompleteDecodeAndDimensions() throws {
        let data = try png()
        let image = try QACaptureReceipt.decodePNG(data)
        XCTAssertEqual(image.width, 48)
        XCTAssertEqual(image.height, 32)
        XCTAssertThrowsError(try QACaptureReceipt.decodePNG(Data("not an image".utf8)))
        XCTAssertThrowsError(try QACaptureReceipt.decodePNG(Data(data.prefix(8))))
        XCTAssertThrowsError(try QACaptureReceipt.decodePNG(Data(data.prefix(data.count / 2))))
        let bitmap = try XCTUnwrap(NSBitmapImageRep(data: data))
        let jpeg = try XCTUnwrap(bitmap.representation(using: .jpeg, properties: [:]))
        XCTAssertThrowsError(try QACaptureReceipt.decodePNG(jpeg))
    }

    func testEveryReceiptIdentityFieldRejectsMutation() throws {
        let data = try png()
        let original = receipt(data)
        try validate(original, data)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(original)) as? [String: Any])
        let mutations: [String: Any] = ["requestID": "stale", "pid": 124, "state": "dismissed",
            "path": "/qa/other.png", "target": "parent-content", "windowID": 11,
            "parentWindowID": 22, "width": 1, "height": 1, "scale": 1, "sha256": "wrong",
            "compositing": "compositing-not-captured", "ownWindowResult": "nil"]
        for (field, value) in mutations {
            var changed = object
            changed[field] = value
            let mutated = try JSONDecoder().decode(QACaptureReceipt.self,
                from: JSONSerialization.data(withJSONObject: changed))
            XCTAssertThrowsError(try validate(mutated, data), field)
        }
    }

    func testCompleteControlBoundsCannotPassClippedOrEmptyControls() throws {
        let capture = receipt(try png())
        try capture.validateControls([CGRect(x: 10, y: 20, width: 24, height: 16)])
        XCTAssertThrowsError(try capture.validateControls([]))
        XCTAssertThrowsError(try capture.validateControls([.zero]))
        XCTAssertThrowsError(try capture.validateControls([CGRect(x: 10, y: 20, width: 25, height: 16)]))
    }

    func testFallbackReceiptCannotClaimCompositedPixels() throws {
        let data = try png()
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(receipt(data))) as? [String: Any])
        object["compositing"] = "compositing-not-captured"
        for result in ["nil", "crop-nil", "symbol-unavailable"] {
            object["ownWindowResult"] = result
            let fallback = try JSONDecoder().decode(QACaptureReceipt.self,
                from: JSONSerialization.data(withJSONObject: object))
            try validate(fallback, data)
        }
        object["ownWindowResult"] = "image"
        let invalid = try JSONDecoder().decode(QACaptureReceipt.self,
            from: JSONSerialization.data(withJSONObject: object))
        XCTAssertThrowsError(try validate(invalid, data))
    }

    @MainActor
    func testContentCropUsesWindowLocalPixelsIncludingOffscreenWindows() {
        let frame = CGRect(x: -200, y: 100, width: 480, height: 264)
        XCTAssertEqual(QAWindowCapture.pixelCrop(CGRect(x: -200, y: 100, width: 480, height: 240),
            windowFrame: frame, scale: 2), CGRect(x: 0, y: 48, width: 960, height: 480))
        XCTAssertEqual(QAWindowCapture.pixelCrop(frame, windowFrame: frame, scale: 2),
            CGRect(x: 0, y: 0, width: 960, height: 528))
    }

    @MainActor
    func testExplicitWindowSelectionNeverFallsBackToHostedWindow() throws {
        _ = NSApplication.shared
        let hosted = NSWindow(contentRect: CGRect(x: -10000, y: -10000, width: 600, height: 400),
            styleMask: [.titled], backing: .buffered, defer: false)
        let panel = NSPanel(contentRect: CGRect(x: -10000, y: -10000, width: 420, height: 520),
            styleMask: [.borderless], backing: .buffered, defer: false)
        for window in [hosted, panel] {
            window.isReleasedWhenClosed = false
            window.animationBehavior = .none
            window.orderBack(nil)
        }
        defer { for window in [hosted, panel] { window.orderOut(nil); window.close() } }
        let windows = [hosted, panel]
        XCTAssertTrue(try QAWindowCapture.parentWindow(windowNumber: nil, hosted: hosted, windows: windows) === hosted)
        XCTAssertTrue(try QAWindowCapture.parentWindow(windowNumber: panel.windowNumber, hosted: nil, windows: windows) === panel)
        XCTAssertThrowsError(try QAWindowCapture.parentWindow(windowNumber: -1, hosted: hosted, windows: windows))
        panel.orderOut(nil)
        XCTAssertThrowsError(try QAWindowCapture.parentWindow(windowNumber: panel.windowNumber, hosted: hosted, windows: windows))
    }

    @MainActor
    func testAttachedSheetSelectionUsesActualAppKitRelationship() throws {
        // Supplemental AppKit relationship test, NOT a native GUI screenshot.
        // Offscreen windows do not establish AX, native drawn controls or layout.
        _ = NSApplication.shared
        let parent = NSWindow(contentRect: CGRect(x: -10000, y: -10000, width: 600, height: 400),
            styleMask: [.titled], backing: .buffered, defer: false)
        let sheet = NSWindow(contentRect: CGRect(x: -10000, y: -10000, width: 480, height: 240),
            styleMask: [.titled], backing: .buffered, defer: false)
        parent.isReleasedWhenClosed = false
        sheet.isReleasedWhenClosed = false
        parent.animationBehavior = .none
        sheet.animationBehavior = .none
        defer {
            if parent.attachedSheet != nil { parent.endSheet(sheet) }
            sheet.orderOut(nil)
            parent.orderOut(nil)
            sheet.close()
            parent.close()
        }
        parent.orderBack(nil)
        XCTAssertThrowsError(try QAWindowCapture.selectedWindow(parent: parent, target: "attached-sheet-content"))
        XCTAssertTrue(try QAWindowCapture.selectedWindow(parent: parent, target: "parent-content") === parent)
        parent.beginSheet(sheet)
        XCTAssertTrue(parent.attachedSheet === sheet)
        XCTAssertTrue(try QAWindowCapture.selectedWindow(parent: parent, target: "attached-sheet-content") === sheet)
        XCTAssertThrowsError(try QAWindowCapture.selectedWindow(parent: parent, target: "parent-content"))
        let output = FileManager.default.temporaryDirectory.appendingPathComponent("QACapture-unit-\(UUID().uuidString).png")
        addTeardownBlock {
            if FileManager.default.fileExists(atPath: output.path) { try FileManager.default.removeItem(at: output) }
        }
        let captured = try QAWindowCapture.capture(parent: parent, requestID: "unit-sheet",
            state: "supplemental-offscreen-not-gui", path: output.path, target: "attached-sheet-content")
        XCTAssertEqual(captured.windowID, sheet.windowNumber)
        XCTAssertEqual(captured.parentWindowID, parent.windowNumber)
        XCTAssertEqual(captured.contentBounds.size, try XCTUnwrap(sheet.contentView).bounds.size)
        XCTAssertNotEqual(captured.contentBounds.size, try XCTUnwrap(parent.contentView).bounds.size)
        try captured.validate(data: Data(contentsOf: output), requestID: "unit-sheet",
            pid: ProcessInfo.processInfo.processIdentifier, state: "supplemental-offscreen-not-gui",
            path: output.path, target: "attached-sheet-content")
        sheet.orderOut(nil)
        XCTAssertThrowsError(try QAWindowCapture.selectedWindow(parent: parent, target: "attached-sheet-content"))
    }
}
#endif
