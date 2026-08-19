import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit
import UniformTypeIdentifiers

enum CaptureFailure: Error, CustomStringConvertible {
    case missingOutputPath
    case missingSession
    case permissionRequired
    case noDisplay
    case imageDestination
    case imageWrite

    var description: String {
        switch self {
        case .missingOutputPath:
            return "missing output PNG path"
        case .missingSession:
            return "missing capture session"
        case .permissionRequired:
            return "Screen Recording permission is required for TokenMeterQACapture"
        case .noDisplay:
            return "no active display is available"
        case .imageDestination:
            return "could not create PNG destination"
        case .imageWrite:
            return "could not finalize PNG"
        }
    }
}

final class CaptureSignal: @unchecked Sendable {
    private let lock = NSLock()
    private var signaled = false
    private var continuation: CheckedContinuation<Void, Never>?

    func signal() {
        lock.lock()
        signaled = true
        let waitingContinuation = continuation
        continuation = nil
        lock.unlock()
        waitingContinuation?.resume()
    }

    func wait() async {
        await withCheckedContinuation { continuation in
            lock.lock()
            if signaled {
                lock.unlock()
                continuation.resume()
            } else {
                self.continuation = continuation
                lock.unlock()
            }
        }
    }
}

@main
struct TokenMeterQACapture {
    static func main() async {
        let distributed = DistributedNotificationCenter.default()
        var doneName: Notification.Name?
        do {
            guard CommandLine.arguments.count >= 2 else {
                throw CaptureFailure.missingOutputPath
            }
            guard CommandLine.arguments.count == 3 else {
                throw CaptureFailure.missingSession
            }
            guard CGPreflightScreenCaptureAccess() else {
                _ = CGRequestScreenCaptureAccess()
                throw CaptureFailure.permissionRequired
            }

            let session = CommandLine.arguments[2]
            let captureName = Notification.Name("dev.herdr.token-meter.capture.\(session)")
            let readyName = Notification.Name("dev.herdr.token-meter.capture.ready.\(session)")
            doneName = Notification.Name("dev.herdr.token-meter.capture.done.\(session)")
            let signal = CaptureSignal()
            let notificationQueue = OperationQueue()
            notificationQueue.maxConcurrentOperationCount = 1
            let observer = distributed.addObserver(
                forName: captureName,
                object: nil,
                queue: notificationQueue
            ) { _ in
                signal.signal()
            }
            distributed.postNotificationName(
                readyName,
                object: nil,
                userInfo: ["pid": ProcessInfo.processInfo.processIdentifier],
                deliverImmediately: true
            )
            await signal.wait()
            distributed.removeObserver(observer)

            let content = try await SCShareableContent.excludingDesktopWindows(
                false,
                onScreenWindowsOnly: true
            )
            guard let display = content.displays.first else {
                throw CaptureFailure.noDisplay
            }

            let filter = SCContentFilter(display: display, excludingWindows: [])
            let configuration = SCStreamConfiguration()
            configuration.width = display.width
            configuration.height = display.height
            configuration.showsCursor = false

            let image = try await SCScreenshotManager.captureImage(
                contentFilter: filter,
                configuration: configuration
            )
            let outputURL = URL(fileURLWithPath: CommandLine.arguments[1]) as CFURL
            guard let destination = CGImageDestinationCreateWithURL(
                outputURL,
                UTType.png.identifier as CFString,
                1,
                nil
            ) else {
                throw CaptureFailure.imageDestination
            }

            CGImageDestinationAddImage(destination, image, nil)
            guard CGImageDestinationFinalize(destination) else {
                throw CaptureFailure.imageWrite
            }
            print("PASS: captured \(image.width)x\(image.height) to \(CommandLine.arguments[1])")
            if let doneName {
                distributed.postNotificationName(
                    doneName,
                    object: nil,
                    userInfo: ["status": "ok"],
                    deliverImmediately: true
                )
            }
        } catch {
            if let doneName {
                distributed.postNotificationName(
                    doneName,
                    object: nil,
                    userInfo: ["status": "error"],
                    deliverImmediately: true
                )
            }
            fputs("ERROR: \(error)\n", stderr)
            exit(error is CaptureFailure ? 3 : 1)
        }
    }
}
