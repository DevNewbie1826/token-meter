// Response-side wire types for the TokenMeter/1.2.0 `login --stdin`
// command: the final response object on stdout and newline-delimited
// AuthEvent progress objects on stderr.
import Foundation

public enum AuthInputKind: String, Equatable, Sendable, CaseIterable {
    case text
    case code
    case redirectUrl
    case cookieHeader
    case apiBaseUrl
}

/// One progress event from a provider auth module. Events are advisory:
/// non-event stderr lines are skipped rather than failing the login.
public enum AuthEvent: Equatable, Sendable {
    case openUrl(url: String)
    case code(code: String, verificationUrl: String)
    case waiting(detail: String)
    case pasteHint(detail: String)
    case prompt(
        requestId: String,
        prompt: String,
        inputKind: AuthInputKind,
        sensitive: Bool
    )

    /// Strictly parses one NDJSON line. Returns nil for unknown event types,
    /// missing fields, unknown fields or non-JSON stderr output.
    public static func parse(_ line: String) -> AuthEvent? {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              let object = (try? JSONSerialization.jsonObject(with: Data(trimmed.utf8))) as? [String: Any],
              let type = object["type"] as? String
        else {
            return nil
        }
        switch type {
        case "openUrl":
            guard object.count == 2,
                  let url = object["url"] as? String,
                  !url.isEmpty else { return nil }
            return .openUrl(url: url)
        case "code":
            guard object.count == 3,
                  let code = object["code"] as? String,
                  !code.isEmpty,
                  let verificationUrl = object["verificationUrl"] as? String,
                  !verificationUrl.isEmpty else { return nil }
            return .code(code: code, verificationUrl: verificationUrl)
        case "waiting":
            guard object.count == 2,
                  let detail = object["detail"] as? String,
                  !detail.isEmpty else { return nil }
            return .waiting(detail: detail)
        case "pasteHint":
            guard object.count == 2,
                  let detail = object["detail"] as? String,
                  !detail.isEmpty else { return nil }
            return .pasteHint(detail: detail)
        case "prompt":
            guard object.count == 5,
                  let requestId = object["requestId"] as? String,
                  !requestId.isEmpty,
                  let prompt = object["prompt"] as? String,
                  !prompt.isEmpty,
                  let inputKindRaw = object["inputKind"] as? String,
                  let inputKind = AuthInputKind(rawValue: inputKindRaw),
                  let sensitiveNumber = object["sensitive"] as? NSNumber,
                  StrictJSON.isBoolean(sensitiveNumber)
            else { return nil }
            return .prompt(
                requestId: requestId,
                prompt: prompt,
                inputKind: inputKind,
                sensitive: sensitiveNumber.boolValue
            )
        default:
            return nil
        }
    }
}

/// A successful login: the minted credential and an optional non-secret
/// account label.
public struct LoginSuccess: Equatable, Sendable {
    public let providerId: String
    public let completedAtMs: Int64
    public let credential: BridgeCredential
    public let accountLabel: String?

    public init(
        providerId: String,
        completedAtMs: Int64,
        credential: BridgeCredential,
        accountLabel: String? = nil
    ) {
        self.providerId = providerId
        self.completedAtMs = completedAtMs
        self.credential = credential
        self.accountLabel = accountLabel
    }
}

/// The final outcome of one login command.
public enum LoginResult: Equatable, Sendable {
    case success(LoginSuccess)
    case failure(BridgeServiceError)
}

/// Strict decoder for the login response object written to stdout.
public struct LoginResponseDecoder: Sendable {
    public static let protocolSchemaVersion = "1.2.0"
    public static let maximumResponseBytes = 2 * 1024 * 1024

    private static let successEnvelopeKeys: Set<String> = [
        "schemaVersion", "providerId", "status", "completedAtMs",
        "credential", "accountLabel",
    ]
    private static let errorEnvelopeKeys: Set<String> = [
        "schemaVersion", "providerId", "status", "completedAtMs", "error",
    ]

    public init() {}

    public func decode(_ data: Data) throws -> LoginResult {
        guard data.count <= Self.maximumResponseBytes else {
            throw BridgeServiceError.invalidProtocol("response exceeds 2 MiB")
        }
        guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw BridgeServiceError.invalidProtocol("response is not a JSON object")
        }
        guard let schemaVersion = object["schemaVersion"] as? String else {
            throw BridgeServiceError.invalidProtocol(
                "unsupported schemaVersion: \(StrictJSON.describe(object["schemaVersion"]))"
            )
        }
        guard schemaVersion == Self.protocolSchemaVersion else {
            throw BridgeServiceError.invalidProtocol("unsupported schemaVersion: \(schemaVersion)")
        }
        guard let status = object["status"] as? String else {
            throw BridgeServiceError.invalidProtocol("missing status")
        }
        switch status {
        case "ok":
            return .success(try Self.decodeSuccess(object))
        case "error":
            try StrictJSON.rejectUnknownKeys(object, allowed: Self.errorEnvelopeKeys)
            if let rawProviderId = object["providerId"] {
                guard let providerId = rawProviderId as? String, !providerId.isEmpty else {
                    throw BridgeServiceError.invalidProtocol("invalid providerId")
                }
            }
            _ = try StrictJSON.requiredInteger(object["completedAtMs"], name: "completedAtMs")
            return .failure(try StrictJSON.decodeErrorPayload(object["error"] as Any))
        default:
            throw BridgeServiceError.invalidProtocol("unknown status: \(status)")
        }
    }

    private static func decodeSuccess(_ object: [String: Any]) throws -> LoginSuccess {
        try StrictJSON.rejectUnknownKeys(object, allowed: successEnvelopeKeys)
        let providerId = try StrictJSON.requiredString(object["providerId"], name: "providerId")
        let completedAtMs = try StrictJSON.requiredInteger(object["completedAtMs"], name: "completedAtMs")
        guard let rawCredential = object["credential"] as? [String: Any] else {
            throw BridgeServiceError.invalidProtocol("invalid credential")
        }
        let credential: BridgeCredential
        do {
            let data = try JSONSerialization.data(withJSONObject: rawCredential)
            credential = try JSONDecoder().decode(BridgeCredential.self, from: data)
        } catch {
            throw BridgeServiceError.invalidProtocol("invalid credential")
        }
        var accountLabel: String?
        if let rawAccountLabel = object["accountLabel"] {
            guard let label = rawAccountLabel as? String, !label.isEmpty else {
                throw BridgeServiceError.invalidProtocol("invalid accountLabel")
            }
            accountLabel = label
        }
        return LoginSuccess(
            providerId: providerId,
            completedAtMs: completedAtMs,
            credential: credential,
            accountLabel: accountLabel
        )
    }
}
