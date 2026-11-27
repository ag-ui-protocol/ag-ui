// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUICore

/// Tests for the Tool type
final class ToolTests: XCTestCase {
    // MARK: - Initialization Tests

    func testInitWithBasicSchema() throws {
        let schema = Data("""
        {
            "type": "object",
            "properties": {
                "location": {"type": "string"}
            },
            "required": ["location"]
        }
        """.utf8)

        let tool = Tool(
            name: "get_weather",
            description: "Get the current weather for a location",
            parameters: schema
        )

        XCTAssertEqual(tool.name, "get_weather")
        XCTAssertEqual(tool.description, "Get the current weather for a location")
        XCTAssertEqual(tool.parameters, schema)
    }

    func testInitWithEmptySchema() {
        let emptySchema = Data("{}".utf8)

        let tool = Tool(
            name: "ping",
            description: "Simple ping tool with no parameters",
            parameters: emptySchema
        )

        XCTAssertEqual(tool.name, "ping")
        XCTAssertEqual(tool.parameters, emptySchema)
    }

    func testInitWithComplexSchema() throws {
        let complexSchema = Data("""
        {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The SQL query to execute"
                },
                "database": {
                    "type": "string",
                    "enum": ["production", "staging", "development"]
                },
                "limit": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 1000,
                    "default": 100
                }
            },
            "required": ["query", "database"]
        }
        """.utf8)

        let tool = Tool(
            name: "execute_sql",
            description: "Execute a SQL query on a specified database",
            parameters: complexSchema
        )

        XCTAssertEqual(tool.name, "execute_sql")
        XCTAssertTrue(tool.description.contains("SQL"))
    }

    // MARK: - Encoding Tests

    func testEncodingBasic() throws {
        let schema = Data("{\"type\":\"object\"}".utf8)
        let tool = Tool(
            name: "test_tool",
            description: "A test tool",
            parameters: schema
        )

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let encoded = try encoder.encode(tool)
        let json = String(data: encoded, encoding: .utf8)

        XCTAssertNotNil(json)
        XCTAssertTrue(json?.contains("\"name\"") ?? false)
        XCTAssertTrue(json?.contains("\"description\"") ?? false)
        XCTAssertTrue(json?.contains("\"parameters\"") ?? false)
        XCTAssertTrue(json?.contains("\"test_tool\"") ?? false)
    }

    func testEncodedStructure() throws {
        let schema = Data("{\"type\":\"object\"}".utf8)
        let tool = Tool(
            name: "sample",
            description: "Sample tool",
            parameters: schema
        )

        let encoded = try JSONEncoder().encode(tool)
        let json = try JSONSerialization.jsonObject(with: encoded) as? [String: Any]

        XCTAssertEqual(json?["name"] as? String, "sample")
        XCTAssertEqual(json?["description"] as? String, "Sample tool")
        XCTAssertNotNil(json?["parameters"])
    }

    // MARK: - Decoding Tests

    func testDecodingBasic() throws {
        let json = """
        {
            "name": "send_email",
            "description": "Send an email to a recipient",
            "parameters": {
                "type": "object",
                "properties": {
                    "to": {"type": "string"},
                    "subject": {"type": "string"}
                }
            }
        }
        """

        let decoder = JSONDecoder()
        let tool = try decoder.decode(Tool.self, from: Data(json.utf8))

        XCTAssertEqual(tool.name, "send_email")
        XCTAssertEqual(tool.description, "Send an email to a recipient")
        XCTAssertFalse(tool.parameters.isEmpty)
    }

    func testDecodingWithEmptyParameters() throws {
        let json = """
        {
            "name": "no_params",
            "description": "Tool with no parameters",
            "parameters": {}
        }
        """

        let decoder = JSONDecoder()
        let tool = try decoder.decode(Tool.self, from: Data(json.utf8))

        XCTAssertEqual(tool.name, "no_params")
        XCTAssertFalse(tool.parameters.isEmpty)
    }

