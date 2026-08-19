// Request-side wire types for the `TokenMeter/1.2.0` bridge protocol.
//
// The credential travels only inside request objects, which the
// BridgeClient writes to the helper's stdin pipe — never argv, never the
// environment. TokenMeter/1.2.0 uses a closed credential union:
// static bearer/apiKey secrets and the oauth token bundle whose `secret`
// mirrors `oauth.access`.
import Foundation

public enum UsageOperation: String, Equatable, Sendable {
    case fetchUsage
}

/// The closed credential-kind vocabulary of the wire: `none`, `bearer`,
/// `apiKey`, `oauth`.
public enum CredentialKind: String, Codable, Equatable, Sendable, CaseIterable {
    case none
    case bearer
    case apiKey
    case oauth
}

/// Kinds of the static (non-oauth) union arm.
public enum StaticCredentialKind: String, Equatable, Sendable, CaseIterable {
    case bearer
    case apiKey
}

/// One credential of the TokenMeter/1.2.0 union.
///
/// Wire shape (strict — unknown fields are rejected on decode):
///
///     { "kind": "none" }
///     { "kind": "bearer" | "apiKey", "secret": "…" }
///     { "kind": "oauth", "secret": "…", "oauth": {
///         "access": "…", "refresh": "…", "expiresAtMs": 0,
///         "refreshEndpoint": "…", "clientId": "…",
///         "identity": { "…": "…" } } }
///
/// `secret` mirrors `oauth.access`: both carry the access token and both
/// are redacted on every error path. Optional oauth fields are omitted, not
/// null. `identity` holds non-secret labels only.
public enum BridgeCredential: Equatable, Sendable {
    case none
    case staticCredential(kind: StaticCredentialKind, secret: String)
    case oauthCredential(
        secret: String,
        access: String,
        refresh: String? = nil,
        expiresAtMs: Int64? = nil,
        refreshEndpoint: String? = nil,
        clientId: String? = nil,
        identity: [String: String] = [:]
    )

    /// Convenience for the oauth arm; `secret` mirrors `access` per the
    /// wire contract.
    public static func oauth(
        access: String,
        refresh: String? = nil,
        expiresAtMs: Int64? = nil,
        refreshEndpoint: String? = nil,
        clientId: String? = nil,
        identity: [String: String] = [:]
    ) -> BridgeCredential {
        .oauthCredential(
            secret: access,
            access: access,
            refresh: refresh,
            expiresAtMs: expiresAtMs,
            refreshEndpoint: refreshEndpoint,
            clientId: clientId,
            identity: identity
        )
    }

    /// The union discriminator.
    public var kind: CredentialKind {
        switch self {
        case .none:
            return .none
        case .staticCredential(let staticKind, _):
            switch staticKind {
            case .bearer: return .bearer
            case .apiKey: return .apiKey
            }
        case .oauthCredential:
            return .oauth
        }
    }

    /// The primary secret: the static secret, or the access token the
    /// oauth `secret` mirrors.
    public var secret: String {
        switch self {
        case .none:
            return ""
        case .staticCredential(_, let secret):
            return secret
        case .oauthCredential(let secret, _, _, _, _, _, _):
            return secret
        }
    }

    /// Compatibility initializer for the 1.0.0-era static-credential call
    /// sites.
    @available(*, deprecated, message: "construct .staticCredential(kind:secret:) directly")
    public init(kind: StaticCredentialKind, secret: String) {
        self = .staticCredential(kind: kind, secret: secret)
    }
}

public struct UsageRequest: Equatable, Sendable {
    public let requestId: String
    public let operation: UsageOperation
    public let providerId: String
    public let connectorId: String
    public let accountRef: String
    public let requestedAtMs: Int64
    public let deadlineAtMs: Int64
    public let credential: BridgeCredential?

    public init(
        requestId: String,
        operation: UsageOperation,
        providerId: String,
        connectorId: String,
        accountRef: String,
        requestedAtMs: Int64,
        deadlineAtMs: Int64,
        credential: BridgeCredential? = nil
    ) {
        self.requestId = requestId
        self.operation = operation
        self.providerId = providerId
        self.connectorId = connectorId
        self.accountRef = accountRef
        self.requestedAtMs = requestedAtMs
        self.deadlineAtMs = deadlineAtMs
        self.credential = credential
    }
}

// MARK: - Codable (strict, mirroring the bridge credential parser)

extension BridgeCredential: Codable {
    private enum CodingKeys: String, CodingKey, CaseIterable {
        case kind
        case secret
        case oauth
    }

