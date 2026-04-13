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

final class ActivityDeltaEventTests: XCTestCase,
                                     AGUIEventDecoderTestHelpers,
                                     EventDecodingErrorTests {

    // MARK: - EventDecodingErrorTests Protocol Requirements

    var validEventFieldsWithoutType: [String: Any] {
        [
            "messageId": EventTestData.messageId,
            "activityType": "a2ui-surface",
            "patch": [["op": "add", "path": "/foo", "value": "bar"]]
        ]
    }

    var eventTypeString: String { "ACTIVITY_DELTA" }
    var expectedEventType: EventType { .activityDelta }
    var unknownEventTypeString: String { "ACTIVITY_PAUSED" }

    // MARK: - Feature: Decode ACTIVITY_DELTA

    func test_decodeValidActivityDelta_returnsActivityDeltaEvent() throws {
        // Given
        let data = jsonData("""
        {
          "type": "ACTIVITY_DELTA",
          "messageId": "\(EventTestData.messageId)",
          "activityType": "a2ui-surface",
          "patch": [{"op": "add", "path": "/foo", "value": "bar"}]
        }
        """)

        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        guard let delta = event as? ActivityDeltaEvent else {
            return XCTFail("Expected ActivityDeltaEvent, got \(type(of: event))")
        }
        XCTAssertEqual(delta.eventType, .activityDelta)
        XCTAssertEqual(delta.messageId, EventTestData.messageId)
        XCTAssertEqual(delta.activityType, "a2ui-surface")
        // Compare parsed patch content instead of raw Data (JSON serialization may differ)
        let parsedPatch = try delta.parsedPatch() as? [[String: Any]]
        XCTAssertNotNil(parsedPatch)
        XCTAssertEqual(parsedPatch?.count, 1)
        XCTAssertEqual(parsedPatch?.first?["op"] as? String, "add")
        XCTAssertEqual(parsedPatch?.first?["path"] as? String, "/foo")
        XCTAssertEqual(parsedPatch?.first?["value"] as? String, "bar")
        XCTAssertNil(delta.timestamp)
    }

    func test_decodeActivityDeltaWithTimestamp_returnsActivityDeltaEvent() throws {
        // Given
        let data = jsonData("""
        {
          "type": "ACTIVITY_DELTA",
          "messageId": "\(EventTestData.messageId)",
          "activityType": "a2ui-surface",
          "patch": [{"op": "add", "path": "/foo", "value": "bar"}],
          "timestamp": \(EventTestData.timestamp)
        }
        """)

        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        guard let delta = event as? ActivityDeltaEvent else {
            return XCTFail("Expected ActivityDeltaEvent, got \(type(of: event))")
        }
        XCTAssertEqual(delta.timestamp, EventTestData.timestamp)
    }

    func test_activityDeltaEvent_eventTypeIsAlwaysActivityDelta() throws {
        // Given
        let patch = try JSONSerialization.data(withJSONObject: [["op": "add", "path": "/foo", "value": "bar"]], options: [])
        let event = ActivityDeltaEvent(
            messageId: EventTestData.messageId,
            activityType: "a2ui-surface",
            patch: patch
        )

        // Then
        XCTAssertEqual(event.eventType, .activityDelta)
    }

    func test_activityDeltaEvent_parsedPatch_returnsParsedArray() throws {
        // Given
        let patch = [["op": "add", "path": "/foo", "value": "bar"]]
        let patchData = try JSONSerialization.data(withJSONObject: patch, options: [])
        let event = ActivityDeltaEvent(
            messageId: EventTestData.messageId,
            activityType: "a2ui-surface",
            patch: patchData
        )

        // When
        let parsed = try event.parsedPatch() as? [[String: Any]]

        // Then
        XCTAssertNotNil(parsed)
        XCTAssertEqual(parsed?.count, 1)
        XCTAssertEqual(parsed?.first?["op"] as? String, "add")
        XCTAssertEqual(parsed?.first?["path"] as? String, "/foo")
    }

    // MARK: - Equatable Tests

    func test_activityDeltaEvent_equatable_sameFields_areEqual() throws {
        // Given
        let patch = try JSONSerialization.data(withJSONObject: [["op": "add", "path": "/foo", "value": "bar"]], options: [])
        let event1 = ActivityDeltaEvent(
            messageId: EventTestData.messageId,
            activityType: "a2ui-surface",
            patch: patch,
            timestamp: EventTestData.timestamp,
            rawEvent: nil
        )
        let event2 = ActivityDeltaEvent(
            messageId: EventTestData.messageId,
            activityType: "a2ui-surface",
            patch: patch,
            timestamp: EventTestData.timestamp,
            rawEvent: nil
        )

        // Then
        XCTAssertEqual(event1, event2)
    }

    func test_activityDeltaEvent_equatable_differentMessageIds_areNotEqual() throws {
        // Given
        let patch = try JSONSerialization.data(withJSONObject: [["op": "add", "path": "/foo", "value": "bar"]], options: [])
        let event1 = ActivityDeltaEvent(
            messageId: EventTestData.messageId,
            activityType: "a2ui-surface",
            patch: patch
        )
        let event2 = ActivityDeltaEvent(
            messageId: EventTestData.messageId2,
            activityType: "a2ui-surface",
            patch: patch
        )

        // Then
        XCTAssertNotEqual(event1, event2)
    }

    func test_activityDeltaEvent_equatable_differentPatches_areNotEqual() throws {
        // Given
        let patch1 = try JSONSerialization.data(withJSONObject: [["op": "add", "path": "/foo", "value": "bar"]], options: [])
        let patch2 = try JSONSerialization.data(withJSONObject: [["op": "remove", "path": "/foo"]], options: [])
        let event1 = ActivityDeltaEvent(
            messageId: EventTestData.messageId,
            activityType: "a2ui-surface",
            patch: patch1
        )
        let event2 = ActivityDeltaEvent(
            messageId: EventTestData.messageId,
            activityType: "a2ui-surface",
            patch: patch2
        )

        // Then
        XCTAssertNotEqual(event1, event2)
    }
}