    func testDecodingFailsWithoutName() {
        let json = """
        {
            "description": "Missing name",
            "parameters": {}
        }
        """

        let decoder = JSONDecoder()
        XCTAssertThrowsError(try decoder.decode(Tool.self, from: Data(json.utf8))) { error in
            XCTAssertTrue(error is DecodingError)
        }
    }

    func testDecodingFailsWithoutDescription() {
        let json = """
        {
            "name": "test",
            "parameters": {}
        }
        """

        let decoder = JSONDecoder()
        XCTAssertThrowsError(try decoder.decode(Tool.self, from: Data(json.utf8))) { error in
            XCTAssertTrue(error is DecodingError)
        }
    }

    func testDecodingFailsWithoutParameters() {
        let json = """
        {
            "name": "test",
            "description": "Test tool"
        }
        """

        let decoder = JSONDecoder()
        XCTAssertThrowsError(try decoder.decode(Tool.self, from: Data(json.utf8))) { error in
            XCTAssertTrue(error is DecodingError)
        }
    }

    // MARK: - Round-trip Tests

    func testRoundTrip() throws {
        let schema = Data("""
        {
            "type": "object",
            "properties": {
                "query": {"type": "string"}
            }
        }
        """.utf8)

        let original = Tool(
            name: "search",
            description: "Search for information",
            parameters: schema
        )

        let encoder = JSONEncoder()
        let encoded = try encoder.encode(original)

        let decoder = JSONDecoder()
        let decoded = try decoder.decode(Tool.self, from: encoded)

        XCTAssertEqual(decoded.name, original.name)
        XCTAssertEqual(decoded.description, original.description)

        // Compare parameters semantically (as JSON) rather than byte-for-byte
        let originalJSON = try JSONSerialization.jsonObject(with: original.parameters) as? [String: Any]
        let decodedJSON = try JSONSerialization.jsonObject(with: decoded.parameters) as? [String: Any]
        XCTAssertEqual(originalJSON?["type"] as? String, decodedJSON?["type"] as? String)
        XCTAssertNotNil(originalJSON?["properties"])
        XCTAssertNotNil(decodedJSON?["properties"])
    }

    // MARK: - Equatable Tests

    func testEquality() {
        let schema1 = Data("{\"type\":\"object\"}".utf8)
        let schema2 = Data("{\"type\":\"object\"}".utf8)
        let schema3 = Data("{\"type\":\"string\"}".utf8)

        let tool1 = Tool(name: "tool", description: "desc", parameters: schema1)
        let tool2 = Tool(name: "tool", description: "desc", parameters: schema2)
        let tool3 = Tool(name: "other", description: "desc", parameters: schema1)
        let tool4 = Tool(name: "tool", description: "different", parameters: schema1)
        let tool5 = Tool(name: "tool", description: "desc", parameters: schema3)

        XCTAssertEqual(tool1, tool2)
        XCTAssertNotEqual(tool1, tool3)
        XCTAssertNotEqual(tool1, tool4)
        XCTAssertNotEqual(tool1, tool5)
    }

    // MARK: - Hashable Tests

    func testHashable() {
        let schema = Data("{}".utf8)
        let tool1 = Tool(name: "tool1", description: "First", parameters: schema)
        let tool2 = Tool(name: "tool2", description: "Second", parameters: schema)

        let set: Set<Tool> = [tool1, tool2]
        XCTAssertEqual(set.count, 2)
        XCTAssertTrue(set.contains(tool1))
        XCTAssertTrue(set.contains(tool2))
    }

    // MARK: - Sendable Tests

    func testSendableConformance() {
        let schema = Data("{}".utf8)
        let tool = Tool(name: "test", description: "Test", parameters: schema)

        Task {
            let capturedTool = tool
            XCTAssertEqual(capturedTool.name, "test")
        }
    }

    // MARK: - Parameter Schema Tests

