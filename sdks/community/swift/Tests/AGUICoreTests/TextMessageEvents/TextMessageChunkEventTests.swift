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

final class TextMessageChunkEventTests: XCTestCase,
                                        AGUIEventDecoderTestHelpers,
                                        EventDecodingErrorTests {

    // MARK: - EventDecodingErrorTests Protocol Requirements

    var validEventFieldsWithoutType: [String: Any] {
        [
            "messageId": EventTestData.messageId,
            "delta": "Hello"
        ]
    }

    var eventTypeString: String { "TEXT_MESSAGE_CHUNK" }
    var expectedEventType: EventType { .textMessageChunk }
    var unknownEventTypeString: String { "TEXT_MESSAGE_PAUSED" }

    // MARK: - Feature: Decode TEXT_MESSAGE_CHUNK

    func test_decodeValidTextMessageChunk_returnsTextMessageChunkEvent() throws {
        // Given
        let data = jsonData("""
        {
          "type": "TEXT_MESSAGE_CHUNK",
          "messageId": "\(EventTestData.messageId)",
          "delta": "Hello"
        }
        """)

        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        guard let chunk = event as? TextMessageChunkEvent else {
            return XCTFail("Expected TextMessageChunkEvent, got \(type(of: event))")
        }
        XCTAssertEqual(chunk.eventType, .textMessageChunk)
        XCTAssertEqual(chunk.messageId, EventTestData.messageId)
        XCTAssertEqual(chunk.delta, "Hello")
        XCTAssertNil(chunk.role)
        XCTAssertNil(chunk.timestamp)
    }

    func test_decodeTextMessageChunkWithRole_returnsTextMessageChunkEvent() throws {
        // Given
        let data = jsonData("""
        {
          "type": "TEXT_MESSAGE_CHUNK",
          "messageId": "\(EventTestData.messageId)",
          "role": "assistant",
          "delta": "Hello"
        }
        """)

        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        guard let chunk = event as? TextMessageChunkEvent else {
            return XCTFail("Expected TextMessageChunkEvent, got \(type(of: event))")
        }
        XCTAssertEqual(chunk.role, "assistant")
        XCTAssertEqual(chunk.delta, "Hello")
    }

    func test_decodeTextMessageChunkWithTimestamp_returnsTextMessageChunkEvent() throws {
        // Given
        let data = jsonData("""
        {
          "type": "TEXT_MESSAGE_CHUNK",
          "messageId": "\(EventTestData.messageId)",
          "delta": "Hello",
          "timestamp": \(EventTestData.timestamp)
        }
        """)

        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        guard let chunk = event as? TextMessageChunkEvent else {
            return XCTFail("Expected TextMessageChunkEvent, got \(type(of: event))")
        }
        XCTAssertEqual(chunk.timestamp, EventTestData.timestamp)
    }

    func test_decodeTextMessageChunkWithoutMessageId_returnsTextMessageChunkEvent() throws {
        // Given
        let data = jsonData("""
        {
          "type": "TEXT_MESSAGE_CHUNK",
          "delta": "World"
        }
        """)

        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        guard let chunk = event as? TextMessageChunkEvent else {
            return XCTFail("Expected TextMessageChunkEvent, got \(type(of: event))")
        }
        XCTAssertNil(chunk.messageId)
        XCTAssertEqual(chunk.delta, "World")
    }

    func test_textMessageChunkEvent_eventTypeIsAlwaysTextMessageChunk() {
        // Given
        let event = TextMessageChunkEvent(
            messageId: EventTestData.messageId,
            delta: "Hello"
        )

        // Then
        XCTAssertEqual(event.eventType, .textMessageChunk)
    }

    // MARK: - Equatable Tests

    func test_textMessageChunkEvent_equatable_sameFields_areEqual() {
        // Given
        let event1 = TextMessageChunkEvent(
            messageId: EventTestData.messageId,
            role: "assistant",
            delta: "Hello",
            timestamp: EventTestData.timestamp,
            rawEvent: nil
        )
        let event2 = TextMessageChunkEvent(
            messageId: EventTestData.messageId,
            role: "assistant",
            delta: "Hello",
            timestamp: EventTestData.timestamp,
            rawEvent: nil
        )

        // Then
        XCTAssertEqual(event1, event2)
    }

    func test_textMessageChunkEvent_equatable_differentMessageIds_areNotEqual() {
        // Given
        let event1 = TextMessageChunkEvent(
            messageId: EventTestData.messageId,
            delta: "Hello"
        )
        let event2 = TextMessageChunkEvent(
            messageId: EventTestData.messageId2,
            delta: "Hello"
        )

        // Then
        XCTAssertNotEqual(event1, event2)
    }

    func test_textMessageChunkEvent_equatable_differentDeltas_areNotEqual() {
        // Given
        let event1 = TextMessageChunkEvent(
            messageId: EventTestData.messageId,
            delta: "Hello"
        )
        let event2 = TextMessageChunkEvent(
            messageId: EventTestData.messageId,
            delta: "World"
        )

        // Then
        XCTAssertNotEqual(event1, event2)
    }

    func test_textMessageChunkEvent_equatable_oneNilMessageId_areNotEqual() {
        // Given
        let event1 = TextMessageChunkEvent(
            messageId: EventTestData.messageId,
            delta: "Hello"
        )
        let event2 = TextMessageChunkEvent(
            messageId: nil,
            delta: "Hello"
        )

        // Then
        XCTAssertNotEqual(event1, event2)
    }

    func test_textMessageChunkEvent_equatable_bothNilMessageIds_areEqual() {
        // Given
        let event1 = TextMessageChunkEvent(
            messageId: nil,
            delta: "Hello"
        )
        let event2 = TextMessageChunkEvent(
            messageId: nil,
            delta: "Hello"
        )

        // Then
        XCTAssertEqual(event1, event2)
    }
}
