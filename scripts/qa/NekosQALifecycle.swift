import AppKit
import Foundation

/// Kernel exit observation, not an optimistic NSRunningApplication request.
func stopOwnedNekosProcess(pid: Int32) async throws {
    let registered = LaunchEventBox()
    let exited = LaunchEventBox()
    let source = DispatchSource.makeProcessSource(identifier: pid, eventMask: .exit, queue: .global())
    source.setRegistrationHandler { registered.resolve(.success(pid)) }
    source.setEventHandler { exited.resolve(.success(pid)) }
    source.resume()
    defer { source.cancel() }
    _ = try await registered.wait(timeout: 5, label: "process-exit subscription")
    guard kill(pid, SIGTERM) == 0 else {
        if errno == ESRCH {
            print("EXIT-CONFIRMED: owned PID=\(pid) already absent (ESRCH)")
            return
        }
        throw DriverFailure.applicationLaunch("owned PID \(pid) SIGTERM failed: errno \(errno)")
    }
    _ = try await exited.wait(timeout: 10, label: "owned process exit")
    print("EXIT-CONFIRMED: kernel process-exit event pid=\(pid)")
}

func cleanupNekosApplication(pid: Int32) async throws {
    // Reap only direct helpers of this owned app before terminating their parent.
    let children = Process()
    let output = Pipe()
    children.executableURL = URL(fileURLWithPath: "/usr/bin/pgrep")
    children.arguments = ["-P", String(pid)]
    children.standardOutput = output
    try children.run()
    children.waitUntilExit()
    guard children.terminationStatus == 0 || children.terminationStatus == 1 else {
        throw DriverFailure.applicationLaunch("owned child enumeration failed")
    }
    let data = output.fileHandleForReading.readDataToEndOfFile()
    for line in String(decoding: data, as: UTF8.self).split(separator: "\n") {
        guard let childPID = Int32(line) else { throw DriverFailure.unexpectedState("invalid child PID") }
        try await stopOwnedNekosProcess(pid: childPID)
    }
    try await stopOwnedNekosProcess(pid: pid)
    for scope in ["menu", "settings", "credentials"] {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("TokenMeter-QA-\(pid)-\(scope)")
        if FileManager.default.fileExists(atPath: directory.path) {
            try FileManager.default.removeItem(at: directory)
        }
    }
    print("CLEANUP: scenario PID=\(pid) exit confirmed; isolated stores removed")
}

@MainActor
func launchNekosApplication(path: String) async throws -> NSRunningApplication {
    let session = UUID().uuidString
    let ready = LaunchEventBox()
    let notifications = DistributedNotificationCenter.default()
    let queue = OperationQueue()
    queue.maxConcurrentOperationCount = 1
    let observer = notifications.addObserver(
        forName: Notification.Name("dev.herdr.token-meter.qa.ready.\(session)"), object: nil, queue: queue
    ) { notification in
        if let pid = notification.userInfo?["pid"] as? NSNumber { ready.resolve(.success(pid.int32Value)) }
    }
    defer { notifications.removeObserver(observer) }
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.createsNewApplicationInstance = true
    configuration.activates = true
    var environment = ["TOKEN_METER_QA_FIXTURE": "1", "TOKEN_METER_QA_OPEN_SETTINGS": "1",
                       "TOKEN_METER_QA_SESSION": session]
    environment["TOKEN_METER_QA_NEKOS_BRIDGE"] = ProcessInfo.processInfo.environment["TOKEN_METER_QA_NEKOS_BRIDGE"]
    configuration.environment = environment
    let bundle = URL(fileURLWithPath: path).deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent()
    let application = try await NSWorkspace.shared.openApplication(at: bundle, configuration: configuration)
    let pid = application.processIdentifier
    print("PID: \(pid)")
    print("LAUNCH: NSWorkspace application=\(application.localizedName ?? "unknown") executable=\(application.executableURL?.path ?? "unknown") finished=\(application.isFinishedLaunching) active=\(application.isActive)")
    print("LAUNCH-WINDOWS: \(visibleWindowIDs(for: pid))")
    fflush(stdout)
    do {
        let readyPID = try await ready.wait(timeout: 20, label: "exact QA launch readiness")
        guard readyPID == pid else { throw DriverFailure.applicationLaunch("ready PID mismatch") }
    } catch {
        print("LAUNCH-STATE: finished=\(application.isFinishedLaunching) active=\(application.isActive) terminated=\(application.isTerminated)")
        try await cleanupNekosApplication(pid: pid)
        throw error
    }
    print("READY: exact session notification pid=\(pid)")
    return application
}

func testNekosProcessCleanup() async throws {
    // Given: a real owned child blocked on stdin, not a timer or mocked app.
    let process = Process()
    let input = Pipe()
    process.executableURL = URL(fileURLWithPath: "/bin/cat")
    process.standardInput = input
    process.standardOutput = FileHandle.nullDevice
    try process.run()
    // When
    try await stopOwnedNekosProcess(pid: process.processIdentifier)
    // Then: reaping completes and the OS reports signal termination.
    process.waitUntilExit()
    guard process.terminationReason == .uncaughtSignal, process.terminationStatus == SIGTERM else {
        throw DriverFailure.unexpectedState("owned child did not terminate from SIGTERM")
    }
    print("PASS: owned child termination observed by kernel and reaped")
}