    func testParametersAsValidJSONSchema() throws {
        let schema = Data("""
        {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "age": {"type": "integer"}
            },
            "required": ["name"]
        }
        """.utf8)

        let tool = Tool(
            name: "create_user",
            description: "Create a new user",
            parameters: schema
        )

        // Verify parameters can be parsed as JSON
        let parsed = try JSONSerialization.jsonObject(with: tool.parameters) as? [String: Any]
        XCTAssertNotNil(parsed)
        XCTAssertEqual(parsed?["type"] as? String, "object")
        XCTAssertNotNil(parsed?["properties"])
    }

    // MARK: - Real-world Usage Tests

    func testWeatherTool() throws {
        let weatherSchema = Data("""
        {
            "type": "object",
            "properties": {
                "location": {
                    "type": "string",
                    "description": "City and state, e.g., San Francisco, CA"
                },
                "unit": {
                    "type": "string",
                    "enum": ["celsius", "fahrenheit"],
                    "default": "fahrenheit"
                }
            },
            "required": ["location"]
        }
        """.utf8)

        let weatherTool = Tool(
            name: "get_current_weather",
            description: "Get the current weather in a given location",
            parameters: weatherSchema
        )

        XCTAssertEqual(weatherTool.name, "get_current_weather")
        XCTAssertTrue(weatherTool.description.contains("weather"))

        // Verify schema is valid JSON
        let schema = try JSONSerialization.jsonObject(with: weatherTool.parameters) as? [String: Any]
        let properties = schema?["properties"] as? [String: Any]
        XCTAssertNotNil(properties?["location"])
    }

    func testDatabaseTool() throws {
        let dbSchema = Data("""
        {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "SQL query to execute"
                },
                "database": {
                    "type": "string",
                    "description": "Target database name"
                }
            },
            "required": ["query", "database"]
        }
        """.utf8)

        let dbTool = Tool(
            name: "execute_sql_query",
            description: "Execute a SQL query on the specified database",
            parameters: dbSchema
        )

        XCTAssertEqual(dbTool.name, "execute_sql_query")
    }

    func testToolArray() {
        let schema = Data("{}".utf8)

        let tools: [Tool] = [
            Tool(name: "tool1", description: "First tool", parameters: schema),
            Tool(name: "tool2", description: "Second tool", parameters: schema),
            Tool(name: "tool3", description: "Third tool", parameters: schema)
        ]

        XCTAssertEqual(tools.count, 3)
        XCTAssertEqual(tools[0].name, "tool1")
        XCTAssertEqual(tools[1].name, "tool2")
        XCTAssertEqual(tools[2].name, "tool3")
    }

    func testNoParametersTool() {
        let emptySchema = Data("{}".utf8)

        let pingTool = Tool(
            name: "ping",
            description: "Check if the service is alive",
            parameters: emptySchema
        )

        XCTAssertEqual(pingTool.name, "ping")
        XCTAssertFalse(pingTool.parameters.isEmpty)
    }

    // MARK: - metadata: Data? Tests

    func test_toolWithMetadata_init() {
        let schema = Data("{}".utf8)
        let metadata = Data("{\"category\":\"weather\"}".utf8)

        let tool = Tool(
            name: "get_weather",
            description: "Get weather",
            parameters: schema,
            metadata: metadata
        )

        XCTAssertEqual(tool.metadata, metadata)
    }

    func test_toolWithoutMetadata_metadataIsNil() {
        let tool = Tool(name: "ping", description: "Ping", parameters: Data("{}".utf8))
        XCTAssertNil(tool.metadata)
    }

    func test_encodingWithMetadata_includesMetadataKey() throws {
        let schema = Data("{}".utf8)
        let metadata = Data("{\"category\":\"search\"}".utf8)
        let tool = Tool(name: "search", description: "Search", parameters: schema, metadata: metadata)

        let encoded = try JSONEncoder().encode(tool)
        let json = try JSONSerialization.jsonObject(with: encoded) as? [String: Any]

        XCTAssertNotNil(json?["metadata"], "Encoded JSON must contain 'metadata' key")
        let meta = json?["metadata"] as? [String: Any]
        XCTAssertEqual(meta?["category"] as? String, "search")
    }

