// Typed error taxonomy for the `TokenMeter/1.3.0` bridge protocol and the
// Swift services layered above it (plan: "Protocol decisions" — typed
// errors). The wire carries a closed set of machine-readable codes; cases
// the wire cannot parameterize (timeout, authRequired, …) intentionally drop
// the diagnostic message on decode so equality stays meaningful.
import Foundation

public enum BridgeServiceError: Error, Equatable, Sendable {
    /// Envelope violations: unknown field, wrong schemaVersion, correlation
    /// mismatch, framing/size bounds.
    case invalidProtocol(String)
    /// Request value-domain violations: unknown operation, credential kind,
    /// empty identifiers.
    case invalidRequest(String)
    /// The named provider/connector is not part of the locked registry.
    case invalidProvider(String)
    /// Scheduling/refresh policy violations.
    case policyViolation(String)
    /// No credential is registered for the account.
    case missingCredential
    /// 401-class: the credential was not accepted.
    case authRequired
    /// Ordinary 403-class: authenticated but not permitted.
    case permissionDenied
    /// 429 / rate-limit 403 with an optional Retry-After in milliseconds.
    case rateLimited(retryAfterMs: Int?)
    /// Authorized but nothing to report yet.
    case noData
    /// Process/pipe/network level failure.
    case transport(String)
    /// The deadline elapsed before the upstream answered.
    case timeout
    /// Upstream payload could not be parsed into the value domain.
    case malformedPayload(String)
    /// Upstream payload parsed but is incomplete.
    case partialPayload(String)
    /// Upstream answered with a failure of its own.
    case upstream(String)
    /// A local dependency (bundled bridge helper) failed.
    case dependency(String)
    /// TokenMeter's own bug.
    case internalError(String)
    /// A usage operation failed after rotating a credential. Callers persist
    /// the credential before surfacing `underlying`.
    indirect case credentialUpdated(BridgeCredential, underlying: BridgeServiceError)

    /// A credential rotated before the operation failed, when present.
    public var refreshedCredential: BridgeCredential? {
        if case .credentialUpdated(let credential, _) = self {
            return credential
        }
        return nil
    }

    /// The error to surface after any credential writeback completes.
    public var underlyingError: BridgeServiceError {
        if case .credentialUpdated(_, let underlying) = self {
            return underlying.underlyingError
        }
        return self
    }

    func attaching(refreshedCredential: BridgeCredential?) -> BridgeServiceError {
        guard let refreshedCredential else { return self }
        return .credentialUpdated(refreshedCredential, underlying: self)
    }

    func redacting(secrets: [String]) -> BridgeServiceError {
        guard !secrets.isEmpty else { return self }
        func redact(_ message: String) -> String {
            secrets.reduce(message) { redacted, secret in
                guard !secret.isEmpty else { return redacted }
                return redacted.replacingOccurrences(of: secret, with: "[redacted]")
            }
        }
        switch self {
        case .invalidProtocol(let message): return .invalidProtocol(redact(message))
        case .invalidRequest(let message): return .invalidRequest(redact(message))
        case .invalidProvider(let message): return .invalidProvider(redact(message))
        case .policyViolation(let message): return .policyViolation(redact(message))
        case .transport(let message): return .transport(redact(message))
        case .malformedPayload(let message): return .malformedPayload(redact(message))
        case .partialPayload(let message): return .partialPayload(redact(message))
        case .upstream(let message): return .upstream(redact(message))
        case .dependency(let message): return .dependency(redact(message))
        case .internalError(let message): return .internalError(redact(message))
        case .credentialUpdated(let credential, let underlying):
            return .credentialUpdated(
                credential,
                underlying: underlying.redacting(secrets: secrets)
            )
        case .missingCredential, .authRequired, .permissionDenied,
             .rateLimited, .noData, .timeout:
            return self
        }
    }

