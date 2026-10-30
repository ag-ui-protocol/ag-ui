import Foundation

/// Extracts a value from the wire JSON without passing numbers through Foundation.
enum EventJSONField {
    static func value(_ key: String, from data: Data) throws -> AGUIJSON? {
        try AGUIJSON.parse(data).object?[key]
    }

    static func data(_ key: String, from data: Data) throws -> Data? {
        try value(key, from: data)?.encoded()
    }
}
