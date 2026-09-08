// Test-only stdin decoder for actual compiled OpenCode provider responses.
import Foundation
import TokenMeterCore

struct DecodedWindow: Encodable {
    let id: String
    let used: Double?
    let fraction: Double?
    let label: String?
}

let data = FileHandle.standardInput.readDataToEndOfFile()
do {
    let response = try UsageResponseDecoder().decode(
        data,
        expectingRequestId: "00000000-0000-4000-8000-000000000001",
        expectingProviderId: "opencode-go",
        expectingConnectorId: "opencode-go",
        expectingAccountRef: "00000000-0000-4000-8000-000000000002"
    )
    switch response {
    case .report(let report):
        guard report.limits.count == 3 else { fatalError("missing windows") }
        let values = report.limits.map { limit in
            DecodedWindow(id: limit.limitId, used: limit.utilization.used,
                          fraction: limit.utilization.fraction, label: limit.label)
        }
        let encoded = try JSONEncoder().encode(values)
        FileHandle.standardOutput.write(encoded)
        FileHandle.standardOutput.write(Data("\n".utf8))
    case .failure(let error):
        print("ACCEPT typed error \(error)")
    }
} catch {
    FileHandle.standardError.write(Data("REJECT \(error)\n".utf8))
    exit(1)
}
