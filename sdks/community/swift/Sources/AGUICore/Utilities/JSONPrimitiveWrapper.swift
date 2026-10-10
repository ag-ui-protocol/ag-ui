// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Wraps an untyped `Any` primitive so it can be encoded into JSON via `Codable`.
///
/// This is an internal helper used by DTO types that receive raw `Any` values
/// from `JSONSerialization` and need to round-trip them through `JSONEncoder`.
///
/// Supported value types: `Bool`, `Int`, `Int64`, `Double`, `String`, `NSNull`.
struct JSONPrimitiveWrapper: Encodable {
    let value: Any

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()

        // isJSONBoolean guards against __NSCFNumber(0/1) bridging as Bool via
        // NSNumber's -boolValue on Apple/Linux platforms, which would silently
        // encode integer 0 as false and 1 as true.
        if isJSONBoolean(value), let bool = value as? Bool {
            try container.encode(bool)
        } else if let int = value as? Int {
            try container.encode(int)
        } else if let int64 = value as? Int64 {
            try container.encode(int64)
        } else if let double = value as? Double {
            try container.encode(double)
        } else if let string = value as? String {
            try container.encode(string)
        } else if value is NSNull {
            try container.encodeNil()
        } else {
            throw EncodingError.invalidValue(
                value,
                EncodingError.Context(
                    codingPath: [],
                    debugDescription: "Unsupported primitive type: \(type(of: value))"
                )
            )
        }
    }
}
