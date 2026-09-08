// Strict request encoder for the TokenMeter/1.3.0 bridge protocol.
//
// Emits exactly the locked field set with deterministic key order and
// enforces the 64 KiB request framing bound. The credential union travels
// only inside the request object written to stdin.
import Foundation

public struct UsageRequestEncoder: Sendable {
    public static let protocolSchemaVersion = "1.3.0"
    public static let maximumRequestBytes = 64 * 1024

    public init() {}

    public func encode(_ request: UsageRequest) throws -> Data {
        var object: [String: Any] = [
            "schemaVersion": Self.protocolSchemaVersion,
            "operation": request.operation.rawValue,
            "requestId": request.requestId,
            "providerId": request.providerId,
            "connectorId": request.connectorId,
            "accountRef": request.accountRef,
            "requestedAtMs": NSNumber(value: request.requestedAtMs),
            "deadlineAtMs": NSNumber(value: request.deadlineAtMs),
        ]
        if let credential = request.credential {
            do {
                let encoder = JSONEncoder()
                encoder.outputFormatting = [.sortedKeys]
                let credentialData = try encoder.encode(credential)
                guard let credentialObject = try JSONSerialization.jsonObject(
                    with: credentialData
                ) as? [String: Any] else {
                    throw BridgeServiceError.internalError("request serialization failed")
                }
                object["credential"] = credentialObject
            } catch let error as BridgeServiceError {
                throw error
            } catch {
                throw BridgeServiceError.internalError("request serialization failed")
            }
        }
        let data: Data
        do {
            data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        } catch {
            throw BridgeServiceError.internalError("request serialization failed")
        }
        guard data.count <= Self.maximumRequestBytes else {
            throw BridgeServiceError.invalidProtocol("request exceeds 64 KiB")
        }
        return data
    }
}
