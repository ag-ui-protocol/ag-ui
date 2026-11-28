import Foundation

/// Extracts a value from the wire JSON without passing numbers through Foundation.
enum EventJSONField {
    static func value(_ key: String, from data: Data) throws -> AGUIJSON? {
        try AGUIJSON.parse(data).object?[key]
    }

    /// Extract only bounded envelope fields before Foundation decoding. Open
    /// payloads may contain numbers outside Foundation's numeric range.
    static func envelope(_ keys: Set<String>, from data: Data) throws -> [String: Any] {
        guard let fields = try AGUIJSON.parse(data).object else { throw AGUISchemaError.invalidJSON }
        let envelope = AGUIJSON.object(fields.filter { keys.contains($0.key) })
        return try JSONSerialization.jsonObject(with: envelope.encoded()) as! [String: Any]
    }

    static func data(_ key: String, from data: Data) throws -> Data? {
        try value(key, from: data)?.encoded()
    }
}
