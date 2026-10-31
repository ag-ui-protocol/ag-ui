// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUICore

final class UnknownEventTests: XCTestCase, AGUIEventDecoderTestHelpers {

    // MARK: - Feature: EventType.unknown sentinel

    func test_unknownEventType_rawValueIsSentinel() {
        // The sentinel raw value must never appear on the AG-UI wire
        XCTAssertEqual(EventType.unknown.rawValue, "__UNKNOWN__")
    }

    func test_unknownEventType_isNotEqualToRaw() {
        XCTAssertNotEqual(EventType.unknown, EventType.raw)
    }

    func test_unknownEventType_doesNotEqualAnyKnownWireValue() {
        // "__UNKNOWN__" must not collide with any real protocol event type string
        let knownRawValues = EventType.allCases
            .filter { $0 != .unknown }
            .map { $0.rawValue }
        XCTAssertFalse(knownRawValues.contains("__UNKNOWN__"))
    }

    func test_unknownEventType_isInAllCases() {
        XCTAssertTrue(EventType.allCases.contains(.unknown))
    }

    // MARK: - Feature: UnknownEvent.eventType returns .unknown

    func test_unknownEvent_eventTypeIsUnknown() {
        // Given
        let rawData = Data("{\"type\":\"SOME_FUTURE_TYPE\"}".utf8)
        let event = UnknownEvent(typeRaw: "SOME_FUTURE_TYPE", rawEvent: rawData)

        // Then — must return .unknown, NOT .raw
        XCTAssertEqual(event.eventType, .unknown)
    }

    func test_unknownEvent_eventTypeIsNotRaw() {
        // Explicit guard: consumers switching on .raw must not receive UnknownEvent
        let rawData = Data("{\"type\":\"SOME_FUTURE_TYPE\"}".utf8)
        let event = UnknownEvent(typeRaw: "SOME_FUTURE_TYPE", rawEvent: rawData)
        XCTAssertNotEqual(event.eventType, .raw)
    }

    // MARK: - Feature: Decoder distinguishes genuine RAW events from unknown events

    func test_unknownEvent_distinguishableFromRawEvent() throws {
        // Given: a truly unknown event type
        let data = jsonData("""
        {
          "type": "SOME_FUTURE_PROTOCOL_TYPE",
          "someField": "value"
        }
        """)
        let decoder = makeTolerantDecoder()

        // When
        let event = try decoder.decode(data)

        // Then: must be UnknownEvent with .unknown, not confused with .raw
        guard let unknownEvent = event as? UnknownEvent else {
            return XCTFail("Expected UnknownEvent, got \(type(of: event))")
        }
        XCTAssertEqual(unknownEvent.eventType, .unknown)
        XCTAssertNotEqual(unknownEvent.eventType, .raw)
        XCTAssertEqual(unknownEvent.typeRaw, "SOME_FUTURE_PROTOCOL_TYPE")
    }

    // MARK: - Regression: Genuine RAW events must still decode as .raw

    func test_rawEvent_eventTypeIsRaw() throws {
        // Given: a legitimate RAW wire event
        let data = jsonData("""
        {
          "type": "RAW",
          "event": { "key": "value" }
        }
        """)
        let decoder = makeStrictDecoder()

        // When
        let event = try decoder.decode(data)

        // Then: must still be a RawEvent with .raw eventType
        XCTAssertEqual(event.eventType, .raw)
        XCTAssertTrue(event is RawEvent)
    }

    func test_rawEvent_eventTypeIsNotUnknown() throws {
        // Explicit regression guard
        let data = jsonData("""
        {
          "type": "RAW",
          "event": { "key": "value" }
        }
        """)
        let event = try makeStrictDecoder().decode(data)
        XCTAssertNotEqual(event.eventType, .unknown)
    }

    // MARK: - Regression: AG-UI 1.0 subagent events must not terminate the stream

    // Previously SUBAGENT_* types were absent from EventType, so encountering them
    // in strict mode threw EventDecodingError.unknownEventType and killed the stream.
    // The default decoder now uses .returnUnknown so streams survive these events.

    func test_subagentStarted_defaultDecoder_returnsUnknownEvent() throws {
        // Given: an AG-UI 1.0 SUBAGENT_STARTED event
        let data = jsonData("""
        {
          "type": "SUBAGENT_STARTED",
          "subagentRunId": "sa-run-1",
          "name": "researcher"
        }
        """)
        let decoder = AGUIEventDecoder() // default = tolerant

        // When
        let event = try decoder.decode(data)

        // Then: stream continues; event is surfaced as UnknownEvent
        XCTAssertTrue(event is UnknownEvent, "Expected UnknownEvent, got \(type(of: event))")
        XCTAssertEqual((event as? UnknownEvent)?.typeRaw, "SUBAGENT_STARTED")
    }

    func test_subagentFinished_defaultDecoder_returnsUnknownEvent() throws {
        // Given: an AG-UI 1.0 SUBAGENT_FINISHED event
        let data = jsonData("""
        {
          "type": "SUBAGENT_FINISHED",
          "subagentRunId": "sa-run-1"
        }
        """)
        let decoder = AGUIEventDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        XCTAssertTrue(event is UnknownEvent)
        XCTAssertEqual((event as? UnknownEvent)?.typeRaw, "SUBAGENT_FINISHED")
    }

    func test_subagentError_defaultDecoder_returnsUnknownEvent() throws {
        // Given: an AG-UI 1.0 SUBAGENT_ERROR event
        let data = jsonData("""
        {
          "type": "SUBAGENT_ERROR",
          "subagentRunId": "sa-run-1",
          "message": "tool timed out"
        }
        """)
        let decoder = AGUIEventDecoder()

        // When
        let event = try decoder.decode(data)

        // Then
        XCTAssertTrue(event is UnknownEvent)
        XCTAssertEqual((event as? UnknownEvent)?.typeRaw, "SUBAGENT_ERROR")
    }
}
