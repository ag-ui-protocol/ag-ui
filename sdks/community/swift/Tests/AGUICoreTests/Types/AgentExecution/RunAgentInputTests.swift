// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUICore

/// Tests for the RunAgentInput type
final class RunAgentInputTests: XCTestCase {
    // MARK: - Initialization Tests

    func testInitWithMinimalParameters() {
        let input = RunAgentInput(
            threadId: "thread-123",
            runId: "run-456"
        )

        XCTAssertEqual(input.threadId, "thread-123")
        XCTAssertEqual(input.runId, "run-456")
        XCTAssertNil(input.parentRunId)
        XCTAssertTrue(input.messages.isEmpty)
        XCTAssertTrue(input.tools.isEmpty)
        XCTAssertTrue(input.context.isEmpty)
    }

    func testInitWithParentRunId() {
        let input = RunAgentInput(
            threadId: "thread-1",
            runId: "run-2",
            parentRunId: "run-1"
        )

        XCTAssertEqual(input.parentRunId, "run-1")
    }

    func testInitWithMessages() {
        let messages: [any Message] = [
            UserMessage(id: "msg-1", content: "Hello"),
            AssistantMessage(id: "msg-2", content: "Hi there!")
        ]

        let input = RunAgentInput(
            threadId: "thread-1",
            runId: "run-1",
            messages: messages
        )

        XCTAssertEqual(input.messages.count, 2)
    }

    func testInitWithTools() {
        let tools = [
            Tool(
                name: "get_weather",
                description: "Get weather data",
                parameters: Data("{\"type\": \"object\"}".utf8)
            )
        ]

        let input = RunAgentInput(
            threadId: "thread-1",
            runId: "run-1",
            tools: tools
        )

        XCTAssertEqual(input.tools.count, 1)
        XCTAssertEqual(input.tools[0].name, "get_weather")
    }

    func testInitWithContext() {
        let contexts = [
            Context(description: "User ID", value: "12345"),
            Context(description: "Language", value: "en-US")
        ]

        let input = RunAgentInput(
            threadId: "thread-1",
            runId: "run-1",
            context: contexts
        )

        XCTAssertEqual(input.context.count, 2)
        XCTAssertEqual(input.context[0].description, "User ID")
    }

    func testInitWithState() {
        let state = Data("""
        {"counter": 42, "active": true}
        """.utf8)

        let input = RunAgentInput(
            threadId: "thread-1",
            runId: "run-1",
            state: state
        )

        XCTAssertNotNil(input.state)
    }

    func testInitWithForwardedProps() {
        let props = Data("""
        {"custom_field": "value"}
        """.utf8)

        let input = RunAgentInput(
            threadId: "thread-1",
            runId: "run-1",
            forwardedProps: props
        )

        XCTAssertNotNil(input.forwardedProps)
    }

    func testInitWithAllParameters() {
        let messages: [any Message] = [
            UserMessage(id: "msg-1", content: "Test")
        ]
        let tools = [
            Tool(name: "tool1", description: "Test tool", parameters: Data("{}".utf8))
        ]
        let contexts = [
            Context(description: "ctx1", value: "val1")
        ]
        let state = Data("""
        {"key": "value"}
        """.utf8)
        let props = Data("""
        {"prop": "data"}
        """.utf8)

        let input = RunAgentInput(
            threadId: "thread-1",
            runId: "run-1",
            parentRunId: "run-0",
            state: state,
            messages: messages,
            tools: tools,
            context: contexts,
            forwardedProps: props
        )

        XCTAssertEqual(input.threadId, "thread-1")
        XCTAssertEqual(input.runId, "run-1")
        XCTAssertEqual(input.parentRunId, "run-0")
        XCTAssertEqual(input.messages.count, 1)
        XCTAssertEqual(input.tools.count, 1)
        XCTAssertEqual(input.context.count, 1)
        XCTAssertNotNil(input.state)
        XCTAssertNotNil(input.forwardedProps)
    }