    /// The machine-readable wire code for this error.
    public var wireCode: String {
        switch self {
        case .invalidRequest: return "invalidRequest"
        case .invalidProtocol: return "invalidProtocol"
        case .invalidProvider: return "invalidProvider"
        case .policyViolation: return "invalidPolicy"
        case .missingCredential: return "missingCredential"
        case .authRequired: return "authRequired"
        case .permissionDenied: return "permissionDenied"
        case .rateLimited: return "rateLimited"
        case .noData: return "noData"
        case .transport: return "transport"
        case .timeout: return "timeout"
        case .malformedPayload: return "malformedPayload"
        case .partialPayload: return "partialPayload"
        case .upstream: return "upstreamError"
        case .dependency: return "dependencyUnavailable"
        case .internalError: return "internalError"
        case .credentialUpdated(_, let underlying): return underlying.wireCode
        }
    }

    /// The diagnostic message carried on the wire, when the code is
    /// parameterized by one.
    public var wireMessage: String? {
        switch self {
        case .invalidRequest(let message),
             .invalidProtocol(let message),
             .invalidProvider(let message),
             .policyViolation(let message),
             .transport(let message),
             .malformedPayload(let message),
             .partialPayload(let message),
             .upstream(let message),
             .dependency(let message),
             .internalError(let message):
            return message
        case .credentialUpdated(_, let underlying):
            return underlying.wireMessage
        case .missingCredential, .authRequired, .permissionDenied, .noData,
             .timeout, .rateLimited:
            return nil
        }
    }

    /// Maps a wire error envelope onto the typed taxonomy. Returns nil for
    /// codes outside the closed set (callers surface that as
    /// `malformedPayload("unknown error code: …")`).
    public init?(wireCode: String, message: String?, retryAfterMs: Int?) {
        switch wireCode {
        case "invalidRequest":
            self = .invalidRequest(message ?? "invalid request")
        case "invalidProtocol":
            self = .invalidProtocol(message ?? "invalid protocol")
        case "invalidProvider":
            self = .invalidProvider(message ?? "invalid provider")
        case "invalidPolicy":
            self = .policyViolation(message ?? "policy violation")
        case "missingCredential":
            self = .missingCredential
        case "authRequired":
            self = .authRequired
        case "permissionDenied":
            self = .permissionDenied
        case "rateLimited":
            self = .rateLimited(retryAfterMs: retryAfterMs)
        case "noData":
            self = .noData
        case "transport":
            self = .transport(message ?? "transport failure")
        case "timeout":
            self = .timeout
        case "malformedPayload":
            self = .malformedPayload(message ?? "malformed payload")
        case "partialPayload":
            self = .partialPayload(message ?? "partial payload")
        case "upstreamError":
            self = .upstream(message ?? "upstream failure")
        case "dependencyUnavailable":
            self = .dependency(message ?? "dependency failure")
        case "internalError":
            self = .internalError(message ?? "internal error")
        default:
            return nil
        }
    }

    /// 401/ordinary-403 class: the coordinator purges cached last-good data
    /// and suspends refreshing until the credential revision changes (plan:
    /// "Cache/scheduler decisions").
    public var suspendsUntilCredentialChange: Bool {
        switch self {
        case .authRequired, .permissionDenied, .missingCredential:
            return true
        case .credentialUpdated(_, let underlying):
            return underlying.suspendsUntilCredentialChange
        default:
            return false
        }
    }

    /// 429/rate-limit 403 class: last-good is preserved and the retry
    /// deadline comes from `retryAfterMs` (or the backoff cap when absent).
    public var isRateLimited: Bool {
        switch self {
        case .rateLimited:
            return true
        case .credentialUpdated(_, let underlying):
            return underlying.isRateLimited
        default:
            return false
        }
    }
}

extension BridgeCredential {
    var redactionSecrets: [String] {
        switch self {
        case .none:
            return []
        case .staticCredential(_, let secret):
            return secret.isEmpty ? [] : [secret]
        case .oauthCredential(
            let secret,
            let access,
            let refresh,
            _,
            _,
            _,
            _
        ):
            var values = [secret, access]
            if let refresh { values.append(refresh) }
            var seen = Set<String>()
            return values.filter { !$0.isEmpty && seen.insert($0).inserted }
        }
    }
}
