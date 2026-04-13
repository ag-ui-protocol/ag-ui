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

final class ThinkingStartEventTests: XCTestCase,
                                      AGUIEventDecoderTestHelpers,
                                      EventDecodingErrorTests {

    // MARK: - EventDecodingErrorTests Protocol Requirements

    var validEventFieldsWithoutType: [String: Any] {
        ["title": "Analyzing user request"]
    }

    var eventTypeString: String { "THINKING_START" }
    var expectedEventType: EventType { .thinkingStart }
    var unknownEventTypeString: String { "THINKING_PAUSE" }

    // MARK: - Feature: Decode THINKING_START

    func test_decodeValidThinkingStart_returnsThinkingStartEvent() throws {
        // Given
        let data = jsonData("""
        {
          "type": "THINKING_START"
        }
        """)

        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        guard let thinkingStart = event as? ThinkingStartEvent else {
            return XCTFail("Expected ThinkingStartEvent, got \(type(of: event))")
        }
        XCTAssertEqual(thinkingStart.eventType, .thinkingStart)
        XCTAssertNil(thinkingStart.title)
        XCTAssertNil(thinkingStart.timestamp)
    }

    func test_decodeThinkingStart_withTitle_populatesTitle() throws {
        // Given
        let data = jsonData("""
        {
          "type": "THINKING_START",
          "title": "Analyzing user request"
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let thinkingStart = try XCTUnwrap(event as? ThinkingStartEvent)
        XCTAssertEqual(thinkingStart.title, "Analyzing user request")
    }

    func test_decodeThinkingStart_withTimestamp_populatesTimestamp() throws {
        // Given
        let data = jsonData("""
        {
          "type": "THINKING_START",
          "timestamp": \(EventTestData.timestamp)
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let thinkingStart = try XCTUnwrap(event as? ThinkingStartEvent)
        XCTAssertEqual(thinkingStart.timestamp, EventTestData.timestamp)
    }

    func test_decodeThinkingStart_preservesRawEventBytes() throws {
        // Given
        let data = jsonData("""
        {
          "type": "THINKING_START",
          "timestamp": \(EventTestData.timestamp)
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let thinkingStart = try XCTUnwrap(event as? ThinkingStartEvent)
        XCTAssertEqual(thinkingStart.rawEvent, data)
    }

    func test_decodeThinkingStart_ignoresUnknownExtraFields() throws {
        // Given
        let data = jsonData("""
        {
          "type": "THINKING_START",
          "extraField": "ignored",
          "nested": { "x": 1 }
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let thinkingStart = try XCTUnwrap(event as? ThinkingStartEvent)
        XCTAssertEqual(thinkingStart.eventType, .thinkingStart)
    }

    func test_decodeThinkingStart_wrongTypeForTimestamp_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "THINKING_START",
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

    func test_thinkingStartEvent_eventTypeIsAlwaysThinkingStart() {
        // Given
        let event = ThinkingStartEvent(title: nil, timestamp: nil, rawEvent: nil)

        // Then
        XCTAssertEqual(event.eventType, .thinkingStart)
    }

    func test_thinkingStartEvent_equatable_sameFields_areEqual() {
        // Given
        let event1 = ThinkingStartEvent(title: "Analyzing", timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = ThinkingStartEvent(title: "Analyzing", timestamp: EventTestData.timestamp, rawEvent: nil)

        // Then
        XCTAssertEqual(event1, event2)
    }

    func test_thinkingStartEvent_equatable_differentTitles_areNotEqual() {
        // Given
        let event1 = ThinkingStartEvent(title: "Analyzing", timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = ThinkingStartEvent(title: "Planning", timestamp: EventTestData.timestamp, rawEvent: nil)

        // Then
        XCTAssertNotEqual(event1, event2)
    }

    func test_thinkingStartEvent_equatable_differentTimestamps_areNotEqual() {
        // Given
        let event1 = ThinkingStartEvent(title: "Analyzing", timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = ThinkingStartEvent(title: "Analyzing", timestamp: EventTestData.timestamp2, rawEvent: nil)

        // Then
        XCTAssertNotEqual(event1, event2)
    }

    func test_thinkingStartEvent_equatable_oneWithTimestampOneWithout_areNotEqual() {
        // Given
        let event1 = ThinkingStartEvent(title: "Analyzing", timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = ThinkingStartEvent(title: "Analyzing", timestamp: nil, rawEvent: nil)

        // Then
        XCTAssertNotEqual(event1, event2)
    }

    func test_thinkingStartEvent_description_containsKeyInformation() {
        // Given
        let event = ThinkingStartEvent(title: "Analyzing", timestamp: EventTestData.timestamp, rawEvent: nil)

        // Then
        let description = event.description
        XCTAssertTrue(description.contains("ThinkingStartEvent"))
        XCTAssertTrue(description.contains("title"))
        XCTAssertTrue(description.contains("timestamp"))
    }

    func test_thinkingStartEvent_debugDescription_containsDetailedInformation() {
        // Given
        let event = ThinkingStartEvent(title: "Analyzing", timestamp: EventTestData.timestamp, rawEvent: nil)

        // Then
        let debugDescription = event.debugDescription
        XCTAssertTrue(debugDescription.contains("ThinkingStartEvent"))
        XCTAssertTrue(debugDescription.contains("title"))
        XCTAssertTrue(debugDescription.contains("timestamp"))
        XCTAssertTrue(debugDescription.contains("eventType"))
    }
}