    // MARK: - Encoding Tests

    func testEncodingMinimal() throws {
        let input = RunAgentInput(
            threadId: "thread-123",
            runId: "run-456"
        )

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let encoded = try encoder.encode(input)
        let json = String(data: encoded, encoding: .utf8)

        XCTAssertNotNil(json)
        XCTAssertTrue(json?.contains("\"threadId\"") ?? false)
        XCTAssertTrue(json?.contains("\"runId\"") ?? false)
        XCTAssertTrue(json?.contains("\"messages\"") ?? false)
        XCTAssertTrue(json?.contains("\"tools\"") ?? false)
        XCTAssertTrue(json?.contains("\"context\"") ?? false)
    }

    func testEncodedStructure() throws {
        let input = RunAgentInput(
            threadId: "thread-1",
            runId: "run-1",
            parentRunId: "run-0"
        )

        let encoded = try JSONEncoder().encode(input)
        let json = try JSONSerialization.jsonObject(with: encoded) as? [String: Any]

        XCTAssertEqual(json?["threadId"] as? String, "thread-1")
        XCTAssertEqual(json?["runId"] as? String, "run-1")
        XCTAssertEqual(json?["parentRunId"] as? String, "run-0")

        let messages = json?["messages"] as? [Any]
        XCTAssertEqual(messages?.count, 0)

        let tools = json?["tools"] as? [Any]
        XCTAssertEqual(tools?.count, 0)

        let context = json?["context"] as? [Any]
        XCTAssertEqual(context?.count, 0)
    }

    func testEncodingWithMessages() throws {
        let messages: [any Message] = [
            UserMessage(id: "msg-1", content: "Hello"),
            AssistantMessage(id: "msg-2", content: "Hi")
        ]

        let input = RunAgentInput(
            threadId: "thread-1",
            runId: "run-1",
            messages: messages
        )

        let encoded = try JSONEncoder().encode(input)
        let json = try JSONSerialization.jsonObject(with: encoded) as? [String: Any]

        let messagesArray = json?["messages"] as? [[String: Any]]
        XCTAssertEqual(messagesArray?.count, 2)
        XCTAssertEqual(messagesArray?[0]["role"] as? String, "user")
        XCTAssertEqual(messagesArray?[1]["role"] as? String, "assistant")
    }

    // MARK: - Decoding Tests

    func testDecodingMinimal() throws {
        let json = """
        {
            "threadId": "thread-123",
            "runId": "run-456"
        }
        """

        let decoder = JSONDecoder()
        let input = try decoder.decode(RunAgentInput.self, from: Data(json.utf8))

        XCTAssertEqual(input.threadId, "thread-123")
        XCTAssertEqual(input.runId, "run-456")
        XCTAssertNil(input.parentRunId)
        XCTAssertTrue(input.messages.isEmpty)
        XCTAssertTrue(input.tools.isEmpty)
        XCTAssertTrue(input.context.isEmpty)
    }

    func testDecodingWithParentRunId() throws {
        let json = """
        {
            "threadId": "thread-1",
            "runId": "run-2",
            "parentRunId": "run-1"
        }
        """

        let decoder = JSONDecoder()
        let input = try decoder.decode(RunAgentInput.self, from: Data(json.utf8))

        XCTAssertEqual(input.parentRunId, "run-1")
    }

    func testDecodingWithMessages() throws {
        let json = """
        {
            "threadId": "thread-1",
            "runId": "run-1",
            "messages": [
                {
                    "id": "msg-1",
                    "role": "user",
                    "content": "Hello"
                },
                {
                    "id": "msg-2",
                    "role": "assistant",
                    "content": "Hi there!"
                }
            ]
        }
        """

        let decoder = JSONDecoder()
        let input = try decoder.decode(RunAgentInput.self, from: Data(json.utf8))

        XCTAssertEqual(input.messages.count, 2)
        XCTAssertEqual(input.messages[0].role, .user)
        XCTAssertEqual(input.messages[1].role, .assistant)
    }