    func test_encodingWithoutMetadata_omitsMetadataKey() throws {
        let tool = Tool(name: "ping", description: "Ping", parameters: Data("{}".utf8))

        let encoded = try JSONEncoder().encode(tool)
        let json = try JSONSerialization.jsonObject(with: encoded) as? [String: Any]

        XCTAssertNil(json?["metadata"], "Encoded JSON must NOT contain 'metadata' when nil")
    }

    func test_decodingWithMetadata_populatesMetadata() throws {
        let json = """
        {
            "name": "search",
            "description": "Search tool",
            "parameters": {},
            "metadata": {"category": "search", "version": 2}
        }
        """

        let tool = try JSONDecoder().decode(Tool.self, from: Data(json.utf8))

        XCTAssertNotNil(tool.metadata)
        let meta = try JSONSerialization.jsonObject(with: tool.metadata!) as? [String: Any]
        XCTAssertEqual(meta?["category"] as? String, "search")
        XCTAssertEqual(meta?["version"] as? Int, 2)
    }

    func test_decodingWithoutMetadata_metadataIsNil() throws {
        // Existing format without metadata — must remain backward compatible
        let json = """
        {
            "name": "legacy_tool",
            "description": "Legacy tool",
            "parameters": {}
        }
        """

        let tool = try JSONDecoder().decode(Tool.self, from: Data(json.utf8))
        XCTAssertNil(tool.metadata)
    }

    func test_roundTripWithMetadata() throws {
        let schema = Data("{}".utf8)
        let metadata = Data("{\"category\":\"weather\",\"priority\":1}".utf8)
        let original = Tool(name: "get_weather", description: "Weather", parameters: schema, metadata: metadata)

        let encoded = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(Tool.self, from: encoded)

        XCTAssertNotNil(decoded.metadata)
        let origMeta = try JSONSerialization.jsonObject(with: original.metadata!) as? [String: Any]
        let decodedMeta = try JSONSerialization.jsonObject(with: decoded.metadata!) as? [String: Any]
        XCTAssertEqual(origMeta?["category"] as? String, decodedMeta?["category"] as? String)
        XCTAssertEqual(origMeta?["priority"] as? Int, decodedMeta?["priority"] as? Int)
    }

    func test_equalityWithDifferentMetadata_notEqual() {
        let schema = Data("{}".utf8)
        let meta1 = Data("{\"v\":1}".utf8)
        let meta2 = Data("{\"v\":2}".utf8)

        let tool1 = Tool(name: "t", description: "d", parameters: schema, metadata: meta1)
        let tool2 = Tool(name: "t", description: "d", parameters: schema, metadata: meta2)

        XCTAssertNotEqual(tool1, tool2)
    }

    // MARK: - Regression: JSON Schema boolean values must survive encode → decode round-trip

    // Root cause: AnyCodable.encode(to:) used a switch that checked Int before Bool.
    // JSONSerialization returns __NSCFBoolean for JSON booleans.  Due to NSNumber
    // bridging, `__NSCFBoolean as? Int` succeeds (yielding 1 / 0), so the encode
    // branch fired for Int — turning `false` into 0 and `true` into 1 on the wire.
    //
    // The test verifies that the JSON the SDK sends preserves boolean literals,
    // since the receiving agent validates the schema against a JSON Schema validator
    // that distinguishes `false` from `0`.