    private enum OAuthKeys: String, CodingKey, CaseIterable {
        case access
        case refresh
        case expiresAtMs
        case refreshEndpoint
        case clientId
        case identity
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let present = try StrictKeys.present(decoder)
        let kindRaw = try container.decode(String.self, forKey: .kind)
        switch kindRaw {
        case CredentialKind.none.rawValue:
            try StrictKeys.requireExact(
                present,
                required: Set([CodingKeys.kind.stringValue]),
                codingPath: decoder.codingPath
            )
            self = .none
        case CredentialKind.bearer.rawValue, CredentialKind.apiKey.rawValue:
            try StrictKeys.requireExact(
                present,
                required: Set([CodingKeys.kind.stringValue, CodingKeys.secret.stringValue]),
                codingPath: decoder.codingPath
            )
            guard let staticKind = StaticCredentialKind(rawValue: kindRaw) else {
                throw DecodingError.dataCorrupted(.init(
                    codingPath: decoder.codingPath,
                    debugDescription: "unknown credential kind: \(kindRaw)"
                ))
            }
            let secret = try Self.nonEmpty(
                container.decode(String.self, forKey: .secret),
                name: CodingKeys.secret.stringValue,
                codingPath: decoder.codingPath
            )
            self = .staticCredential(kind: staticKind, secret: secret)
        case CredentialKind.oauth.rawValue:
            try StrictKeys.requireExact(
                present,
                required: Set(CodingKeys.allCases.map(\.stringValue)),
                codingPath: decoder.codingPath
            )
            let secret = try Self.nonEmpty(
                container.decode(String.self, forKey: .secret),
                name: CodingKeys.secret.stringValue,
                codingPath: decoder.codingPath
            )
            let oauth = try container.nestedContainer(keyedBy: OAuthKeys.self, forKey: .oauth)
            let nestedPresent = try StrictKeys.nestedPresent(container, key: .oauth)
            let allowed = Set(OAuthKeys.allCases.map(\.stringValue))
            guard nestedPresent.isSubset(of: allowed),
                  nestedPresent.contains(OAuthKeys.access.stringValue) else {
                throw DecodingError.dataCorrupted(.init(
                    codingPath: decoder.codingPath + [CodingKeys.oauth],
                    debugDescription: "credential.oauth must carry access and only known fields"
                ))
            }
            for key in [
                OAuthKeys.refresh, .expiresAtMs, .refreshEndpoint, .clientId, .identity,
            ] where oauth.contains(key) {
                if try oauth.decodeNil(forKey: key) {
                    throw DecodingError.dataCorrupted(.init(
                        codingPath: decoder.codingPath + [CodingKeys.oauth, key],
                        debugDescription: "credential field \"oauth.\(key.stringValue)\" cannot be null"
                    ))
                }
            }
            let access = try Self.nonEmpty(
                oauth.decode(String.self, forKey: .access),
                name: "oauth.access",
                codingPath: decoder.codingPath
            )
            let refresh = try Self.nonEmptyIfPresent(
                oauth.decodeIfPresent(String.self, forKey: .refresh),
                name: "oauth.refresh",
                codingPath: decoder.codingPath
            )
            let expiresAtMs = try oauth.decodeIfPresent(Int64.self, forKey: .expiresAtMs)
            if let expiresAtMs,
               expiresAtMs <= 0 || expiresAtMs > 9_007_199_254_740_991 {
                throw DecodingError.dataCorrupted(.init(
                    codingPath: decoder.codingPath + [CodingKeys.oauth, OAuthKeys.expiresAtMs],
                    debugDescription: "credential field \"oauth.expiresAtMs\" must be a positive safe-integer Unix millisecond timestamp"
                ))
            }
            let refreshEndpoint = try Self.nonEmptyIfPresent(
                oauth.decodeIfPresent(String.self, forKey: .refreshEndpoint),
                name: "oauth.refreshEndpoint",
                codingPath: decoder.codingPath
            )
            let clientId = try Self.nonEmptyIfPresent(
                oauth.decodeIfPresent(String.self, forKey: .clientId),
                name: "oauth.clientId",
                codingPath: decoder.codingPath
            )
            let identity = try oauth.decodeIfPresent([String: String].self, forKey: .identity) ?? [:]
            self = .oauthCredential(
                secret: secret,
                access: access,
                refresh: refresh,
                expiresAtMs: expiresAtMs,
                refreshEndpoint: refreshEndpoint,
                clientId: clientId,
                identity: identity
            )
        default:
            throw DecodingError.dataCorrupted(.init(
                codingPath: decoder.codingPath,
                debugDescription: "unknown credential kind: \(kindRaw)"
            ))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .none:
            try container.encode(CredentialKind.none.rawValue, forKey: .kind)
        case .staticCredential(let kind, let secret):
            try container.encode(kind.rawValue, forKey: .kind)
            try container.encode(secret, forKey: .secret)
        case .oauthCredential(
            let secret,
            let access,
            let refresh,
            let expiresAtMs,
            let refreshEndpoint,
            let clientId,
            let identity
        ):
            try container.encode(CredentialKind.oauth.rawValue, forKey: .kind)
            try container.encode(secret, forKey: .secret)
            var oauth = container.nestedContainer(keyedBy: OAuthKeys.self, forKey: .oauth)
            try oauth.encode(access, forKey: .access)
            try oauth.encodeIfPresent(refresh, forKey: .refresh)
            try oauth.encodeIfPresent(expiresAtMs, forKey: .expiresAtMs)
            try oauth.encodeIfPresent(refreshEndpoint, forKey: .refreshEndpoint)
            try oauth.encodeIfPresent(clientId, forKey: .clientId)
            if !identity.isEmpty {
                try oauth.encode(identity, forKey: .identity)
            }
        }
    }

    private static func nonEmpty(
        _ value: String,
        name: String,
        codingPath: [CodingKey]
    ) throws -> String {
        guard !value.isEmpty else {
            throw DecodingError.dataCorrupted(.init(
                codingPath: codingPath,
                debugDescription: "credential field \"\(name)\" must be a non-empty string"
            ))
        }
        return value
    }

    private static func nonEmptyIfPresent(
        _ value: String?,
        name: String,
        codingPath: [CodingKey]
    ) throws -> String? {
        guard let value else { return nil }
        return try nonEmpty(value, name: name, codingPath: codingPath)
    }
}