    func testDecodingWithTools() throws {
        let json = """
        {
            "threadId": "thread-1",
            "runId": "run-1",
            "tools": [
                {
                    "name": "get_weather",
                    "description": "Get weather",
                    "parameters": {"type": "object"}
                }
            ]
        }
        """

        let decoder = JSONDecoder()
        let input = try decoder.decode(RunAgentInput.self, from: Data(json.utf8))

        XCTAssertEqual(input.tools.count, 1)
        XCTAssertEqual(input.tools[0].name, "get_weather")
    }

    func testDecodingWithContext() throws {
        let json = """
        {
            "threadId": "thread-1",
            "runId": "run-1",
            "context": [
                {"description": "User ID", "value": "12345"}
            ]
        }
        """

        let decoder = JSONDecoder()
        let input = try decoder.decode(RunAgentInput.self, from: Data(json.utf8))

        XCTAssertEqual(input.context.count, 1)
        XCTAssertEqual(input.context[0].value, "12345")
    }

    func testDecodingWithState() throws {
        let json = """
        {
            "threadId": "thread-1",
            "runId": "run-1",
            "state": {"counter": 42}
        }
        """

        let decoder = JSONDecoder()
        let input = try decoder.decode(RunAgentInput.self, from: Data(json.utf8))

        let state = try JSONSerialization.jsonObject(with: input.state) as? [String: Any]
        XCTAssertEqual(state?["counter"] as? Int, 42)
    }

    func testDecodingFailsWithoutThreadId() {
        let json = """
        {
            "runId": "run-1"
        }
        """

        let decoder = JSONDecoder()
        XCTAssertThrowsError(try decoder.decode(RunAgentInput.self, from: Data(json.utf8))) { error in
            XCTAssertTrue(error is DecodingError)
        }
    }

    func testDecodingFailsWithoutRunId() {
        let json = """
        {
            "threadId": "thread-1"
        }
        """

        let decoder = JSONDecoder()
        XCTAssertThrowsError(try decoder.decode(RunAgentInput.self, from: Data(json.utf8))) { error in
            XCTAssertTrue(error is DecodingError)
        }
    }

    // MARK: - Round-trip Tests

    func testRoundTripMinimal() throws {
        let original = RunAgentInput(
            threadId: "thread-rt-1",
            runId: "run-rt-1"
        )

        let encoder = JSONEncoder()
        let encoded = try encoder.encode(original)

        let decoder = JSONDecoder()
        let decoded = try decoder.decode(RunAgentInput.self, from: encoded)

        XCTAssertEqual(decoded.threadId, original.threadId)
        XCTAssertEqual(decoded.runId, original.runId)
        XCTAssertEqual(decoded.parentRunId, original.parentRunId)
    }

    func testRoundTripWithAllFields() throws {
        let messages: [any Message] = [
            UserMessage(id: "msg-1", content: "Test")
        ]
        let tools = [
            Tool(name: "tool1", description: "Test", parameters: Data("{}".utf8))
        ]
        let contexts = [
            Context(description: "key", value: "val")
        ]

        let original = RunAgentInput(
            threadId: "thread-1",
            runId: "run-1",
            parentRunId: "run-0",
            state: Data("{\"x\": 1}".utf8),
            messages: messages,
            tools: tools,
            context: contexts,
            forwardedProps: Data("{\"y\": 2}".utf8)
        )

        let encoder = JSONEncoder()
        let encoded = try encoder.encode(original)

        let decoder = JSONDecoder()
        let decoded = try decoder.decode(RunAgentInput.self, from: encoded)

        XCTAssertEqual(decoded.threadId, original.threadId)
        XCTAssertEqual(decoded.runId, original.runId)
        XCTAssertEqual(decoded.parentRunId, original.parentRunId)
        XCTAssertEqual(decoded.messages.count, 1)
        XCTAssertEqual(decoded.tools.count, 1)
        XCTAssertEqual(decoded.context.count, 1)
    }

