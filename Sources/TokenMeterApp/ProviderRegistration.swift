import Foundation
import TokenMeterCore

/// One registration action exposed by a provider's synchronized manifest.
/// The API-key action also carries the static credential kind declared by
/// the provider; the credential itself is always minted by the bridge.
enum ProviderRegistrationMethod: Equatable, Sendable, Identifiable {
    case apiKey(StaticCredentialKind)
    case browser
    case device

    var id: String { authMethod.rawValue }

    var authMethod: AuthMethod {
        switch self {
        case .apiKey: .apiKey
        case .browser: .browser
        case .device: .device
        }
    }
}

struct ProviderRegistrationCapability: Equatable, Sendable {
    let methods: [ProviderRegistrationMethod]
    let allowsBlankAPIKey: Bool
}

// MARK: - Provider-specific login input fields

/// The structured input slots the login sheet can collect. These mirror the
/// `LoginInputs` wire fields; nothing here invents a new auth method —
/// methods still come from the canonical manifest.
enum ProviderLoginFieldKind: String, Equatable, Sendable, CaseIterable {
    case apiKey
    case cookieHeader
    case apiBaseUrl
    case enterpriseHost
}

struct ProviderLoginField: Equatable, Identifiable, Sendable {
    let kind: ProviderLoginFieldKind
    let isOptional: Bool
    let isSecure: Bool
    let isMultiline: Bool

    var id: String { kind.rawValue }
}

/// The one small typed policy for provider-specific extra fields. Every
/// provider defaults to the manifest-derived key field; Alibaba's browser
/// session adds the cookie/base-URL inputs and GitHub's device flow adds the
/// optional enterprise host, exactly matching the bridge auth modules.
enum ProviderLoginFieldPolicy {
    static func fields(for provider: ProviderCapability, method: AuthMethod) -> [ProviderLoginField] {
        switch method {
        case .apiKey:
            var fields = [
                ProviderLoginField(
                    kind: .apiKey,
                    isOptional: provider.registrationCapability.allowsBlankAPIKey,
                    isSecure: true,
                    isMultiline: false
                ),
            ]
            fields.append(contentsOf: extraFields(for: provider, method: method))
            return fields
        case .browser, .device:
            return extraFields(for: provider, method: method)
        }
    }

    static func extraFields(for provider: ProviderCapability, method: AuthMethod) -> [ProviderLoginField] {
        switch (provider.id, method) {
        case ("alibaba-token-plan", .apiKey):
            return [
                ProviderLoginField(kind: .cookieHeader, isOptional: true, isSecure: true, isMultiline: true),
                ProviderLoginField(kind: .apiBaseUrl, isOptional: true, isSecure: false, isMultiline: false),
            ]
        case ("github-copilot", .device):
            return [
                ProviderLoginField(kind: .enterpriseHost, isOptional: true, isSecure: false, isMultiline: false),
            ]
        default:
            return []
        }
    }

    /// Maps collected field values onto the login wire inputs.
    ///
    /// Every present input must be a non-empty string on the wire
    /// (`field "inputs.<k>" must be a non-empty string`), so blank values
    /// are omitted. For the local transports an omitted key is exactly the
    /// honest no-auth request; for Alibaba an omitted cookie prompts the
    /// duplex flow, where an empty response is the explicit skip.
    static func loginInputs(from values: [ProviderLoginFieldKind: String]) -> LoginInputs {
        func trimmedNonEmpty(_ kind: ProviderLoginFieldKind) -> String? {
            guard let raw = values[kind] else { return nil }
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? nil : trimmed
        }
        return LoginInputs(
            apiKey: trimmedNonEmpty(.apiKey),
            apiBaseUrl: trimmedNonEmpty(.apiBaseUrl),
            cookieHeader: trimmedNonEmpty(.cookieHeader),
            enterpriseHost: trimmedNonEmpty(.enterpriseHost)
        )
    }
}

extension ProviderCapability {
    /// Registration is entirely projected from the catalog. There is no
    /// provider classification table in the app.
    var registrationCapability: ProviderRegistrationCapability {
        ProviderRegistrationCapability(
            methods: authMethods.compactMap { method in
                switch method {
                case .apiKey:
                    guard let kind = pastedCredentialKind else { return nil }
                    return .apiKey(kind)
                case .browser:
                    guard !credentialKinds.isEmpty else { return nil }
                    return .browser
                case .device:
                    guard !credentialKinds.isEmpty else { return nil }
                    return .device
                }
            },
            // The local Ollama transport is the sole manifest entry whose
            // blank API-key input means local no-auth. This predicate uses
            // capability fields rather than a registration-mode switch.
            allowsBlankAPIKey: connectorTransport == .builtin("ollama")
                && authorizationBasis == .deviceNone
                && productKind == .localActivity
        )
    }

    var registrationMethods: [ProviderRegistrationMethod] {
        registrationCapability.methods
    }

    var allowsAutomaticRefresh: Bool {
        pollingPolicy == .authorizedDefault
    }

    func registrationMethod(for method: AuthMethod) -> ProviderRegistrationMethod? {
        registrationMethods.first { $0.authMethod == method }
    }

    /// A credential is acceptable when its kind is declared by the
    /// manifest. The `none` credential is accepted only for the
    /// credential-free local transport, mirroring the bridge's rule.
    /// OAuth-family methods (browser/device) mint `oauth` credentials by
    /// construction of the OMP flows — including GitHub's device flow,
    /// whose usage-oriented registry list carries only the static arms.
    func accepts(_ credential: BridgeCredential, for method: AuthMethod? = nil) -> Bool {
        if credential == .none {
            return registrationCapability.allowsBlankAPIKey
        }
        if credentialKinds.contains(credential.kind) {
            return true
        }
        if credential.kind == .oauth,
           let method,
           method == .browser || method == .device {
            return authMethods.contains(method)
        }
        return false
    }

    private var pastedCredentialKind: StaticCredentialKind? {
        // A bearer declaration takes precedence when both are accepted. This
        // covers token-paste providers such as GitHub while API-key-only
        // manifests naturally produce the apiKey arm.
        if credentialKinds.contains(.bearer) { return .bearer }
        if credentialKinds.contains(.apiKey) { return .apiKey }
        return nil
    }
}
