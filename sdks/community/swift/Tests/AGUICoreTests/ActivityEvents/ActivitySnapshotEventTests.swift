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

final class ActivitySnapshotEventTests: XCTestCase,
                                        AGUIEventDecoderTestHelpers,
                                        EventDecodingErrorTests {

    // MARK: - EventDecodingErrorTests Protocol Requirements

    var validEventFieldsWithoutType: [String: Any] {
        [
            "messageId": EventTestData.messageId,
            "activityType": "a2ui-surface",
            "content": ["key": "value"]
        ]
    }

    var eventTypeString: String { "ACTIVITY_SNAPSHOT" }
    var expectedEventType: EventType { .activitySnapshot }
    var unknownEventTypeString: String { "ACTIVITY_PAUSED" }

    // MARK: - Feature: Decode ACTIVITY_SNAPSHOT

    func test_decodeValidActivitySnapshot_returnsActivitySnapshotEvent() throws {
        // Given
        let content = ["key": "value"]
        let contentData = try JSONSerialization.data(withJSONObject: content, options: [])
        
        let data = jsonData("""
        {
          "type": "ACTIVITY_SNAPSHOT",
          "messageId": "\(EventTestData.messageId)",
          "activityType": "a2ui-surface",
          "content": {"key": "value"}
        }
        """)

        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        guard let snapshot = event as? ActivitySnapshotEvent else {
            return XCTFail("Expected ActivitySnapshotEvent, got \(type(of: event))")
        }
        XCTAssertEqual(snapshot.eventType, .activitySnapshot)
        XCTAssertEqual(snapshot.messageId, EventTestData.messageId)
        XCTAssertEqual(snapshot.activityType, "a2ui-surface")
        XCTAssertEqual(snapshot.content, contentData)
        XCTAssertEqual(snapshot.replace, true) // Default value
        XCTAssertNil(snapshot.timestamp)
    }

    func test_decodeActivitySnapshotWithReplaceFalse_returnsActivitySnapshotEvent() throws {
        // Given
        let data = jsonData("""
        {
          "type": "ACTIVITY_SNAPSHOT",
          "messageId": "\(EventTestData.messageId)",
          "activityType": "a2ui-surface",
          "content": {"key": "value"},
          "replace": false
        }
        """)

        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        guard let snapshot = event as? ActivitySnapshotEvent else {
            return XCTFail("Expected ActivitySnapshotEvent, got \(type(of: event))")
        }
        XCTAssertEqual(snapshot.replace, false)
    }

    func test_decodeActivitySnapshotWithTimestamp_returnsActivitySnapshotEvent() throws {
        // Given
        let data = jsonData("""
        {
          "type": "ACTIVITY_SNAPSHOT",
          "messageId": "\(EventTestData.messageId)",
          "activityType": "a2ui-surface",
          "content": {"key": "value"},
          "timestamp": \(EventTestData.timestamp)
        }
        """)

        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        guard let snapshot = event as? ActivitySnapshotEvent else {
            return XCTFail("Expected ActivitySnapshotEvent, got \(type(of: event))")
        }
        XCTAssertEqual(snapshot.timestamp, EventTestData.timestamp)
    }

    func test_activitySnapshotEvent_eventTypeIsAlwaysActivitySnapshot() throws {
        // Given
        let content = try JSONSerialization.data(withJSONObject: ["key": "value"], options: [])
        let event = ActivitySnapshotEvent(
            messageId: EventTestData.messageId,
            activityType: "a2ui-surface",
            content: content
        )

        // Then
        XCTAssertEqual(event.eventType, .activitySnapshot)
    }

    func test_activitySnapshotEvent_parsedContent_returnsParsedJSON() throws {
        // Given
        let content: [String: Any] = ["key": "value", "number": 42]
        let contentData = try JSONSerialization.data(withJSONObject: content, options: [])
        let event = ActivitySnapshotEvent(
            messageId: EventTestData.messageId,
            activityType: "a2ui-surface",
            content: contentData
        )

        // When
        let parsed = try event.parsedContent() as? [String: Any]

        // Then
        XCTAssertNotNil(parsed)
        XCTAssertEqual(parsed?["key"] as? String, "value")
        XCTAssertEqual(parsed?["number"] as? Int, 42)
    }

    // MARK: - Equatable Tests

    func test_activitySnapshotEvent_equatable_sameFields_areEqual() throws {
        // Given
        let content = try JSONSerialization.data(withJSONObject: ["key": "value"], options: [])
        let event1 = ActivitySnapshotEvent(
            messageId: EventTestData.messageId,
            activityType: "a2ui-surface",
            content: content,
            replace: true,
            timestamp: EventTestData.timestamp,
            rawEvent: nil
        )
        let event2 = ActivitySnapshotEvent(
            messageId: EventTestData.messageId,
            activityType: "a2ui-surface",
            content: content,
            replace: true,
            timestamp: EventTestData.timestamp,
            rawEvent: nil
        )

        // Then
        XCTAssertEqual(event1, event2)
    }

    func test_activitySnapshotEvent_equatable_differentMessageIds_areNotEqual() throws {
        // Given
        let content = try JSONSerialization.data(withJSONObject: ["key": "value"], options: [])
        let event1 = ActivitySnapshotEvent(
            messageId: EventTestData.messageId,
            activityType: "a2ui-surface",
            content: content
        )
        let event2 = ActivitySnapshotEvent(
            messageId: EventTestData.messageId2,
            activityType: "a2ui-surface",
            content: content
        )

        // Then
        XCTAssertNotEqual(event1, event2)
    }

    func test_activitySnapshotEvent_equatable_differentActivityTypes_areNotEqual() throws {
        // Given
        let content = try JSONSerialization.data(withJSONObject: ["key": "value"], options: [])
        let event1 = ActivitySnapshotEvent(
            messageId: EventTestData.messageId,
            activityType: "a2ui-surface",
            content: content
        )
        let event2 = ActivitySnapshotEvent(
            messageId: EventTestData.messageId,
            activityType: "other-type",
            content: content
        )

        // Then
        XCTAssertNotEqual(event1, event2)
    }

    func test_activitySnapshotEvent_equatable_differentReplaceValues_areNotEqual() throws {
        // Given
        let content = try JSONSerialization.data(withJSONObject: ["key": "value"], options: [])
        let event1 = ActivitySnapshotEvent(
            messageId: EventTestData.messageId,
            activityType: "a2ui-surface",
            content: content,
            replace: true
        )
        let event2 = ActivitySnapshotEvent(
            messageId: EventTestData.messageId,
            activityType: "a2ui-surface",
            content: content,
            replace: false
        )

        // Then
        XCTAssertNotEqual(event1, event2)
    }
}