    func test_tool_roundTrip_boolFalseInSchema_preservesType() throws {
        // "additionalProperties": false is a real JSON Schema keyword.
        // It must survive encode → decode as the boolean literal `false`, not the
        // integer `0`.
        let schema = Data("""
        {
            "type": "object",
            "properties": {"city": {"type": "string"}},
            "additionalProperties": false
        }
        """.utf8)
        let tool = Tool(name: "weather", description: "Get weather", parameters: schema)

        let encoded = try JSONEncoder().encode(tool)

        // The raw JSON the SDK sends over the wire must contain `false`, not `0`.
        let rawJSON = String(data: encoded, encoding: .utf8) ?? ""
        XCTAssertTrue(
            rawJSON.contains("\"additionalProperties\":false") ||
            rawJSON.contains("\"additionalProperties\": false"),
            "Expected boolean false in encoded JSON, got: \(rawJSON)"
        )

        // And it must decode back to false (not an integer 0).
        let decoded = try JSONDecoder().decode(Tool.self, from: encoded)
        let decodedSchema = try JSONSerialization.jsonObject(with: decoded.parameters) as? [String: Any]
        let additionalProps = decodedSchema?["additionalProperties"]
        XCTAssertTrue(
            additionalProps is Bool,
            "additionalProperties must decode as Bool, got \(type(of: additionalProps))"
        )
        XCTAssertEqual(additionalProps as? Bool, false)
    }

    func test_tool_roundTrip_boolTrueInSchema_preservesType() throws {
        // A property with a boolean `true` value (e.g., "uniqueItems": true) must
        // round-trip as `true`, not as the integer `1`.
        let schema = Data("""
        {
            "type": "object",
            "properties": {"tags": {"type": "array", "uniqueItems": true}}
        }
        """.utf8)
        let tool = Tool(name: "tag_tool", description: "Tag-based tool", parameters: schema)

        let encoded = try JSONEncoder().encode(tool)
        let decoded = try JSONDecoder().decode(Tool.self, from: encoded)

        let decodedSchema = try JSONSerialization.jsonObject(with: decoded.parameters) as? [String: Any]
        let properties = decodedSchema?["properties"] as? [String: Any]
        let tagsSchema = properties?["tags"] as? [String: Any]
        let uniqueItems = tagsSchema?["uniqueItems"]

        XCTAssertTrue(
            uniqueItems is Bool,
            "uniqueItems must decode as Bool, got \(type(of: uniqueItems))"
        )
        XCTAssertEqual(uniqueItems as? Bool, true)
    }

    func test_tool_roundTrip_integerInSchema_notTreatedAsBool() throws {
        // Integer schema constraints (minLength, maxLength, minimum, maximum) must
        // remain integers after the round-trip, not become booleans.
        let schema = Data("""
        {
            "type": "object",
            "properties": {
                "code": {"type": "string", "minLength": 1, "maxLength": 10}
            }
        }
        """.utf8)
        let tool = Tool(name: "code_tool", description: "Code tool", parameters: schema)

        let encoded = try JSONEncoder().encode(tool)

        // Check the WIRE JSON — this is the authoritative test.
        // __NSCFBoolean(true) as? Int returns 1 via NSNumber bridging, so
        // asserting on the decoded value's Int cast would give a false positive.
        let wire = String(data: encoded, encoding: .utf8) ?? ""
        XCTAssertTrue(
            wire.contains("\"minLength\":1") || wire.contains("\"minLength\": 1"),
            "minLength:1 must be integer 1 on the wire, not true. Got: \(wire)"
        )
        XCTAssertTrue(
            wire.contains("\"maxLength\":10") || wire.contains("\"maxLength\": 10"),
            "maxLength:10 must be integer 10 on the wire. Got: \(wire)"
        )

        let decoded = try JSONDecoder().decode(Tool.self, from: encoded)
        let decodedSchema = try JSONSerialization.jsonObject(with: decoded.parameters) as? [String: Any]
        let properties = decodedSchema?["properties"] as? [String: Any]
        let codeSchema = properties?["code"] as? [String: Any]

        // isJSONBoolean uses CFGetTypeID — the only reliable way to distinguish
        // __NSCFBoolean from __NSCFNumber after JSONSerialization round-trips.
        XCTAssertFalse(
            isJSONBoolean(codeSchema?["minLength"] as Any),
            "minLength must be an integer NSNumber, not __NSCFBoolean"
        )
        XCTAssertFalse(
            isJSONBoolean(codeSchema?["maxLength"] as Any),
            "maxLength must be an integer NSNumber, not __NSCFBoolean"
        )
    }
}
