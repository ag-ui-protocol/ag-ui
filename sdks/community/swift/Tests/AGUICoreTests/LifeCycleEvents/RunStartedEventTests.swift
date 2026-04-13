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

final class RunStartedEventTests: XCTestCase,
                                   AGUIEventDecoderTestHelpers,
                                   EventDecodingErrorTests {

    // MARK: - EventDecodingErrorTests Protocol Requirements

    var validEventFieldsWithoutType: [String: Any] {
        [
            "threadId": EventTestData.threadId,
            "runId": EventTestData.runId
        ]
    }

    var eventTypeString: String { "RUN_STARTED" }
    var expectedEventType: EventType { .runStarted }
    var unknownEventTypeString: String { "RUN_PAUSED" }

    // MARK: - Feature: Decode RUN_STARTED

    func test_decodeValidRunStarted_returnsRunStartedEvent() throws {
        // Given
        let data = jsonData("""
        {
          "type": "RUN_STARTED",
          "threadId": "\(EventTestData.threadId)",
          "runId": "\(EventTestData.runId)"
        }
        """)

        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        guard let runStarted = event as? RunStartedEvent else {
            return XCTFail("Expected RunStartedEvent, got \(type(of: event))")
        }
        XCTAssertEqual(runStarted.eventType, .runStarted)
        XCTAssertEqual(runStarted.threadId, EventTestData.threadId)
        XCTAssertEqual(runStarted.runId, EventTestData.runId)
        XCTAssertNil(runStarted.timestamp)
    }

    func test_decodeRunStarted_withTimestamp_populatesTimestamp() throws {
        // Given
        let data = jsonData("""
        {
          "type": "RUN_STARTED",
          "threadId": "\(EventTestData.threadId)",
          "runId": "\(EventTestData.runId)",
          "timestamp": \(EventTestData.timestamp)
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let runStarted = try XCTUnwrap(event as? RunStartedEvent)
        XCTAssertEqual(runStarted.timestamp, EventTestData.timestamp)
    }

    func test_decodeRunStarted_preservesRawEventBytes() throws {
        // Given
        let data = jsonData("""
        {
          "type": "RUN_STARTED",
          "threadId": "\(EventTestData.threadId)",
          "runId": "\(EventTestData.runId)",
          "timestamp": \(EventTestData.timestamp)
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let runStarted = try XCTUnwrap(event as? RunStartedEvent)
        XCTAssertEqual(runStarted.rawEvent, data)
    }

    func test_decodeRunStarted_ignoresUnknownExtraFields() throws {
        // Given
        let data = jsonData("""
        {
          "type": "RUN_STARTED",
          "threadId": "\(EventTestData.threadId)",
          "runId": "\(EventTestData.runId)",
          "extraField": "ignored",
          "nested": { "x": 1 }
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let runStarted = try XCTUnwrap(event as? RunStartedEvent)
        XCTAssertEqual(runStarted.threadId, EventTestData.threadId)
        XCTAssertEqual(runStarted.runId, EventTestData.runId)
    }

    // MARK: - Feature: Error handling (event-specific)

    func test_decodeRunStarted_missingThreadId_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "RUN_STARTED",
          "runId": "run-456"
        }
        """)
        let decoder = makeStrictDecoder()

        // When / Then
        XCTAssertThrowsError(try decoder.decode(data)) { error in
            guard case .decodingFailed(let message) = (error as? EventDecodingError) else {
                return XCTFail("Expected .decodingFailed, got \(error)")
            }
            XCTAssertTrue(message.contains("threadId"), "Expected message to mention 'threadId'. Got: \(message)")
        }
    }

    func test_decodeRunStarted_threadIdWrongType_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "RUN_STARTED",
          "threadId": 123,
          "runId": "run-456"
        }
        """)
        let decoder = makeStrictDecoder()

        // When / Then
        XCTAssertThrowsError(try decoder.decode(data)) { error in
            guard case .decodingFailed(let message) = (error as? EventDecodingError) else {
                return XCTFail("Expected .decodingFailed, got \(error)")
            }
            XCTAssertTrue(message.lowercased().contains("type mismatch") || message.contains("Type mismatch"),
                          "Expected a type mismatch message. Got: \(message)")
        }
    }

    // MARK: - Feature: Model behaviors

    func test_runStartedEvent_eventTypeIsAlwaysRunStarted() {
        // Given
        let event = RunStartedEvent(threadId: "t", runId: "r", timestamp: nil, rawEvent: nil)

        // Then
        XCTAssertEqual(event.eventType, .runStarted)
    }

    func test_runStartedEvent_equatable_sameFields_areEqual() {
        // Given
        let event1 = RunStartedEvent(threadId: "t", runId: "r", timestamp: 1, rawEvent: nil)
        let event2 = RunStartedEvent(threadId: "t", runId: "r", timestamp: 1, rawEvent: nil)

        // Then
        XCTAssertEqual(event1, event2)
    }
}
