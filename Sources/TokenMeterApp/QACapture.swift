#if TOKEN_METER_QA
import AppKit
import CryptoKit
import ImageIO
import UniformTypeIdentifiers

enum QACaptureError: Error {
    case invalidPNG, identityMismatch, unavailableTarget, clippedControl
}

/// Shared only by the QA app, AX driver and supplemental tests. A sheet image
/// is its complete content, not a purported composite of the parent window.
struct QACaptureReceipt: Codable, Sendable {
    let requestID: String
    let pid: Int32
    let state: String
    let path: String
    let target: String
    let windowID: Int
    let parentWindowID: Int
    let contentBounds: CGRect // AppKit screen coordinates (bottom-left origin).
    let scale: Double
    let width: Int
    let height: Int
    let sha256: String
    let compositing: String
    let ownWindowResult: String

    static func decodePNG(_ data: Data) throws -> CGImage {
        guard data.starts(with: [137, 80, 78, 71, 13, 10, 26, 10]),
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              CGImageSourceGetType(source) as String? == UTType.png.identifier,
              CGImageSourceGetCount(source) == 1,
              CGImageSourceGetStatus(source) == .statusComplete,
              let image = CGImageSourceCreateImageAtIndex(source, 0,
                  [kCGImageSourceShouldCacheImmediately: true] as CFDictionary),
              CGImageSourceGetStatusAtIndex(source, 0) == .statusComplete,
              image.width > 0, image.height > 0 else { throw QACaptureError.invalidPNG }
        return image
    }

    func validate(data: Data, requestID: String, pid: Int32, state: String,
                  path: String, target: String?) throws {
        let image = try Self.decodePNG(data)
        guard self.requestID == requestID, self.pid == pid, self.state == state,
              self.path == path, target == nil || self.target == target,
              ["parent-content", "attached-sheet-content"].contains(self.target),
              windowID > 0, parentWindowID > 0,
              (self.target == "parent-content") == (windowID == parentWindowID),
              contentBounds.width > 0, contentBounds.height > 0,
              scale.isFinite, scale > 0,
              (compositing == "captured" && ownWindowResult == "image")
                || (compositing == "compositing-not-captured"
                    && ["nil", "crop-nil", "symbol-unavailable"].contains(ownWindowResult)),
              width == image.width, height == image.height,
              abs(Double(width) - contentBounds.width * scale) <= 1,
              abs(Double(height) - contentBounds.height * scale) <= 1,
              sha256 == SHA256.hash(data: data).map({ String(format: "%02x", $0) }).joined()
        else { throw QACaptureError.identityMismatch }
    }

    func validateControls(_ bounds: [CGRect]) throws {
        guard !bounds.isEmpty, bounds.allSatisfy({ !$0.isEmpty && contentBounds.contains($0) })
        else { throw QACaptureError.clippedControl }
    }
}

@MainActor
enum QAWindowCapture {
    // The SDK obsoletes this API in macOS 15. Resolve the requested legacy
    // own-window probe at runtime, without requesting capture permission or
    // weakening compiler diagnostics. The Create rule transfers ownership.
    private typealias WindowImage = @convention(c) (CGRect, UInt32, UInt32, UInt32) -> Unmanaged<CGImage>?

    static func pixelCrop(_ bounds: CGRect, windowFrame: CGRect, scale: CGFloat) -> CGRect {
        CGRect(x: (bounds.minX - windowFrame.minX) * scale,
            y: (windowFrame.maxY - bounds.maxY) * scale,
            width: bounds.width * scale, height: bounds.height * scale)
    }

    private static func compositedImage(window: NSWindow, bounds: CGRect) -> (CGImage?, String) {
        guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGWindowListCreateImage") else {
            return (nil, "symbol-unavailable")
        }
        let createImage = unsafeBitCast(symbol, to: WindowImage.self)
        let windowID = CGWindowID(window.windowNumber)
        let options = CGWindowListOption.optionIncludingWindow.rawValue
        let resolution = CGWindowImageOption.bestResolution.rawValue
        guard createImage(.null, options, windowID, resolution)?.takeRetainedValue() != nil else {
            return (nil, "nil")
        }
        // Remove shadow ornamentation to establish the window-frame origin.
        // Keep null screen bounds: a global-rectangle capture clips windows
        // crossing the display edge. Crop locally, never guess shadow insets.
        guard let image = createImage(.null, options, windowID,
                  resolution | CGWindowImageOption.boundsIgnoreFraming.rawValue)?.takeRetainedValue(),
              let cropped = image.cropping(to: pixelCrop(bounds, windowFrame: window.frame,
                  scale: CGFloat(image.width) / window.frame.width)) else { return (nil, "crop-nil") }
        return (cropped, "image")
    }

    static func parentWindow(windowNumber: Int?, hosted: NSWindow?, windows: [NSWindow]) throws -> NSWindow {
        let parent = windowNumber.map { number in windows.first { $0.windowNumber == number } } ?? hosted
        guard let parent, parent.isVisible else { throw QACaptureError.unavailableTarget }
        return parent
    }

    static func selectedWindow(parent: NSWindow, target: String?) throws -> NSWindow {
        let selected = parent.attachedSheet ?? parent
        let actual = selected === parent ? "parent-content" : "attached-sheet-content"
        guard parent.isVisible, selected.isVisible, target == nil || target == actual else {
            throw QACaptureError.unavailableTarget
        }
        return selected
    }

    static func capture(parent: NSWindow, requestID: String, state: String,
                        path: String, target: String?) throws -> QACaptureReceipt {
        let window = try selectedWindow(parent: parent, target: target)
        guard let view = window.contentView else { throw QACaptureError.unavailableTarget }
        view.layoutSubtreeIfNeeded()
        view.displayIfNeeded()
        window.displayIfNeeded()
        let contentBounds = window.convertToScreen(view.convert(view.bounds, to: nil))
        let compositedBounds = window === parent ? contentBounds : window.frame
        let (composite, ownWindowResult) = compositedImage(window: window, bounds: compositedBounds)
        let bitmap: NSBitmapImageRep
        if let composite {
            bitmap = NSBitmapImageRep(cgImage: composite)
        } else {
            guard let cached = view.bitmapImageRepForCachingDisplay(in: view.bounds) else {
                throw QACaptureError.unavailableTarget
            }
            view.cacheDisplay(in: view.bounds, to: cached)
            bitmap = cached
        }
        guard let data = bitmap.representation(using: .png, properties: [:]) else {
            throw QACaptureError.invalidPNG
        }
        let image = try QACaptureReceipt.decodePNG(data)
        let receipt = QACaptureReceipt(requestID: requestID,
            pid: ProcessInfo.processInfo.processIdentifier, state: state, path: path,
            target: window === parent ? "parent-content" : "attached-sheet-content",
            windowID: window.windowNumber, parentWindowID: parent.windowNumber,
            contentBounds: composite == nil ? contentBounds : compositedBounds,
            scale: window.backingScaleFactor, width: image.width, height: image.height,
            sha256: SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined(),
            compositing: composite == nil ? "compositing-not-captured" : "captured",
            ownWindowResult: ownWindowResult)
        try receipt.validate(data: data, requestID: requestID, pid: receipt.pid,
            state: state, path: path, target: target)
        try data.write(to: URL(fileURLWithPath: path), options: .atomic)
        return receipt
    }
}
#endif