    // MARK: - Equatable Tests

    func testEquality() {
        let input1 = RunAgentInput(threadId: "t1", runId: "r1")
        let input2 = RunAgentInput(threadId: "t1", runId: "r1")
        let input3 = RunAgentInput(threadId: "t2", runId: "r1")
        let input4 = RunAgentInput(threadId: "t1", runId: "r2")

        XCTAssertEqual(input1, input2)
        XCTAssertNotEqual(input1, input3)
        XCTAssertNotEqual(input1, input4)
    }

    func testEqualityWithDifferentMessages() {
        let messages1: [any Message] = [
            UserMessage(id: "msg-1", content: "Hello"),
            AssistantMessage(id: "msg-2", content: "Hi there!")
        ]

        let messages2: [any Message] = [
            UserMessage(id: "msg-3", content: "Goodbye"),
            AssistantMessage(id: "msg-4", content: "See you!")
        ]

        let input1 = RunAgentInput(
            threadId: "t1",
            runId: "r1",
            messages: messages1
        )

        let input2 = RunAgentInput(
            threadId: "t1",
            runId: "r1",
            messages: messages2
        )

        // Should be different because message IDs differ
        XCTAssertNotEqual(input1, input2)
    }

    func testEqualityWithIdenticalMessages() {
        let messages1: [any Message] = [
            UserMessage(id: "msg-1", content: "Hello"),
            AssistantMessage(id: "msg-2", content: "Hi there!")
        ]

        let messages2: [any Message] = [
            UserMessage(id: "msg-1", content: "Hello"),
            AssistantMessage(id: "msg-2", content: "Hi there!")
        ]

        let input1 = RunAgentInput(
            threadId: "t1",
            runId: "r1",
            messages: messages1
        )

        let input2 = RunAgentInput(
            threadId: "t1",
            runId: "r1",
            messages: messages2
        )

        // Should be equal when messages have same id, role, content, name
        XCTAssertEqual(input1, input2)
    }

    // MARK: - Hashable Tests

    func testHashable() {
        let input1 = RunAgentInput(threadId: "t1", runId: "r1")
        let input2 = RunAgentInput(threadId: "t2", runId: "r2")

        let set: Set<RunAgentInput> = [input1, input2]
        XCTAssertEqual(set.count, 2)
        XCTAssertTrue(set.contains(input1))
        XCTAssertTrue(set.contains(input2))
    }

    func testHashableWithDifferentMessages() {
        let messages1: [any Message] = [
            UserMessage(id: "msg-1", content: "Hello"),
            AssistantMessage(id: "msg-2", content: "Hi!")
        ]

        let messages2: [any Message] = [
            UserMessage(id: "msg-3", content: "Goodbye"),
            AssistantMessage(id: "msg-4", content: "Bye!")
        ]

        let input1 = RunAgentInput(
            threadId: "t1",
            runId: "r1",
            messages: messages1
        )

        let input2 = RunAgentInput(
            threadId: "t1",
            runId: "r1",
            messages: messages2
        )

        // Different messages should produce different hashes (or at least be distinguishable in Set)
        let set: Set<RunAgentInput> = [input1, input2]
        XCTAssertEqual(set.count, 2, "Set should contain both inputs with different messages")
        XCTAssertTrue(set.contains(input1))
        XCTAssertTrue(set.contains(input2))
    }

    func testHashConsistency() {
        let messages: [any Message] = [
            UserMessage(id: "msg-1", content: "Test")
        ]

        let input1 = RunAgentInput(
            threadId: "t1",
            runId: "r1",
            messages: messages
        )

        let input2 = RunAgentInput(
            threadId: "t1",
            runId: "r1",
            messages: messages
        )

        // Equal objects must have equal hashes
        XCTAssertEqual(input1, input2)
        XCTAssertEqual(input1.hashValue, input2.hashValue)
    }

