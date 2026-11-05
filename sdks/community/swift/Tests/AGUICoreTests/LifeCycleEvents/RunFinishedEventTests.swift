// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUICore

final class RunFinishedEventTests: XCTestCase,
                                    AGUIEventDecoderTestHelpers,
                                    EventDecodingErrorTests {

    // MARK: - EventDecodingErrorTests Protocol Requirements

    var validEventFieldsWithoutType: [String: Any] {
        [
            "threadId": EventTestData.threadId,
            "runId": EventTestData.runId
        ]
    }

    var eventTypeString: String { "RUN_FINISHED" }
    var expectedEventType: EventType { .runFinished }
    var unknownEventTypeString: String { "RUN_PAUSED" }

    // MARK: - Feature: Decode RUN_FINISHED

    func test_decodeValidRunFinished_returnsRunFinishedEvent() throws {
        // Given
        let data = jsonData("""
        {
          "type": "RUN_FINISHED",
          "threadId": "\(EventTestData.threadId)",
          "runId": "\(EventTestData.runId)"
        }
        """)

        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        guard let runFinished = event as? RunFinishedEvent else {
            return XCTFail("Expected RunFinishedEvent, got \(type(of: event))")
        }
        XCTAssertEqual(runFinished.eventType, .runFinished)
        XCTAssertEqual(runFinished.threadId, EventTestData.threadId)
        XCTAssertEqual(runFinished.runId, EventTestData.runId)
        XCTAssertNil(runFinished.timestamp)
    }

    func test_decodeRunFinished_withTimestamp_populatesTimestamp() throws {
        // Given
        let data = jsonData("""
        {
          "type": "RUN_FINISHED",
          "threadId": "\(EventTestData.threadId)",
          "runId": "\(EventTestData.runId)",
          "timestamp": \(EventTestData.timestamp)
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let runFinished = try XCTUnwrap(event as? RunFinishedEvent)
        XCTAssertEqual(runFinished.timestamp, EventTestData.timestamp)
    }

    func test_decodeRunFinished_preservesRawEventBytes() throws {
        // Given
        let data = jsonData("""
        {
          "type": "RUN_FINISHED",
          "threadId": "\(EventTestData.threadId)",
          "runId": "\(EventTestData.runId)",
          "timestamp": \(EventTestData.timestamp)
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let runFinished = try XCTUnwrap(event as? RunFinishedEvent)
        XCTAssertEqual(runFinished.rawEvent, data)
    }

    func test_decodeRunFinished_ignoresUnknownExtraFields() throws {
        // Given
        let data = jsonData("""
        {
          "type": "RUN_FINISHED",
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
        let runFinished = try XCTUnwrap(event as? RunFinishedEvent)
        XCTAssertEqual(runFinished.threadId, EventTestData.threadId)
        XCTAssertEqual(runFinished.runId, EventTestData.runId)
    }

    // MARK: - Feature: Decode result field

    // Regression: scalar result values (number, string, bool) previously raised an
    // uncaught NSException because JSONSerialization.data(withJSONObject:) rejects
    // non-collection top-level values and NSException bypasses try?.

    func test_decodeRunFinished_withNumericResult_doesNotCrash() throws {
        // Given: "result": 42 — the exact case reported in the PR review
        let data = jsonData("""
        {
          "type": "RUN_FINISHED",
          "threadId": "\(EventTestData.threadId)",
          "runId": "\(EventTestData.runId)",
          "result": 42
        }
        """)
        let decoder = makeStrictDecoder()

        // When / Then: must not crash
        let event = try decoder.decode(data)
        let runFinished = try XCTUnwrap(event as? RunFinishedEvent)
        XCTAssertNotNil(runFinished.result, "Numeric result should be preserved as Data")
    }

    func test_decodeRunFinished_withStringResult_doesNotCrash() throws {
        let data = jsonData("""
        {
          "type": "RUN_FINISHED",
          "threadId": "\(EventTestData.threadId)",
          "runId": "\(EventTestData.runId)",
          "result": "ok"
        }
        """)
        let event = try makeStrictDecoder().decode(data)
        let runFinished = try XCTUnwrap(event as? RunFinishedEvent)
        XCTAssertNotNil(runFinished.result)
    }

    func test_decodeRunFinished_withBoolResult_doesNotCrash() throws {
        let data = jsonData("""
        {
          "type": "RUN_FINISHED",
          "threadId": "\(EventTestData.threadId)",
          "runId": "\(EventTestData.runId)",
          "result": true
        }
        """)
        let event = try makeStrictDecoder().decode(data)
        let runFinished = try XCTUnwrap(event as? RunFinishedEvent)
        XCTAssertNotNil(runFinished.result)
    }

    func test_decodeRunFinished_withNullResult_treatedAsAbsent() throws {
        let data = jsonData("""
        {
          "type": "RUN_FINISHED",
          "threadId": "\(EventTestData.threadId)",
          "runId": "\(EventTestData.runId)",
          "result": null
        }
        """)
        let event = try makeStrictDecoder().decode(data)
        let runFinished = try XCTUnwrap(event as? RunFinishedEvent)
        XCTAssertNil(runFinished.result, "null result should be treated as absent")
    }

    func test_decodeRunFinished_withObjectResult_decodesSuccessfully() throws {
        let data = jsonData("""
        {
          "type": "RUN_FINISHED",
          "threadId": "\(EventTestData.threadId)",
          "runId": "\(EventTestData.runId)",
          "result": { "status": "done", "count": 3 }
        }
        """)
        let event = try makeStrictDecoder().decode(data)
        let runFinished = try XCTUnwrap(event as? RunFinishedEvent)
        XCTAssertNotNil(runFinished.result)
    }

    func test_decodeRunFinished_withArrayResult_decodesSuccessfully() throws {
        let data = jsonData("""
        {
          "type": "RUN_FINISHED",
          "threadId": "\(EventTestData.threadId)",
          "runId": "\(EventTestData.runId)",
          "result": [1, 2, 3]
        }
        """)
        let event = try makeStrictDecoder().decode(data)
        let runFinished = try XCTUnwrap(event as? RunFinishedEvent)
        XCTAssertNotNil(runFinished.result)
    }

    func test_decodeRunFinished_withAbsentResult_isNil() throws {
        let data = jsonData("""
        {
          "type": "RUN_FINISHED",
          "threadId": "\(EventTestData.threadId)",
          "runId": "\(EventTestData.runId)"
        }
        """)
        let event = try makeStrictDecoder().decode(data)
        let runFinished = try XCTUnwrap(event as? RunFinishedEvent)
        XCTAssertNil(runFinished.result)
    }

    // MARK: - Feature: Error handling (event-specific)

    func test_decodeRunFinished_missingThreadId_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "RUN_FINISHED",
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

    func test_decodeRunFinished_threadIdWrongType_throwsDecodingFailed() {
        // Given
        let data = jsonData("""
        {
          "type": "RUN_FINISHED",
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

    // MARK: - Feature: Decode outcome field

    // The AG-UI 1.0 outcome field is a discriminated-union object keyed on "type":
    // { "type": "success" | "cancelled" | "interrupt", "interrupts"?: [...] }

    func test_decodeRunFinished_withOutcomeSuccess_populatesSuccess() throws {
        // Given
        let data = jsonData("""
        {
          "type": "RUN_FINISHED",
          "threadId": "\(EventTestData.threadId)",
          "runId": "\(EventTestData.runId)",
          "outcome": { "type": "success" }
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let runFinished = try XCTUnwrap(event as? RunFinishedEvent)
        XCTAssertEqual(runFinished.outcome, .success)
    }

    func test_decodeRunFinished_withOutcomeCancelled_populatesCancelled() throws {
        // Given
        let data = jsonData("""
        {
          "type": "RUN_FINISHED",
          "threadId": "\(EventTestData.threadId)",
          "runId": "\(EventTestData.runId)",
          "outcome": { "type": "cancelled" }
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let runFinished = try XCTUnwrap(event as? RunFinishedEvent)
        XCTAssertEqual(runFinished.outcome, .cancelled)
    }

    func test_decodeRunFinished_withOutcomeInterrupt_populatesInterrupt() throws {
        // Given – interrupt with an inline interrupts array
        let data = jsonData("""
        {
          "type": "RUN_FINISHED",
          "threadId": "\(EventTestData.threadId)",
          "runId": "\(EventTestData.runId)",
          "outcome": { "type": "interrupt", "interrupts": [] }
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let runFinished = try XCTUnwrap(event as? RunFinishedEvent)
        if case .interrupt(let interrupts) = runFinished.outcome {
            XCTAssertTrue(interrupts.isEmpty)
        } else {
            XCTFail("Expected .interrupt, got \(String(describing: runFinished.outcome))")
        }
    }

    func test_decodeRunFinished_missingOutcome_defaultsToSuccess() throws {
        // Given – no "outcome" key in JSON; legacy producers omit it
        let data = jsonData("""
        {
          "type": "RUN_FINISHED",
          "threadId": "\(EventTestData.threadId)",
          "runId": "\(EventTestData.runId)"
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then: DTO falls back to .success for missing outcome
        let runFinished = try XCTUnwrap(event as? RunFinishedEvent)
        XCTAssertEqual(runFinished.outcome, .success)
    }

    func test_decodeRunFinished_unknownOutcomeType_defaultsToSuccess() throws {
        // Given – unknown "type" string inside the outcome object; forward-compat fallback
        let data = jsonData("""
        {
          "type": "RUN_FINISHED",
          "threadId": "\(EventTestData.threadId)",
          "runId": "\(EventTestData.runId)",
          "outcome": { "type": "paused" }
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        let runFinished = try XCTUnwrap(event as? RunFinishedEvent)
        XCTAssertEqual(runFinished.outcome, .success)
    }

    func test_decodeRunFinished_outcomePlainString_defaultsToSuccess() throws {
        // Given – legacy plain-string outcome (e.g. "success"); DTO expects an object
        // so plain strings fall through to the .success default.
        let data = jsonData("""
        {
          "type": "RUN_FINISHED",
          "threadId": "\(EventTestData.threadId)",
          "runId": "\(EventTestData.runId)",
          "outcome": "success"
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then: non-object outcome falls back to .success
        let runFinished = try XCTUnwrap(event as? RunFinishedEvent)
        XCTAssertEqual(runFinished.outcome, .success)
    }

    // MARK: - Feature: Model behaviors

    func test_runFinishedEvent_eventTypeIsAlwaysRunFinished() {
        // Given
        let event = RunFinishedEvent(threadId: "t", runId: "r", timestamp: nil, rawEvent: nil)

        // Then
        XCTAssertEqual(event.eventType, .runFinished)
    }

    func test_runFinishedEvent_defaultOutcomeIsNil() {
        // Given – outcome defaults to nil (absent/unknown; callers treat as success)
        let event = RunFinishedEvent(threadId: "t", runId: "r")

        // Then
        XCTAssertNil(event.outcome)
    }

    func test_runFinishedEvent_outcomeCanBeSetToSuccess() {
        // Given
        let event = RunFinishedEvent(threadId: "t", runId: "r", outcome: .success)

        // Then
        XCTAssertEqual(event.outcome, .success)
    }

    func test_runFinishedEvent_outcomeCanBeSetToCancelled() {
        // Given
        let event = RunFinishedEvent(threadId: "t", runId: "r", outcome: .cancelled)

        // Then
        XCTAssertEqual(event.outcome, .cancelled)
    }

    func test_runFinishedEvent_equatable_sameFields_areEqual() {
        // Given
        let event1 = RunFinishedEvent(threadId: "t", runId: "r", outcome: .success, timestamp: 1, rawEvent: nil)
        let event2 = RunFinishedEvent(threadId: "t", runId: "r", outcome: .success, timestamp: 1, rawEvent: nil)

        // Then
        XCTAssertEqual(event1, event2)
    }

    func test_runFinishedEvent_equatable_differentOutcome_areNotEqual() {
        // Given
        let event1 = RunFinishedEvent(threadId: "t", runId: "r", outcome: .success)
        let event2 = RunFinishedEvent(threadId: "t", runId: "r", outcome: .cancelled)

        // Then
        XCTAssertNotEqual(event1, event2)
    }
}
