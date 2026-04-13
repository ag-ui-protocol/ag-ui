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

final class TextMessageEndEventTests: XCTestCase,
                                   AGUIEventDecoderTestHelpers,
                                   EventDecodingErrorTests {

    // MARK: - EventDecodingErrorTests Protocol Requirements

    var validEventFieldsWithoutType: [String: Any] {
        ["messageId": EventTestData.messageId]
    }

    var eventTypeString: String { "TEXT_MESSAGE_END" }
    var expectedEventType: EventType { .textMessageEnd }
    var unknownEventTypeString: String { "TEXT_MESSAGE_PAUSED" }

    // MARK: - Feature: Decode TEXT_MESSAGE_END

    func test_decodeValidTextMessageEnd_returnsTextMessageEndEvent() throws {
        // Given
        let data = jsonData("""
        {
          "type": "TEXT_MESSAGE_END",
          "messageId": "\(EventTestData.messageId)"
        }
        """)

        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        guard let textMessageEnd = event as? TextMessageEndEvent else {
            return XCTFail("Expected TextMessageEndEvent, got \(type(of: event))")
        }
        XCTAssertEqual(textMessageEnd.eventType, .textMessageEnd)
        XCTAssertEqual(textMessageEnd.messageId, EventTestData.messageId)
        XCTAssertNil(textMessageEnd.timestamp)
    }

    func test_decodeTextMessageEnd_withTimestamp_populatesTimestamp() throws {
        // Given
        let data = jsonData("""
        {
          "type": "TEXT_MESSAGE_END",
          "messageId": "\(EventTestData.messageId)",
          "timestamp": \(EventTestData.timestamp)
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let textMessageEnd = try XCTUnwrap(event as? TextMessageEndEvent)
        XCTAssertEqual(textMessageEnd.timestamp, EventTestData.timestamp)
    }

    func test_decodeTextMessageEnd_preservesRawEventBytes() throws {
        // Given
        let data = jsonData("""
        {
          "type": "TEXT_MESSAGE_END",
          "messageId": "\(EventTestData.messageId)",
          "timestamp": \(EventTestData.timestamp)
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let textMessageEnd = try XCTUnwrap(event as? TextMessageEndEvent)
        XCTAssertEqual(textMessageEnd.rawEvent, data)
    }

    func test_decodeTextMessageEnd_ignoresUnknownExtraFields() throws {
        // Given
        let data = jsonData("""
        {
          "type": "TEXT_MESSAGE_END",
          "messageId": "\(EventTestData.messageId)",
          "extraField": "ignored",
          "nested": { "x": 1 }
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let textMessageEnd = try XCTUnwrap(event as? TextMessageEndEvent)
        XCTAssertEqual(textMessageEnd.messageId, EventTestData.messageId)
    }

    func test_decodeTextMessageEnd_withUnicodeMessageId_handlesCorrectly() throws {
        // Given
        let data = jsonData("""
        {
          "type": "TEXT_MESSAGE_END",
          "messageId": "msg-🚀-123"
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let textMessageEnd = try XCTUnwrap(event as? TextMessageEndEvent)
        XCTAssertEqual(textMessageEnd.messageId, "msg-🚀-123")
    }

    // MARK: - Feature: Error handling (event-specific)

    func test_decodeTextMessageEnd_missingMessageId_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "TEXT_MESSAGE_END"
        }
        """)
        let decoder = makeStrictDecoder()

        // When / Then
        XCTAssertThrowsError(try decoder.decode(data)) { error in
            guard case .decodingFailed(let message) = error as? EventDecodingError else {
                return XCTFail("Expected decodingFailed, got \(error)")
            }
            XCTAssertTrue(message.contains("messageId") || message.contains("Missing key"))
        }
    }

    func test_decodeTextMessageEnd_wrongTypeForMessageId_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "TEXT_MESSAGE_END",
          "messageId": 123
        }
        """)
        let decoder = makeStrictDecoder()

        // When / Then
        XCTAssertThrowsError(try decoder.decode(data)) { error in
            guard case .decodingFailed(let message) = error as? EventDecodingError else {
                return XCTFail("Expected decodingFailed, got \(error)")
            }
            XCTAssertTrue(message.contains("messageId") || message.contains("Type mismatch"))
        }
    }

    func test_decodeTextMessageEnd_wrongTypeForTimestamp_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "TEXT_MESSAGE_END",
          "messageId": "\(EventTestData.messageId)",
          "timestamp": "invalid"
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

    func test_decodeInvalidJSON_throwsInvalidJSON() {
        // Given
        let data = Data("invalid json".utf8)
        let decoder = makeStrictDecoder()

        // When / Then
        XCTAssertThrowsError(try decoder.decode(data)) { error in
            XCTAssertEqual(error as? EventDecodingError, .invalidJSON)
        }
    }

    // MARK: - Feature: Model behaviors

    func test_textMessageEndEvent_eventTypeIsAlwaysTextMessageEnd() {
        // Given
        let event = TextMessageEndEvent(messageId: EventTestData.messageId, timestamp: nil, rawEvent: nil)

        // Then
        XCTAssertEqual(event.eventType, .textMessageEnd)
    }

    func test_textMessageEndEvent_equatable_sameFields_areEqual() {
        // Given
        let event1 = TextMessageEndEvent(messageId: EventTestData.messageId, timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = TextMessageEndEvent(messageId: EventTestData.messageId, timestamp: EventTestData.timestamp, rawEvent: nil)

        // Then
        XCTAssertEqual(event1, event2)
    }

    func test_textMessageEndEvent_equatable_differentMessageIds_areNotEqual() {
        // Given
        let event1 = TextMessageEndEvent(messageId: EventTestData.messageId, timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = TextMessageEndEvent(messageId: EventTestData.messageId2, timestamp: EventTestData.timestamp, rawEvent: nil)

        // Then
        XCTAssertNotEqual(event1, event2)
    }

    func test_textMessageEndEvent_equatable_differentTimestamps_areNotEqual() {
        // Given
        let event1 = TextMessageEndEvent(messageId: EventTestData.messageId, timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = TextMessageEndEvent(messageId: EventTestData.messageId, timestamp: EventTestData.timestamp2, rawEvent: nil)

        // Then
        XCTAssertNotEqual(event1, event2)
    }

    func test_textMessageEndEvent_equatable_oneNilTimestamp_areNotEqual() {
        // Given
        let event1 = TextMessageEndEvent(messageId: EventTestData.messageId, timestamp: EventTestData.timestamp, rawEvent: nil)
        let event2 = TextMessageEndEvent(messageId: EventTestData.messageId, timestamp: nil, rawEvent: nil)

        // Then
        XCTAssertNotEqual(event1, event2)
    }

    func test_textMessageEndEvent_equatable_bothNilTimestamps_areEqual() {
        // Given
        let event1 = TextMessageEndEvent(messageId: EventTestData.messageId, timestamp: nil, rawEvent: nil)
        let event2 = TextMessageEndEvent(messageId: EventTestData.messageId, timestamp: nil, rawEvent: nil)

        // Then
        XCTAssertEqual(event1, event2)
    }

    func test_textMessageEndEvent_withEmptyMessageId_isValid() {
        // Given
        let event = TextMessageEndEvent(messageId: "", timestamp: nil, rawEvent: nil)

        // Then
        XCTAssertEqual(event.messageId, "")
        XCTAssertEqual(event.eventType, .textMessageEnd)
    }

    // MARK: - Helpers

    private func makeStrictDecoder(
        registry: [EventType: AGUIEventDecoder.DecodeHandler]? = nil
    ) -> AGUIEventDecoder {
        var config = AGUIEventDecoder.Configuration()
        config.unknownEventStrategy = .throwError
        return AGUIEventDecoder(
            config: config,
            makeDecoder: { JSONDecoder() },
            registry: registry ?? AGUIEventDecoder.defaultRegistry()
        )
    }

    private func makeTolerantDecoder(
        registry: [EventType: AGUIEventDecoder.DecodeHandler]? = nil
    ) -> AGUIEventDecoder {
        var config = AGUIEventDecoder.Configuration()
        config.unknownEventStrategy = .returnUnknown
        return AGUIEventDecoder(
            config: config,
            makeDecoder: { JSONDecoder() },
            registry: registry ?? AGUIEventDecoder.defaultRegistry()
        )
    }

    private func jsonData(_ json: String) -> Data {
        Data(json.utf8)
    }
}
