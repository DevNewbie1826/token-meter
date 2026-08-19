// Shared strict-JSON decoding helpers for the bridge wire decoders
// (UsageResponseDecoder, LoginResponseDecoder).
//
// The trust-boundary discipline lives here once: unknown fields, missing or
// mistyped values, and unknown error codes are typed protocol failures.
import Foundation

enum StrictJSON {
    static func requiredString(_ raw: Any?, name: String) throws -> String {
        guard let value = raw as? String, !value.isEmpty else {
            throw BridgeServiceError.invalidProtocol("missing \(name)")
        }
        return value
    }

    static func requiredInteger(_ raw: Any?, name: String) throws -> Int64 {
        guard let value = try integerValue(raw, name: name) else {
            throw BridgeServiceError.invalidProtocol("missing \(name)")
        }
        return value
    }

    static func rejectUnknownKeys(_ object: [String: Any], allowed: Set<String>) throws {
        for key in object.keys where !allowed.contains(key) {
            throw BridgeServiceError.invalidProtocol("unknown field: \(key)")
        }
    }

    static func integerValue(_ raw: Any?, name: String) throws -> Int64? {
        guard let raw else { return nil }
        guard let number = raw as? NSNumber, !isBoolean(number) else {
            throw BridgeServiceError.malformedPayload("invalid \(name)")
        }
        let value = number.doubleValue
        guard value.isFinite,
              value == value.rounded(),
              value >= -9_223_372_036_854_775_808.0,
              value < 9_223_372_036_854_775_807.0
        else {
            throw BridgeServiceError.malformedPayload("invalid \(name)")
        }
        return Int64(value)
    }

    static func isBoolean(_ number: NSNumber) -> Bool {
        CFGetTypeID(number) == CFBooleanGetTypeID()
    }

    static func describe(_ raw: Any?) -> String {
        switch raw {
        case nil: return "missing"
        case let string as String: return string
        default: return "unsupported"
        }
    }

    /// Maps a wire error payload `{kind, message, retryAfterMs?}` onto the
    /// typed taxonomy. Returns nil for codes outside the closed set
    /// (callers surface that as `malformedPayload("unknown error code: …")`).
    static func decodeErrorPayload(_ raw: Any) throws -> BridgeServiceError {
        guard let object = raw as? [String: Any] else {
            throw BridgeServiceError.invalidProtocol("error is not an object")
        }
        try rejectUnknownKeys(object, allowed: ["kind", "message", "retryAfterMs"])
        let code = try requiredString(object["kind"], name: "error kind")
        let message = object["message"] as? String
        var retryAfterMs: Int?
        if let rawRetry = object["retryAfterMs"] {
            guard let number = rawRetry as? NSNumber, !isBoolean(number) else {
                throw BridgeServiceError.invalidProtocol("invalid retryAfterMs")
            }
            retryAfterMs = number.intValue
        }
        guard let error = BridgeServiceError(wireCode: code, message: message, retryAfterMs: retryAfterMs) else {
            throw BridgeServiceError.malformedPayload("unknown error code: \(code)")
        }
        return error
    }
}
