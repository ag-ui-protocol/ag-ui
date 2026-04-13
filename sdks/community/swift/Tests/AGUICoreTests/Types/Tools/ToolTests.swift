/*
 * MIT License
 *
 * Copyright (c) 2025 Perfect Aduh
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

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
}
