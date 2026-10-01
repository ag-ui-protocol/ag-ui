// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import CoreFoundation
import Foundation

// MARK: - Bool / number disambiguation

/// Returns `true` iff `value` is a genuine JSON boolean (`true` or `false`)
/// rather than a numeric value.
///
/// `JSONSerialization` produces `__NSCFBoolean` (backed by `CFBoolean`) for
/// JSON `true`/`false` and `__NSCFNumber` for every numeric value.
/// On Apple and Linux Foundation, `NSNumber as? Bool` succeeds for `NSNumber`
/// values 0 and 1 (because NSNumber's `-boolValue` returns NO/YES for those),
/// so checking `Bool` before `Int` in a type-test chain silently converts
/// integer `0` to `false` and `1` to `true` on the wire.
///
/// Checking the Core Foundation type identity is the only reliable way to
/// distinguish the two, and works on both Apple platforms and
/// swift-corelibs-foundation (Linux).
func isJSONBoolean(_ value: Any) -> Bool {
    guard let number = value as? NSNumber else {
        // A plain Swift Bool that was never passed through JSONSerialization
        // is always a genuine boolean.
        return value is Bool
    }
    return CFGetTypeID(number) == CFBooleanGetTypeID()
}

/// Dynamic coding keys for encoding/decoding arbitrary JSON objects.
///
/// This type enables working with JSON objects that have dynamic or unknown keys
/// at compile time, commonly needed when bridging between strongly-typed Swift
/// and loosely-typed JSON.
///
public struct JSONCodingKeys: CodingKey {
    public var stringValue: String
    public var intValue: Int?

    public init(stringValue: String) {
        self.stringValue = stringValue
        self.intValue = nil
    }

    public init?(intValue: Int) {
        self.stringValue = String(intValue)
        self.intValue = intValue
    }
}

// MARK: - Decoding Extensions

extension KeyedDecodingContainer where K == JSONCodingKeys {
    /// Decodes an arbitrary JSON object (dictionary) to a Swift dictionary.
    ///
    /// Recursively decodes nested objects and arrays, preserving the JSON structure.
    /// Supported types: String, Int, Double, Bool, nested objects, nested arrays, and null.
    ///
    /// - Returns: A dictionary with string keys and `Any` values representing the JSON object
    /// - Throws: `DecodingError` if the structure cannot be decoded
    public func decodeJSONObject() throws -> Any {
        var result: [String: Any] = [:]

        for key in allKeys {
            if let value = try? decode(String.self, forKey: key) {
                result[key.stringValue] = value
            } else if let value = try? decode(Int.self, forKey: key) {
                result[key.stringValue] = value
            } else if let value = try? decode(Double.self, forKey: key) {
                result[key.stringValue] = value
            } else if let value = try? decode(Bool.self, forKey: key) {
                result[key.stringValue] = value
            } else if let nestedContainer = try? nestedContainer(keyedBy: JSONCodingKeys.self, forKey: key) {
                result[key.stringValue] = try nestedContainer.decodeJSONObject()
            } else if var nestedContainer = try? nestedUnkeyedContainer(forKey: key) {
                result[key.stringValue] = try nestedContainer.decodeJSONArray()
            } else {
                result[key.stringValue] = NSNull()
            }
        }

        return result
    }
}

extension UnkeyedDecodingContainer {
    /// Decodes an arbitrary JSON array to a Swift array.
    ///
    /// Recursively decodes nested objects and arrays, preserving the JSON structure.
    /// Supported types: String, Int, Double, Bool, nested objects, nested arrays, and null.
    ///
    /// - Returns: An array of `Any` representing the JSON array
    /// - Throws: `DecodingError` if the structure cannot be decoded
    public mutating func decodeJSONArray() throws -> [Any] {
        var result: [Any] = []

        while !isAtEnd {
            if let value = try? decode(String.self) {
                result.append(value)
            } else if let value = try? decode(Int.self) {
                result.append(value)
            } else if let value = try? decode(Double.self) {
                result.append(value)
            } else if let value = try? decode(Bool.self) {
                result.append(value)
            } else if let nestedContainer = try? nestedContainer(keyedBy: JSONCodingKeys.self) {
                result.append(try nestedContainer.decodeJSONObject())
            } else if var nestedContainer = try? nestedUnkeyedContainer() {
                result.append(try nestedContainer.decodeJSONArray())
            } else {
                result.append(NSNull())
            }
        }

        return result
    }
}

// MARK: - Encoding Extensions

extension KeyedEncodingContainer where K == JSONCodingKeys {
    /// Encodes an arbitrary JSON object (dictionary) from a Swift dictionary.
    ///
    /// Recursively encodes nested objects and arrays, preserving the JSON structure.
    /// Supported types: String, Int, Double, Bool, nested dictionaries, nested arrays, and null.
    ///
    /// - Parameter object: The object to encode (typically a `[String: Any]` dictionary)
    /// - Throws: `EncodingError` if the object cannot be encoded
    public mutating func encodeJSONObject(_ object: Any) throws {
        if let dict = object as? [String: Any] {
            for (key, value) in dict {
                let codingKey = JSONCodingKeys(stringValue: key)

                if let stringValue = value as? String {
                    try encode(stringValue, forKey: codingKey)
                } else if isJSONBoolean(value), let boolValue = value as? Bool {
                    // isJSONBoolean guards against __NSCFNumber(0/1) matching as Bool
                    // via NSNumber's -boolValue bridge on Apple/Linux platforms.
                    try encode(boolValue, forKey: codingKey)
                } else if let intValue = value as? Int {
                    try encode(intValue, forKey: codingKey)
                } else if let doubleValue = value as? Double {
                    try encode(doubleValue, forKey: codingKey)
                } else if value is NSNull {
                    try encodeNil(forKey: codingKey)
                } else if let nestedDict = value as? [String: Any] {
                    var nestedContainer = nestedContainer(keyedBy: JSONCodingKeys.self, forKey: codingKey)
                    try nestedContainer.encodeJSONObject(nestedDict)
                } else if let nestedArray = value as? [Any] {
                    var nestedContainer = nestedUnkeyedContainer(forKey: codingKey)
                    try nestedContainer.encodeJSONArray(nestedArray)
                }
            }
        }
    }
}

extension UnkeyedEncodingContainer {
    /// Encodes an arbitrary JSON array from a Swift array.
    ///
    /// Recursively encodes nested objects and arrays, preserving the JSON structure.
    /// Supported types: String, Int, Double, Bool, nested dictionaries, nested arrays, and null.
    ///
    /// - Parameter array: The array to encode (typically an `[Any]` array)
    /// - Throws: `EncodingError` if the array cannot be encoded
    public mutating func encodeJSONArray(_ array: [Any]) throws {
        for value in array {
            if let stringValue = value as? String {
                try encode(stringValue)
            } else if isJSONBoolean(value), let boolValue = value as? Bool {
                try encode(boolValue)
            } else if let intValue = value as? Int {
                try encode(intValue)
            } else if let doubleValue = value as? Double {
                try encode(doubleValue)
            } else if value is NSNull {
                try encodeNil()
            } else if let nestedDict = value as? [String: Any] {
                var nestedContainer = nestedContainer(keyedBy: JSONCodingKeys.self)
                try nestedContainer.encodeJSONObject(nestedDict)
            } else if let nestedArray = value as? [Any] {
                var nestedContainer = nestedUnkeyedContainer()
                try nestedContainer.encodeJSONArray(nestedArray)
            }
        }
    }
}
