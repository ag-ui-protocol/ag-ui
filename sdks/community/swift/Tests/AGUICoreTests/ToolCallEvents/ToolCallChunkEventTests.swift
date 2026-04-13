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

final class ToolCallChunkEventTests: XCTestCase,
                                    AGUIEventDecoderTestHelpers,
                                    EventDecodingErrorTests {

    // MARK: - EventDecodingErrorTests Protocol Requirements

    var validEventFieldsWithoutType: [String: Any] {
        [
            "toolCallId": EventTestData.toolCallId,
            "toolCallName": "test_tool",
            "delta": "{\"key\":\"value\"}"
        ]
    }

    var eventTypeString: String { "TOOL_CALL_CHUNK" }
    var expectedEventType: EventType { .toolCallChunk }
    var unknownEventTypeString: String { "TOOL_CALL_PAUSED" }

    // MARK: - Feature: Decode TOOL_CALL_CHUNK

    func test_decodeValidToolCallChunk_returnsToolCallChunkEvent() throws {
        // Given
        let data = jsonData("""
        {
          "type": "TOOL_CALL_CHUNK",
          "toolCallId": "\(EventTestData.toolCallId)",
          "toolCallName": "test_tool",
          "delta": "{\\"key\\": \\"value\\"}"
        }
        """)

        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        guard let chunk = event as? ToolCallChunkEvent else {
            return XCTFail("Expected ToolCallChunkEvent, got \(type(of: event))")
        }
        XCTAssertEqual(chunk.eventType, .toolCallChunk)
        XCTAssertEqual(chunk.toolCallId, EventTestData.toolCallId)
        XCTAssertEqual(chunk.toolCallName, "test_tool")
        // JSONDecoder may add spaces, so check that delta contains the key-value pair
        XCTAssertTrue(chunk.delta?.contains("\"key\"") == true)
        XCTAssertTrue(chunk.delta?.contains("\"value\"") == true)
        XCTAssertNil(chunk.parentMessageId)
        XCTAssertNil(chunk.timestamp)
    }

    func test_decodeToolCallChunkWithParentMessageId_returnsToolCallChunkEvent() throws {
        // Given
        let data = jsonData("""
        {
          "type": "TOOL_CALL_CHUNK",
          "toolCallId": "\(EventTestData.toolCallId)",
          "toolCallName": "test_tool",
          "delta": "{\\"key\\": \\"value\\"}",
          "parentMessageId": "\(EventTestData.messageId)"
        }
        """)

        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        guard let chunk = event as? ToolCallChunkEvent else {
            return XCTFail("Expected ToolCallChunkEvent, got \(type(of: event))")
        }
        XCTAssertEqual(chunk.parentMessageId, EventTestData.messageId)
    }

    func test_decodeToolCallChunkWithTimestamp_returnsToolCallChunkEvent() throws {
        // Given
        let data = jsonData("""
        {
          "type": "TOOL_CALL_CHUNK",
          "toolCallId": "\(EventTestData.toolCallId)",
          "toolCallName": "test_tool",
          "delta": "{\\"key\\": \\"value\\"}",
          "timestamp": \(EventTestData.timestamp)
        }
        """)

        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        guard let chunk = event as? ToolCallChunkEvent else {
            return XCTFail("Expected ToolCallChunkEvent, got \(type(of: event))")
        }
        XCTAssertEqual(chunk.timestamp, EventTestData.timestamp)
    }

    func test_decodeToolCallChunkWithoutToolCallId_returnsToolCallChunkEvent() throws {
        // Given
        let data = jsonData("""
        {
          "type": "TOOL_CALL_CHUNK",
          "delta": "{\\"key\\": \\"value\\"}"
        }
        """)

        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        guard let chunk = event as? ToolCallChunkEvent else {
            return XCTFail("Expected ToolCallChunkEvent, got \(type(of: event))")
        }
        XCTAssertNil(chunk.toolCallId)
        XCTAssertNil(chunk.toolCallName)
        // JSONDecoder may add spaces, so check that delta contains the key-value pair
        XCTAssertTrue(chunk.delta?.contains("\"key\"") == true)
        XCTAssertTrue(chunk.delta?.contains("\"value\"") == true)
    }

    func test_toolCallChunkEvent_eventTypeIsAlwaysToolCallChunk() {
        // Given
        let event = ToolCallChunkEvent(
            toolCallId: EventTestData.toolCallId,
            toolCallName: "test_tool",
            delta: "{\"key\":\"value\"}"
        )

        // Then
        XCTAssertEqual(event.eventType, .toolCallChunk)
    }

    // MARK: - Equatable Tests

    func test_toolCallChunkEvent_equatable_sameFields_areEqual() {
        // Given
        let event1 = ToolCallChunkEvent(
            toolCallId: EventTestData.toolCallId,
            toolCallName: "test_tool",
            delta: "{\"key\":\"value\"}",
            parentMessageId: EventTestData.messageId,
            timestamp: EventTestData.timestamp,
            rawEvent: nil
        )
        let event2 = ToolCallChunkEvent(
            toolCallId: EventTestData.toolCallId,
            toolCallName: "test_tool",
            delta: "{\"key\":\"value\"}",
            parentMessageId: EventTestData.messageId,
            timestamp: EventTestData.timestamp,
            rawEvent: nil
        )

        // Then
        XCTAssertEqual(event1, event2)
    }

    func test_toolCallChunkEvent_equatable_differentToolCallIds_areNotEqual() {
        // Given
        let event1 = ToolCallChunkEvent(
            toolCallId: EventTestData.toolCallId,
            toolCallName: "test_tool",
            delta: "{\"key\":\"value\"}"
        )
        let event2 = ToolCallChunkEvent(
            toolCallId: "other-id",
            toolCallName: "test_tool",
            delta: "{\"key\":\"value\"}"
        )

        // Then
        XCTAssertNotEqual(event1, event2)
    }

    func test_toolCallChunkEvent_equatable_differentDeltas_areNotEqual() {
        // Given
        let event1 = ToolCallChunkEvent(
            toolCallId: EventTestData.toolCallId,
            toolCallName: "test_tool",
            delta: "{\"key\":\"value\"}"
        )
        let event2 = ToolCallChunkEvent(
            toolCallId: EventTestData.toolCallId,
            toolCallName: "test_tool",
            delta: "{\"key\":\"other\"}"
        )

        // Then
        XCTAssertNotEqual(event1, event2)
    }

    func test_toolCallChunkEvent_equatable_oneNilToolCallId_areNotEqual() {
        // Given
        let event1 = ToolCallChunkEvent(
            toolCallId: EventTestData.toolCallId,
            toolCallName: "test_tool",
            delta: "{\"key\":\"value\"}"
        )
        let event2 = ToolCallChunkEvent(
            toolCallId: nil,
            toolCallName: "test_tool",
            delta: "{\"key\":\"value\"}"
        )

        // Then
        XCTAssertNotEqual(event1, event2)
    }

    func test_toolCallChunkEvent_equatable_bothNilToolCallIds_areEqual() {
        // Given
        let event1 = ToolCallChunkEvent(
            toolCallId: nil,
            toolCallName: nil,
            delta: "{\"key\":\"value\"}"
        )
        let event2 = ToolCallChunkEvent(
            toolCallId: nil,
            toolCallName: nil,
            delta: "{\"key\":\"value\"}"
        )

        // Then
        XCTAssertEqual(event1, event2)
    }
}