    // MARK: - Sendable Tests

    func testSendableConformance() {
        let input = RunAgentInput(
            threadId: "thread-concurrent",
            runId: "run-concurrent"
        )

        Task {
            let capturedInput = input
            XCTAssertEqual(capturedInput.threadId, "thread-concurrent")
        }
    }

    // MARK: - Real-world Usage Tests

    func testHTTPPostRequest() {
        let messages: [any Message] = [
            DeveloperMessage(id: "dev-1", content: "You are a helpful assistant"),
            UserMessage(id: "user-1", content: "What's the weather?")
        ]

        let tools = [
            Tool(
                name: "get_weather",
                description: "Get current weather",
                parameters: Data("""
                {
                    "type": "object",
                    "properties": {
                        "location": {"type": "string"}
                    }
                }
                """.utf8)
            )
        ]

        let contexts = [
            Context(description: "user_location", value: "San Francisco, CA"),
            Context(description: "timezone", value: "America/Los_Angeles")
        ]

        let input = RunAgentInput(
            threadId: "thread-weather-1",
            runId: "run-weather-1",
            messages: messages,
            tools: tools,
            context: contexts
        )

        XCTAssertEqual(input.messages.count, 2)
        XCTAssertEqual(input.tools.count, 1)
        XCTAssertEqual(input.context.count, 2)
    }

    func testNestedRunWithParentId() {
        let input = RunAgentInput(
            threadId: "thread-nested",
            runId: "run-child-1",
            parentRunId: "run-parent-1"
        )

        XCTAssertEqual(input.parentRunId, "run-parent-1")
    }

    func testEmptyDefaults() {
        let input = RunAgentInput(
            threadId: "thread-1",
            runId: "run-1"
        )

        XCTAssertTrue(input.messages.isEmpty)
        XCTAssertTrue(input.tools.isEmpty)
        XCTAssertTrue(input.context.isEmpty)
    }

    // MARK: - Regression: scalar type preservation through the state/forwardedProps encode–decode cycle

    // The state and forwardedProps fields go through JSONSerialization ↔ JSONCodingHelpers.
    // JSONSerialization returns __NSCFBoolean for booleans and __NSCFNumber for integers.
    // The encode path (encodeJSONObject) must not confuse them, and the decode path
    // (decodeJSONObject, which tries Int before Bool) must also preserve them.

    // --- Wire JSON type verification (encode-only) ---

