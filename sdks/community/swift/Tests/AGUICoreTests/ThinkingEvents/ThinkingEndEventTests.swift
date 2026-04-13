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

final class ThinkingEndEventTests: XCTestCase,
                                    AGUIEventDecoderTestHelpers,
                                    EventDecodingErrorTests {

    // MARK: - EventDecodingErrorTests Protocol Requirements

    var validEventFieldsWithoutType: [String: Any] {
        [:]
    }

    var eventTypeString: String { "THINKING_END" }
    var expectedEventType: EventType { .thinkingEnd }
    var unknownEventTypeString: String { "THINKING_PAUSE" }

    // MARK: - Feature: Decode THINKING_END

    func test_decodeValidThinkingEnd_returnsThinkingEndEvent() throws {
        // Given
        let data = jsonData("""
        {
          "type": "THINKING_END"
        }
        """)

        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        guard let thinkingEnd = event as? ThinkingEndEvent else {
            return XCTFail("Expected ThinkingEndEvent, got \(type(of: event))")
        }
        XCTAssertEqual(thinkingEnd.eventType, .thinkingEnd)
        XCTAssertNil(thinkingEnd.timestamp)
    }

    func test_decodeThinkingEnd_withTimestamp_populatesTimestamp() throws {
        // Given
        let data = jsonData("""
        {
          "type": "THINKING_END",
          "timestamp": \(EventTestData.timestamp)
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let thinkingEnd = try XCTUnwrap(event as? ThinkingEndEvent)
        XCTAssertEqual(thinkingEnd.timestamp, EventTestData.timestamp)
    }

    func test_decodeThinkingEnd_preservesRawEventBytes() throws {
        // Given
        let data = jsonData("""
        {
          "type": "THINKING_END",
          "timestamp": \(EventTestData.timestamp)
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let thinkingEnd = try XCTUnwrap(event as? ThinkingEndEvent)
        XCTAssertEqual(thinkingEnd.rawEvent, data)
    }

    func test_decodeThinkingEnd_ignoresUnknownExtraFields() throws {
        // Given
        let data = jsonData("""
        {
          "type": "THINKING_END",
          "extraField": "ignored",
          "nested": { "x": 1 }
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let thinkingEnd = try XCTUnwrap(event as? ThinkingEndEvent)
        XCTAssertEqual(thinkingEnd.eventType, .thinkingEnd)
    }

    func test_decodeThinkingEnd_wrongTypeForTimestamp_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "THINKING_END",
          "timestamp": "not-a-number"
        }
        """)
        let decoder = makeStrictDecoder()

        // When / Then
        XCTAssertThrowsError(try decoder.decode(data)) { error in
            guard case .decodingFailed(let message) = error as? EventDecodingError else {
                return XCTFail("Expected decodingFailed, got \(error)")
            }
            XCTAssertTrue(message.contains("timestamp") || message.contains("Type mismatch"))
        }
    }

    // MARK: - Feature: Model behaviors

    func test_thinkingEndEvent_eventTypeIsAlwaysThinkingEnd() {
        // Given
        let event = ThinkingEndEvent(timestamp: nil, rawEvent: nil)

        // Then
        XCTAssertEqual(event.eventType, .thinkingEnd)
    }

    func test_thinkingEndEvent_equatable_sameFields_areEqual() {
        // Given
        let event1 = ThinkingEndEvent(timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = ThinkingEndEvent(timestamp: EventTestData.timestamp, rawEvent: nil)

        // Then
        XCTAssertEqual(event1, event2)
    }

    func test_thinkingEndEvent_equatable_differentTimestamps_areNotEqual() {
        // Given
        let event1 = ThinkingEndEvent(timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = ThinkingEndEvent(timestamp: EventTestData.timestamp2, rawEvent: nil)

        // Then
        XCTAssertNotEqual(event1, event2)
    }

    func test_thinkingEndEvent_equatable_oneWithTimestampOneWithout_areNotEqual() {
        // Given
        let event1 = ThinkingEndEvent(timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = ThinkingEndEvent(timestamp: nil, rawEvent: nil)

        // Then
        XCTAssertNotEqual(event1, event2)
    }

    func test_thinkingEndEvent_description_containsKeyInformation() {
        // Given
        let event = ThinkingEndEvent(timestamp: EventTestData.timestamp, rawEvent: nil)

        // Then
        let description = event.description
        XCTAssertTrue(description.contains("ThinkingEndEvent"))
        XCTAssertTrue(description.contains("timestamp"))
    }

    func test_thinkingEndEvent_debugDescription_containsDetailedInformation() {
        // Given
        let event = ThinkingEndEvent(timestamp: EventTestData.timestamp, rawEvent: nil)

        // Then
        let debugDescription = event.debugDescription
        XCTAssertTrue(debugDescription.contains("ThinkingEndEvent"))
        XCTAssertTrue(debugDescription.contains("timestamp"))
        XCTAssertTrue(debugDescription.contains("eventType"))
    }
}
