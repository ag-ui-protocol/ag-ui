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

// AnyCodable is defined in JSONCodingHelpers.swift (AGUICore module-internal).
