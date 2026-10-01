// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Defines a tool or function that agents can invoke.
///
/// Tools represent capabilities that agents can use to:
/// - Request specific information from external systems
/// - Perform actions in external systems
/// - Ask for human input or confirmation
/// - Access specialized capabilities beyond the agent's core knowledge
///
public struct Tool: Sendable, Codable, Hashable {
    /// The unique identifier for this tool.
    ///
    /// Tool names should be descriptive and follow snake_case convention
    /// (e.g., "get_weather", "send_email", "execute_query"). The name is
    /// used by agents to identify and invoke the tool.
    public let name: String

    /// Human-readable description of what this tool does.
    ///
    /// The description helps agents understand:
    /// - What the tool can do
    /// - When to use the tool
    /// - What results to expect
    ///
    /// Good descriptions are clear, concise, and action-oriented:
    /// - ✓ "Get the current weather in a given location"
    /// - ✓ "Send an email to a specified recipient"
    /// - ✗ "Weather" (too vague)
    /// - ✗ "This tool can be used to retrieve weather data..." (too verbose)
    public let description: String

    /// JSON Schema defining the tool's parameters.
    ///
    /// This schema describes the structure and constraints of the arguments
    /// the tool expects. It should be a valid JSON Schema (Draft 7 or later)
    /// encoded as Data.
    ///
    /// Common schema patterns:
    /// - Empty parameters: `Data("{}".utf8)`
    /// - Simple parameters: Object type with properties and required fields
    /// - Complex parameters: Nested objects, arrays, enums, validation rules
    ///
    /// The schema is validated at tool execution time, allowing the agent to
    /// understand what arguments are needed without strict compile-time coupling.
    public let parameters: Data

    /// Optional metadata as raw JSON bytes.
    ///
    /// Used by A2UI schema extensions and tool registry annotations. Stored as `Data`
    /// for `Sendable` compliance; encoded and decoded via the same `AnyCodable` pattern
    /// as `parameters`. Corresponds to the `metadata` field in the AG-UI protocol spec.
    public let metadata: Data?

    /// Creates a new tool definition.
    ///
    /// - Parameters:
    ///   - name: Unique identifier for the tool
    ///   - description: Human-readable explanation of the tool's purpose
    ///   - parameters: JSON Schema defining the tool's parameters as Data
    ///   - metadata: Optional metadata as raw JSON bytes
    ///
    /// - Note: The parameters should contain valid JSON Schema. Invalid schema
    ///   may cause validation errors during tool execution.
    public init(
        name: String,
        description: String,
        parameters: Data,
        metadata: Data? = nil
    ) {
        self.name = name
        self.description = description
        self.parameters = parameters
        self.metadata = metadata
    }

    // MARK: - Codable

    private enum CodingKeys: String, CodingKey {
        case name
        case description
        case parameters
        case metadata
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        name = try container.decode(String.self, forKey: .name)
        description = try container.decode(String.self, forKey: .description)

        // Decode parameters as nested JSON and convert to Data
        // This allows parameters to be a JSON object in the encoded form
        let parametersValue = try container.decode(AnyCodable.self, forKey: .parameters)
        let jsonData = try JSONSerialization.data(withJSONObject: parametersValue.value)
        parameters = jsonData

        // Decode optional metadata using same AnyCodable pattern as parameters
        if let metadataValue = try? container.decode(AnyCodable.self, forKey: .metadata),
           !(metadataValue.value is NSNull) {
            metadata = try JSONSerialization.data(withJSONObject: metadataValue.value)
        } else {
            metadata = nil
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(name, forKey: .name)
        try container.encode(description, forKey: .description)

        // Encode parameters as nested JSON object instead of base64 string
        // This maintains JSON compatibility with the protocol
        let jsonObject = try JSONSerialization.jsonObject(with: parameters)
        try container.encode(AnyCodable(jsonObject), forKey: .parameters)

        // Encode optional metadata as nested JSON object (same pattern as parameters)
        if let metadataData = metadata {
            let metadataObject = try JSONSerialization.jsonObject(with: metadataData)
            try container.encode(AnyCodable(metadataObject), forKey: .metadata)
        }
    }
}

// MARK: - AnyCodable Helper

/// Helper type to encode/decode arbitrary JSON values
private struct AnyCodable: Codable {
    let value: Any

    init(_ value: Any) {
        self.value = value
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()

        if let intValue = try? container.decode(Int.self) {
            value = intValue
        } else if let doubleValue = try? container.decode(Double.self) {
            value = doubleValue
        } else if let boolValue = try? container.decode(Bool.self) {
            value = boolValue
        } else if let stringValue = try? container.decode(String.self) {
            value = stringValue
        } else if let arrayValue = try? container.decode([AnyCodable].self) {
            value = arrayValue.map { $0.value }
        } else if let dictionaryValue = try? container.decode([String: AnyCodable].self) {
            value = dictionaryValue.mapValues { $0.value }
        } else if container.decodeNil() {
            value = NSNull()
        } else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Unable to decode value"
            )
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()

        // Use isJSONBoolean to distinguish genuine JSON booleans (backed by
        // CFBoolean / __NSCFBoolean) from numeric NSNumbers. On Apple/Linux
        // Foundation, `NSNumber(value: 0) as? Bool` succeeds (returns false),
        // so checking Bool before Int without the CF type-ID guard would silently
        // turn integer 0 → false and 1 → true on the wire.
        if isJSONBoolean(value), let boolValue = value as? Bool {
            try container.encode(boolValue)
        } else if let intValue = value as? Int {
            try container.encode(intValue)
        } else if let doubleValue = value as? Double {
            try container.encode(doubleValue)
        } else if let stringValue = value as? String {
            try container.encode(stringValue)
        } else if let arrayValue = value as? [Any] {
            try container.encode(arrayValue.map { AnyCodable($0) })
        } else if let dictionaryValue = value as? [String: Any] {
            try container.encode(dictionaryValue.mapValues { AnyCodable($0) })
        } else if value is NSNull {
            try container.encodeNil()
        } else {
            throw EncodingError.invalidValue(
                value,
                EncodingError.Context(
                    codingPath: container.codingPath,
                    debugDescription: "Unable to encode value of type \(type(of: value))"
                )
            )
        }
    }
}
