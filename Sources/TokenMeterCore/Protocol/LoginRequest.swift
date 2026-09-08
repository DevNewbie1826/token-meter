// Request-side wire types for the TokenMeter/1.3.0 `login --stdin`
// command. The request is written only to the helper's stdin.
import Foundation

/// Login methods a provider auth module can offer.
public enum AuthMethod: String, Codable, Equatable, Sendable, CaseIterable {
    case apiKey
    case browser
    case device
}

/// Structured login inputs. Every field is optional; absent fields are
/// omitted from the wire object.
public struct LoginInputs: Equatable, Sendable {
    public let apiKey: String?
    public let apiBaseUrl: String?
    public let cookieHeader: String?
    public let enterpriseHost: String?

    public init(
        apiKey: String? = nil,
        apiBaseUrl: String? = nil,
        cookieHeader: String? = nil,
        enterpriseHost: String? = nil
    ) {
        self.apiKey = apiKey
        self.apiBaseUrl = apiBaseUrl
        self.cookieHeader = cookieHeader
        self.enterpriseHost = enterpriseHost
    }
}

/// One request for the bridge helper's `login --stdin` command.
public struct LoginRequest: Equatable, Sendable {
    public let providerId: String
    public let method: AuthMethod
    public let requestedAtMs: Int64
    public let deadlineAtMs: Int64
    public let inputs: LoginInputs?

    public init(
        providerId: String,
        method: AuthMethod,
        requestedAtMs: Int64,
        deadlineAtMs: Int64,
        inputs: LoginInputs? = nil
    ) {
        self.providerId = providerId
        self.method = method
        self.requestedAtMs = requestedAtMs
        self.deadlineAtMs = deadlineAtMs
        self.inputs = inputs
    }
}

/// Strict request encoder for `login --stdin`. Emits exactly the locked
/// field set with deterministic key order and enforces the 64 KiB request
/// framing bound.
public struct LoginRequestEncoder: Sendable {
    public static let protocolSchemaVersion = "1.3.0"
    public static let maximumRequestBytes = 64 * 1024

    public init() {}

    public func encode(_ request: LoginRequest) throws -> Data {
        var object: [String: Any] = [
            "schemaVersion": Self.protocolSchemaVersion,
            "providerId": request.providerId,
            "method": request.method.rawValue,
            "requestedAtMs": NSNumber(value: request.requestedAtMs),
            "deadlineAtMs": NSNumber(value: request.deadlineAtMs),
        ]
        if let inputs = request.inputs {
            var inputObject: [String: Any] = [:]
            if let apiKey = inputs.apiKey { inputObject["apiKey"] = apiKey }
            if let apiBaseUrl = inputs.apiBaseUrl { inputObject["apiBaseUrl"] = apiBaseUrl }
            if let cookieHeader = inputs.cookieHeader { inputObject["cookieHeader"] = cookieHeader }
            if let enterpriseHost = inputs.enterpriseHost { inputObject["enterpriseHost"] = enterpriseHost }
            object["inputs"] = inputObject
        }

        let data: Data
        do {
            data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        } catch {
            throw BridgeServiceError.internalError("login request serialization failed")
        }
        guard data.count <= Self.maximumRequestBytes else {
            throw BridgeServiceError.invalidProtocol("login request exceeds 64 KiB")
        }
        return data
    }
}