    func test_encodeState_integerZero_isNotEncodedAsFalse() throws {
        let input = RunAgentInput(
            threadId: "t", runId: "r",
            state: Data(#"{"retries": 0, "count": 1}"#.utf8)
        )
        let wire = String(data: try JSONEncoder().encode(input), encoding: .utf8)!

        XCTAssertTrue(
            wire.contains("\"retries\":0") || wire.contains("\"retries\": 0"),
            "Integer 0 must not become false on the wire. Got: \(wire)"
        )
        XCTAssertTrue(
            wire.contains("\"count\":1") || wire.contains("\"count\": 1"),
            "Integer 1 must not become true on the wire. Got: \(wire)"
        )
    }

    func test_encodeState_booleans_areNotEncodedAsIntegers() throws {
        let input = RunAgentInput(
            threadId: "t", runId: "r",
            state: Data(#"{"enabled": true, "disabled": false}"#.utf8)
        )
        let wire = String(data: try JSONEncoder().encode(input), encoding: .utf8)!

        XCTAssertTrue(
            wire.contains("\"enabled\":true") || wire.contains("\"enabled\": true"),
            "Boolean true must not become 1 on the wire. Got: \(wire)"
        )
        XCTAssertTrue(
            wire.contains("\"disabled\":false") || wire.contains("\"disabled\": false"),
            "Boolean false must not become 0 on the wire. Got: \(wire)"
        )
    }

    func test_encodeForwardedProps_integerZero_isNotEncodedAsFalse() throws {
        let input = RunAgentInput(
            threadId: "t", runId: "r",
            forwardedProps: Data(#"{"timeout": 0, "maxItems": 100}"#.utf8)
        )
        let wire = String(data: try JSONEncoder().encode(input), encoding: .utf8)!

        XCTAssertTrue(
            wire.contains("\"timeout\":0") || wire.contains("\"timeout\": 0"),
            "timeout:0 must stay integer 0, not become false. Got: \(wire)"
        )
    }

    func test_encodeState_nestedIntegersAndBooleans_preserveTypes() throws {
        // Regression for nested values — the bug can surface in nested dicts too.
        let input = RunAgentInput(
            threadId: "t", runId: "r",
            state: Data("""
            {
                "pagination": {"page": 0, "hasMore": true},
                "flags": {"debug": false, "level": 1}
            }
            """.utf8)
        )
        let wire = String(data: try JSONEncoder().encode(input), encoding: .utf8)!

        // Integers must remain integers
        XCTAssertFalse(
            wire.contains("\"page\":false") || wire.contains("\"page\": false"),
            "Nested page:0 must not become false. Got: \(wire)"
        )
        XCTAssertFalse(
            wire.contains("\"level\":true") || wire.contains("\"level\": true"),
            "Nested level:1 must not become true. Got: \(wire)"
        )
        // Booleans must remain booleans
        XCTAssertFalse(
            wire.contains("\"hasMore\":1") || wire.contains("\"hasMore\": 1"),
            "Nested hasMore:true must not become 1. Got: \(wire)"
        )
        XCTAssertFalse(
            wire.contains("\"debug\":0") || wire.contains("\"debug\": 0"),
            "Nested debug:false must not become 0. Got: \(wire)"
        )
    }

    // --- Round-trip type verification ---

    func test_roundTrip_stateWithIntegerZero_preservesType() throws {
        let original = RunAgentInput(
            threadId: "t", runId: "r",
            state: Data(#"{"retries": 0}"#.utf8)
        )
        let encoded = try JSONEncoder().encode(original)

        // Wire is the unambiguous check — __NSCFNumber(0) as? Bool returns Optional(false)
        // on Apple/Linux platforms due to NSNumber bridging, making `as? Bool` unreliable
        // for distinguishing integer 0 from boolean false. Use the wire JSON string instead.
        let wire = String(data: encoded, encoding: .utf8)!
        XCTAssertTrue(
            wire.contains("\"retries\":0") || wire.contains("\"retries\": 0"),
            "retries:0 must be integer 0 on the wire after round-trip. Got: \(wire)"
        )
        XCTAssertFalse(wire.contains("\"retries\":false"), "retries:0 must not become false")

        let decoded = try JSONDecoder().decode(RunAgentInput.self, from: encoded)
        let stateObj = try JSONSerialization.jsonObject(with: decoded.state) as? [String: Any]
        // isJSONBoolean uses CFGetTypeID to distinguish __NSCFBoolean from __NSCFNumber
        XCTAssertFalse(
            isJSONBoolean(stateObj?["retries"] as Any),
            "retries:0 must be __NSCFNumber (integer), not __NSCFBoolean"
        )
    }

    func test_roundTrip_stateWithIntegerOne_preservesType() throws {
        let original = RunAgentInput(
            threadId: "t", runId: "r",
            state: Data(#"{"count": 1}"#.utf8)
        )
        let encoded = try JSONEncoder().encode(original)

        let wire = String(data: encoded, encoding: .utf8)!
        XCTAssertTrue(
            wire.contains("\"count\":1") || wire.contains("\"count\": 1"),
            "count:1 must be integer 1 on the wire. Got: \(wire)"
        )
        XCTAssertFalse(wire.contains("\"count\":true"), "count:1 must not become true")

        let decoded = try JSONDecoder().decode(RunAgentInput.self, from: encoded)
        let stateObj = try JSONSerialization.jsonObject(with: decoded.state) as? [String: Any]
        XCTAssertFalse(
            isJSONBoolean(stateObj?["count"] as Any),
            "count:1 must be __NSCFNumber (integer), not __NSCFBoolean"
        )
    }

    func test_roundTrip_stateWithBoolFalse_preservesType() throws {
        let original = RunAgentInput(
            threadId: "t", runId: "r",
            state: Data(#"{"enabled": false}"#.utf8)
        )
        let encoded = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(RunAgentInput.self, from: encoded)

        let stateObj = try JSONSerialization.jsonObject(with: decoded.state) as? [String: Any]
        let enabled = stateObj?["enabled"]
        XCTAssertTrue(enabled is Bool, "enabled:false must round-trip as Bool")
        XCTAssertEqual(enabled as? Bool, false, "enabled:false must round-trip as false, not 0")
    }

    func test_roundTrip_stateWithBoolTrue_preservesType() throws {
        let original = RunAgentInput(
            threadId: "t", runId: "r",
            state: Data(#"{"active": true}"#.utf8)
        )
        let encoded = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(RunAgentInput.self, from: encoded)

        let stateObj = try JSONSerialization.jsonObject(with: decoded.state) as? [String: Any]
        let active = stateObj?["active"]
        XCTAssertTrue(active is Bool, "active:true must round-trip as Bool")
        XCTAssertEqual(active as? Bool, true)
    }

    func test_roundTrip_stateWithNestedMixedTypes_preservesTypes() throws {
        let original = RunAgentInput(
            threadId: "t", runId: "r",
            state: Data("""
            {"page": 0, "hasMore": true, "config": {"level": 1, "debug": false}}
            """.utf8)
        )
        let encoded = try JSONEncoder().encode(original)

        // Verify the wire JSON — the authoritative check. __NSCFBoolean as? Int
        // succeeds via NSNumber bridging, so asserting the parsed value's Int cast
        // would give false positives; the wire string is unambiguous.
        let wire = String(data: encoded, encoding: .utf8)!
        XCTAssertFalse(wire.contains("\"page\":false") || wire.contains("\"page\": false"),
                       "page:0 must not become false on wire")
        XCTAssertFalse(wire.contains("\"level\":true") || wire.contains("\"level\": true"),
                       "level:1 must not become true on wire")
        XCTAssertFalse(wire.contains("\"hasMore\":1") || wire.contains("\"hasMore\": 1"),
                       "hasMore:true must not become 1 on wire")
        XCTAssertFalse(wire.contains("\"debug\":0") || wire.contains("\"debug\": 0"),
                       "debug:false must not become 0 on wire")

        let decoded = try JSONDecoder().decode(RunAgentInput.self, from: encoded)
        let stateObj = try JSONSerialization.jsonObject(with: decoded.state) as? [String: Any]

        // isJSONBoolean uses CFGetTypeID — the only reliable way to distinguish
        // __NSCFBoolean from __NSCFNumber on Apple/Linux (NSNumber as? Bool / as? Int
        // succeeds for both, making `is Bool` / `is Int` checks inherently ambiguous).
        XCTAssertFalse(isJSONBoolean(stateObj?["page"] as Any),
                       "page:0 must be an integer, not boolean")
        XCTAssertTrue(isJSONBoolean(stateObj?["hasMore"] as Any),
                      "hasMore:true must be a boolean")

        let config = stateObj?["config"] as? [String: Any]
        XCTAssertFalse(isJSONBoolean(config?["level"] as Any),
                       "level:1 must be an integer, not boolean")
        XCTAssertTrue(isJSONBoolean(config?["debug"] as Any),
                      "debug:false must be a boolean, not integer 0")
    }
}
