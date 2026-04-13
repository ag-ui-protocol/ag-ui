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

final class RunErrorEventTests: XCTestCase,
                                 AGUIEventDecoderTestHelpers,
                                 EventDecodingErrorTests {

    // MARK: - EventDecodingErrorTests Protocol Requirements

    var validEventFieldsWithoutType: [String: Any] {
        [
            "threadId": EventTestData.threadId,
            "runId": EventTestData.runId,
            "error": [
                "code": "ERROR_CODE",
                "message": "An error occurred"
            ]
        ]
    }

    var eventTypeString: String { "RUN_ERROR" }
    var expectedEventType: EventType { .runError }
    var unknownEventTypeString: String { "RUN_CANCELLED" }

    // MARK: - Feature: Decode RUN_ERROR

    func test_decodeValidRunError_returnsRunErrorEvent() throws {
        // Given
        let data = jsonData("""
        {
          "type": "RUN_ERROR",
          "threadId": "\(EventTestData.threadId)",
          "runId": "\(EventTestData.runId)",
          "error": {
            "code": "ERROR_CODE",
            "message": "An error occurred"
          }
        }
        """)

        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        guard let runError = event as? RunErrorEvent else {
            return XCTFail("Expected RunErrorEvent, got \(type(of: event))")
        }
        XCTAssertEqual(runError.eventType, .runError)
        XCTAssertEqual(runError.threadId, EventTestData.threadId)
        XCTAssertEqual(runError.runId, EventTestData.runId)
        XCTAssertEqual(runError.error.code, "ERROR_CODE")
        XCTAssertEqual(runError.error.message, "An error occurred")
        XCTAssertNil(runError.error.details)
        XCTAssertNil(runError.timestamp)
    }

    func test_decodeRunError_withTimestamp_populatesTimestamp() throws {
        // Given
        let data = jsonData("""
        {
          "type": "RUN_ERROR",
          "threadId": "\(EventTestData.threadId)",
          "runId": "\(EventTestData.runId)",
          "error": {
            "code": "ERROR_CODE",
            "message": "An error occurred"
          },
          "timestamp": \(EventTestData.timestamp)
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let runError = try XCTUnwrap(event as? RunErrorEvent)
        XCTAssertEqual(runError.timestamp, EventTestData.timestamp)
    }

    func test_decodeRunError_withErrorDetails_populatesDetails() throws {
        // Given
        let data = jsonData("""
        {
          "type": "RUN_ERROR",
          "threadId": "\(EventTestData.threadId)",
          "runId": "\(EventTestData.runId)",
          "error": {
            "code": "ERROR_CODE_123",
            "message": "An error occurred",
            "details": {
              "key": "value",
              "another": "detail"
            }
          }
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let runError = try XCTUnwrap(event as? RunErrorEvent)
        XCTAssertEqual(runError.error.details?["key"], "value")
        XCTAssertEqual(runError.error.details?["another"], "detail")
    }

    func test_decodeRunError_preservesRawEventBytes() throws {
        // Given
        let data = jsonData("""
        {
          "type": "RUN_ERROR",
          "threadId": "\(EventTestData.threadId)",
          "runId": "\(EventTestData.runId)",
          "error": {
            "code": "ERROR_CODE",
            "message": "An error occurred"
          },
          "timestamp": \(EventTestData.timestamp)
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let runError = try XCTUnwrap(event as? RunErrorEvent)
        XCTAssertEqual(runError.rawEvent, data)
    }

    func test_decodeRunError_ignoresUnknownExtraFields() throws {
        // Given
        let data = jsonData("""
        {
          "type": "RUN_ERROR",
          "threadId": "\(EventTestData.threadId)",
          "runId": "\(EventTestData.runId)",
          "error": {
            "code": "ERROR_CODE",
            "message": "An error occurred"
          },
          "extraField": "ignored",
          "nested": { "x": 1 }
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let runError = try XCTUnwrap(event as? RunErrorEvent)
        XCTAssertEqual(runError.threadId, EventTestData.threadId)
        XCTAssertEqual(runError.runId, EventTestData.runId)
        XCTAssertEqual(runError.error.code, "ERROR_CODE")
    }

    // MARK: - Feature: Error handling (event-specific)

    func test_decodeRunError_missingThreadId_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "RUN_ERROR",
          "runId": "run-456",
          "error": {
            "code": "ERROR_CODE",
            "message": "An error occurred"
          }
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

    func test_decodeRunError_missingError_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "RUN_ERROR",
          "threadId": "thread-123",
          "runId": "run-456"
        }
        """)
        let decoder = makeStrictDecoder()

        // When / Then
        XCTAssertThrowsError(try decoder.decode(data)) { error in
            guard case .decodingFailed(let message) = (error as? EventDecodingError) else {
                return XCTFail("Expected .decodingFailed, got \(error)")
            }
            XCTAssertTrue(message.contains("error"), "Expected message to mention 'error'. Got: \(message)")
        }
    }

    func test_decodeRunError_missingErrorCode_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "RUN_ERROR",
          "threadId": "thread-123",
          "runId": "run-456",
          "error": {
            "message": "An error occurred"
          }
        }
        """)
        let decoder = makeStrictDecoder()

        // When / Then
        XCTAssertThrowsError(try decoder.decode(data)) { error in
            guard case .decodingFailed(let message) = (error as? EventDecodingError) else {
                return XCTFail("Expected .decodingFailed, got \(error)")
            }
            XCTAssertTrue(message.contains("code"), "Expected message to mention 'code'. Got: \(message)")
        }
    }

    func test_decodeRunError_threadIdWrongType_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "RUN_ERROR",
          "threadId": 123,
          "runId": "run-456",
          "error": {
            "code": "ERROR_CODE",
            "message": "An error occurred"
          }
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

    func test_decodeRunError_errorWrongType_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "RUN_ERROR",
          "threadId": "thread-123",
          "runId": "run-456",
          "error": "not an object"
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

    func test_runErrorEvent_eventTypeIsAlwaysRunError() {
        // Given
        let error = RunErrorEvent.ErrorInfo(code: "CODE", message: "Message")
        let event = RunErrorEvent(threadId: "t", runId: "r", error: error, timestamp: nil, rawEvent: nil)

        // Then
        XCTAssertEqual(event.eventType, .runError)
    }

    func test_runErrorEvent_equatable_sameFields_areEqual() {
        // Given
        let error = RunErrorEvent.ErrorInfo(code: "CODE", message: "Message", details: ["key": "value"])
        let event1 = RunErrorEvent(threadId: "t", runId: "r", error: error, timestamp: 1, rawEvent: nil)
        let event2 = RunErrorEvent(threadId: "t", runId: "r", error: error, timestamp: 1, rawEvent: nil)

        // Then
        XCTAssertEqual(event1, event2)
    }

    func test_runErrorEvent_errorInfo_equatable_sameFields_areEqual() {
        // Given
        let errorInfo1 = RunErrorEvent.ErrorInfo(code: "CODE", message: "Message", details: ["key": "value"])
        let errorInfo2 = RunErrorEvent.ErrorInfo(code: "CODE", message: "Message", details: ["key": "value"])

        // Then
        XCTAssertEqual(errorInfo1, errorInfo2)
    }
}
