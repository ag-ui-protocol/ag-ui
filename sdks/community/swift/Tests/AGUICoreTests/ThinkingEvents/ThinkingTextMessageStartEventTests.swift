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

final class ThinkingTextMessageStartEventTests: XCTestCase,
                                                 AGUIEventDecoderTestHelpers,
                                                 EventDecodingErrorTests {

    // MARK: - EventDecodingErrorTests Protocol Requirements

    var validEventFieldsWithoutType: [String: Any] {
        [:]
    }

    var eventTypeString: String { "THINKING_TEXT_MESSAGE_START" }
    var expectedEventType: EventType { .thinkingTextMessageStart }
    var unknownEventTypeString: String { "THINKING_TEXT_MESSAGE_PAUSE" }

    // MARK: - Feature: Decode THINKING_TEXT_MESSAGE_START

    func test_decodeValidThinkingTextMessageStart_returnsEvent() throws {
        // Given
        let data = jsonData("""
        {
          "type": "THINKING_TEXT_MESSAGE_START"
        }
        """)

        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        guard let thinkingStart = event as? ThinkingTextMessageStartEvent else {
            return XCTFail("Expected ThinkingTextMessageStartEvent, got \(type(of: event))")
        }
        XCTAssertEqual(thinkingStart.eventType, .thinkingTextMessageStart)
        XCTAssertNil(thinkingStart.timestamp)
    }

    func test_decodeThinkingTextMessageStart_withTimestamp_populatesTimestamp() throws {
        // Given
        let data = jsonData("""
        {
          "type": "THINKING_TEXT_MESSAGE_START",
          "timestamp": \(EventTestData.timestamp)
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let thinkingStart = try XCTUnwrap(event as? ThinkingTextMessageStartEvent)
        XCTAssertEqual(thinkingStart.timestamp, EventTestData.timestamp)
    }

    func test_decodeThinkingTextMessageStart_preservesRawEventBytes() throws {
        // Given
        let data = jsonData("""
        {
          "type": "THINKING_TEXT_MESSAGE_START",
          "timestamp": \(EventTestData.timestamp)
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let thinkingStart = try XCTUnwrap(event as? ThinkingTextMessageStartEvent)
        XCTAssertEqual(thinkingStart.rawEvent, data)
    }

    func test_decodeThinkingTextMessageStart_ignoresUnknownExtraFields() throws {
        // Given
        let data = jsonData("""
        {
          "type": "THINKING_TEXT_MESSAGE_START",
          "extraField": "ignored"
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let thinkingStart = try XCTUnwrap(event as? ThinkingTextMessageStartEvent)
        XCTAssertEqual(thinkingStart.eventType, .thinkingTextMessageStart)
    }

    func test_decodeThinkingTextMessageStart_wrongTypeForTimestamp_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "THINKING_TEXT_MESSAGE_START",
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

    func test_thinkingTextMessageStartEvent_eventTypeIsAlways() {
        // Given
        let event = ThinkingTextMessageStartEvent(timestamp: nil, rawEvent: nil)

        // Then
        XCTAssertEqual(event.eventType, .thinkingTextMessageStart)
    }

    func test_thinkingTextMessageStartEvent_equatable_sameFields_areEqual() {
        // Given
        let event1 = ThinkingTextMessageStartEvent(timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = ThinkingTextMessageStartEvent(timestamp: EventTestData.timestamp, rawEvent: nil)

        // Then
        XCTAssertEqual(event1, event2)
    }

    func test_thinkingTextMessageStartEvent_equatable_differentTimestamps_areNotEqual() {
        // Given
        let event1 = ThinkingTextMessageStartEvent(timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = ThinkingTextMessageStartEvent(timestamp: EventTestData.timestamp2, rawEvent: nil)

        // Then
        XCTAssertNotEqual(event1, event2)
    }

    func test_thinkingTextMessageStartEvent_description_containsKeyInformation() {
        // Given
        let event = ThinkingTextMessageStartEvent(timestamp: EventTestData.timestamp, rawEvent: nil)

        // Then
        let description = event.description
        XCTAssertTrue(description.contains("ThinkingTextMessageStartEvent"))
        XCTAssertTrue(description.contains("timestamp"))
    }
}
