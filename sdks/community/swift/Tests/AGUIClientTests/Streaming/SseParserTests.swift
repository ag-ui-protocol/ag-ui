// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import XCTest
@testable import AGUIClient

/// Comprehensive tests for Server-Sent Events (SSE) parser.
///
/// Tests follow the SSE specification from WHATWG:
/// https://html.spec.whatwg.org/multipage/server-sent-events.html
///
/// Key scenarios:
/// - Single complete events
/// - Multiple events in one chunk
/// - Partial events across chunks
/// - Multi-line data fields
/// - Event IDs and types
/// - Empty events (heartbeat)
/// - UTF-8 edge cases
final class SseParserTests: XCTestCase {
    // MARK: - Basic Parsing Tests

    func testParseSingleEvent() throws {
        var parser = SseParser()
        let events = try parser.parse("data: {\"test\":\"value\"}\n\n")

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "{\"test\":\"value\"}")
        XCTAssertNil(events[0].id)
        XCTAssertEqual(events[0].event, "message")
    }

    func testParseMultipleEvents() throws {
        var parser = SseParser()
        let input = """
        data: event1

        data: event2

        data: event3


        """
        let events = try parser.parse(input)

        XCTAssertEqual(events.count, 3)
        XCTAssertEqual(events[0].data, "event1")
        XCTAssertEqual(events[1].data, "event2")
        XCTAssertEqual(events[2].data, "event3")
    }

    func testParseEmptyDataField() throws {
        var parser = SseParser()
        let events = try parser.parse("data:\n\n")

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "")
    }

    // MARK: - Multi-line Data Tests

    func testParseMultiLineData() throws {
        var parser = SseParser()
        let input = """
        data: line1
        data: line2
        data: line3


        """
        let events = try parser.parse(input)

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "line1\nline2\nline3")
    }

    func testParseMultiLineDataWithEmptyLines() throws {
        var parser = SseParser()
        let input = """
        data: first
        data:
        data: third


        """
        let events = try parser.parse(input)

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "first\n\nthird")
    }

    // MARK: - Event ID Tests

    func testParseEventWithId() throws {
        var parser = SseParser()
        let events = try parser.parse("id: 123\ndata: test\n\n")

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "test")
        XCTAssertEqual(events[0].id, "123")
    }

    func testParseEventWithIdAfterData() throws {
        var parser = SseParser()
        let events = try parser.parse("data: test\nid: 456\n\n")

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "test")
        XCTAssertEqual(events[0].id, "456")
    }

    // MARK: - Event Type Tests

    func testParseEventWithCustomType() throws {
        var parser = SseParser()
        let events = try parser.parse("event: custom\ndata: payload\n\n")

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "payload")
        XCTAssertEqual(events[0].event, "custom")
    }

    func testParseEventWithAllFields() throws {
        var parser = SseParser()
        let input = """
        event: notification
        id: 789
        data: {"message":"hello"}


        """
        let events = try parser.parse(input)

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].event, "notification")
        XCTAssertEqual(events[0].id, "789")
        XCTAssertEqual(events[0].data, "{\"message\":\"hello\"}")
    }

    // MARK: - Partial Chunk Tests

    func testParsePartialEventReturnsNoEvents() throws {
        var parser = SseParser()
        let events = try parser.parse("data: incomplete")

        // No complete event yet (missing double newline)
        XCTAssertEqual(events.count, 0)
    }

    func testParsePartialEventCompletedInNextChunk() throws {
        var parser = SseParser()

        // First chunk: incomplete event
        var events = try parser.parse("data: {\"te")
        XCTAssertEqual(events.count, 0)

        // Second chunk: complete the event
        events = try parser.parse("st\":\"value\"}\n\n")
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "{\"test\":\"value\"}")
    }

    func testParseMultiplePartialChunks() throws {
        var parser = SseParser()

        var events = try parser.parse("da")
        XCTAssertEqual(events.count, 0)

        events = try parser.parse("ta: first")
        XCTAssertEqual(events.count, 0)

        events = try parser.parse("\n\ndata: ")
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "first")

        events = try parser.parse("second\n\n")
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "second")
    }

    func testParseEventSplitAcrossDoubleNewline() throws {
        var parser = SseParser()

        var events = try parser.parse("data: test\n")
        XCTAssertEqual(events.count, 0)

        events = try parser.parse("\n")
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "test")
    }

    // MARK: - Comment Tests

    func testParseIgnoresComments() throws {
        var parser = SseParser()
        let input = """
        : this is a comment
        data: payload


        """
        let events = try parser.parse(input)

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "payload")
    }

    func testParseIgnoresCommentsBeforeAndAfterData() throws {
        var parser = SseParser()
        let input = """
        : comment 1
        data: value
        : comment 2


        """
        let events = try parser.parse(input)

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "value")
    }

    // MARK: - Empty Event Tests

    func testParseEmptyEventAsHeartbeat() throws {
        var parser = SseParser()
        // Double newline with no data is typically a heartbeat
        let events = try parser.parse("\n\n")

        // Empty events are ignored (no data field)
        XCTAssertEqual(events.count, 0)
    }

    func testParseMultipleHeartbeats() throws {
        var parser = SseParser()
        let input = """




        data: real_event


        """
        let events = try parser.parse(input)

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "real_event")
    }

    // MARK: - Whitespace Handling Tests

    func testParseTrimsWhitespaceAfterColon() throws {
        var parser = SseParser()
        // SSE spec: Remove only ONE leading space after colon
        let events = try parser.parse("data:   value with spaces   \n\n")

        XCTAssertEqual(events.count, 1)
        // After removing colon and ONE space, "  value with spaces   " remains
        XCTAssertEqual(events[0].data, "  value with spaces   ")
    }

    func testParseHandlesNoSpaceAfterColon() throws {
        var parser = SseParser()
        let events = try parser.parse("data:value\n\n")

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "value")
    }

    func testParsePreservesTrailingWhitespaceInData() throws {
        var parser = SseParser()
        let events = try parser.parse("data: trailing   \n\n")

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "trailing   ")
    }

    // MARK: - Special Character Tests

    func testParseDataWithNewlines() throws {
        var parser = SseParser()
        let input = """
        data: line1
        data: line2


        """
        let events = try parser.parse(input)

        XCTAssertEqual(events.count, 1)
        XCTAssertTrue(events[0].data.contains("\n"))
    }

    func testParseDataWithColons() throws {
        var parser = SseParser()
        let events = try parser.parse("data: {\"url\":\"https://example.com\"}\n\n")

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "{\"url\":\"https://example.com\"}")
    }

    func testParseDataWithEmoji() throws {
        var parser = SseParser()
        let events = try parser.parse("data: Hello 👋 World 🌍\n\n")

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "Hello 👋 World 🌍")
    }

    // MARK: - Edge Cases

    func testParseLongDataLine() throws {
        var parser = SseParser()
        let longData = String(repeating: "a", count: 10000)
        let events = try parser.parse("data: \(longData)\n\n")

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, longData)
    }

    func testParseManySmallChunks() throws {
        var parser = SseParser()
        let input = "data: test\n\n"

        // Parse one character at a time
        var allEvents: [SseEvent] = []
        for char in input {
            let events = try parser.parse(String(char))
            allEvents.append(contentsOf: events)
        }

        XCTAssertEqual(allEvents.count, 1)
        XCTAssertEqual(allEvents[0].data, "test")
    }

    func testParseUnknownFieldsAreIgnored() throws {
        var parser = SseParser()
        let input = """
        data: payload
        unknown: field
        retry: 5000


        """
        let events = try parser.parse(input)

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "payload")
    }

    func testParseFieldWithoutColon() throws {
        var parser = SseParser()
        let input = """
        data: valid
        invalidfield


        """
        let events = try parser.parse(input)

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "valid")
    }

    // MARK: - Reset Tests

    func testResetClearsBuffer() throws {
        var parser = SseParser()

        // Add partial event
        _ = try parser.parse("data: incomplete")

        // Reset
        parser.reset()

        // New event should not include old buffer
        let events = try parser.parse("data: new\n\n")
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "new")
    }

    // MARK: - Real-world AG-UI Event Tests

    func testParseAGUIRunStartedEvent() throws {
        var parser = SseParser()
        let input = """
        data: {"type":"RUN_STARTED","threadId":"thread-1","runId":"run-1"}


        """
        let events = try parser.parse(input)

        XCTAssertEqual(events.count, 1)
        XCTAssertTrue(events[0].data.contains("RUN_STARTED"))
    }

    func testParseAGUITextMessageChunk() throws {
        var parser = SseParser()
        let input = """
        data: {"type":"TEXT_MESSAGE_CHUNK","messageId":"msg-1","delta":"Hello"}


        """
        let events = try parser.parse(input)

        XCTAssertEqual(events.count, 1)
        XCTAssertTrue(events[0].data.contains("TEXT_MESSAGE_CHUNK"))
    }

    func testParseMultipleAGUIEvents() throws {
        var parser = SseParser()
        let input = """
        data: {"type":"RUN_STARTED","threadId":"t1","runId":"r1"}

        data: {"type":"TEXT_MESSAGE_START","messageId":"msg1"}

        data: {"type":"TEXT_MESSAGE_CHUNK","messageId":"msg1","delta":"Hi"}

        data: {"type":"TEXT_MESSAGE_END","messageId":"msg1"}

        data: {"type":"RUN_FINISHED","threadId":"t1","runId":"r1"}


        """
        let events = try parser.parse(input)

        XCTAssertEqual(events.count, 5)
        XCTAssertTrue(events[0].data.contains("RUN_STARTED"))
        XCTAssertTrue(events[1].data.contains("TEXT_MESSAGE_START"))
        XCTAssertTrue(events[2].data.contains("TEXT_MESSAGE_CHUNK"))
        XCTAssertTrue(events[3].data.contains("TEXT_MESSAGE_END"))
        XCTAssertTrue(events[4].data.contains("RUN_FINISHED"))
    }

    // MARK: - Thread Safety Tests

    func testParserIsNotThreadSafe() throws {
        // Document that SseParser is a mutable struct and not thread-safe
        // Each thread should have its own parser instance
        var parser = SseParser()
        _ = try parser.parse("data: test\n\n")

        // This is expected behavior - parser maintains internal state
        XCTAssertTrue(true, "SseParser is designed for single-threaded use")
    }

    // MARK: - Performance Tests

    func testParseLargeStreamEfficiently() throws {
        var parser = SseParser()

        // Simulate large stream
        let iterations = 1000
        var totalEvents = 0

        for i in 0..<iterations {
            let events = try parser.parse("data: event\(i)\n\n")
            totalEvents += events.count
        }

        XCTAssertEqual(totalEvents, iterations)
    }

    // MARK: - Regression: CRLF line endings split across chunk boundaries

    // WHATWG SSE spec §9.2.6: \r, \n, and \r\n are all valid line terminators.
    // When \r arrives at the end of one chunk and \n at the start of the next,
    // the pair forms a single \r\n line terminator — not two separate newlines.
    // The pre-fix implementation normalized each chunk independently, so the lone
    // \r was stored as \n in the buffer. The subsequent \n created \n\n, which the
    // parser incorrectly interpreted as an event separator.

    func test_parse_crlfLineEndings_singleChunk_parsesCorrectly() throws {
        // Baseline: CRLF line endings that arrive together in one chunk must parse.
        var parser = SseParser()
        let events = try parser.parse("data: hello\r\n\r\n")

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "hello")
    }

    func test_parse_crlfSplitAcrossChunks_doesNotSplitMultiLineEvent() throws {
        // Regression: this stream is ONE event with data "line1\nline2".
        //
        //   data: line1\r\n   ← first data line (CRLF line ending)
        //   data: line2\r\n   ← second data line (CRLF line ending)
        //   \r\n              ← event separator
        //
        // Split so that the \r of the first line ending arrives in chunk 1 and
        // its \n arrives at the start of chunk 2.
        var parser = SseParser()

        _ = try parser.parse("data: line1\r")             // lone \r at end of chunk
        let events = try parser.parse("\ndata: line2\r\n\r\n") // \n completes the \r\n

        XCTAssertEqual(
            events.count, 1,
            "Cross-chunk \\r\\n must not create a spurious event separator"
        )
        XCTAssertEqual(events[0].data, "line1\nline2")
    }

    func test_parse_crlfSplitAcrossChunks_threeLineEvent() throws {
        // Same regression, with three data lines — every internal \r\n split.
        var parser = SseParser()

        var all: [SseEvent] = []
        all += try parser.parse("data: a\r")
        all += try parser.parse("\ndata: b\r")
        all += try parser.parse("\ndata: c\r\n\r\n")

        XCTAssertEqual(all.count, 1)
        XCTAssertEqual(all[0].data, "a\nb\nc")
    }

    func test_parse_crlfSplitAcrossChunks_twoSequentialEvents() throws {
        // Two separate events whose separators don't span chunk boundaries.
        // Verifies correct behaviour is not disturbed for the common case.
        var parser = SseParser()

        var all: [SseEvent] = []
        all += try parser.parse("data: first\r\n\r\n")
        all += try parser.parse("data: second\r\n\r\n")

        XCTAssertEqual(all.count, 2)
        XCTAssertEqual(all[0].data, "first")
        XCTAssertEqual(all[1].data, "second")
    }
}

extension SseParserTests {
    func testRetryAcceptsOnlyASCIIUnsignedIntegers() throws {
        for (value, expected) in [("0", Optional(0)), ("1500", Optional(1500)),
                                  ("-1", nil), ("+1", nil), ("1.5", nil),
                                  ("١", nil), ("", nil), (String(repeating: "9", count: 30), nil)] {
            var parser = SseParser()
            let events = try parser.parse("retry: \(value)\ndata: hello\n\n")
            XCTAssertEqual(events.first?.retry, expected, value)
        }
    }

    func testNullContainingIDIsIgnoredWithoutReplacingValidID() throws {
        var parser = SseParser()
        let events = try parser.parse("id: valid\nid: bad\0id\ndata: hello\n\n")
        XCTAssertEqual(events.first?.id, "valid")
        let invalid = try parser.parse("id: bad\0id\ndata: hello\n\n")
        XCTAssertNil(invalid.first?.id)
    }

    func testBufferOverflowThrowsAndResetsParser() throws {
        var parser = SseParser()
        XCTAssertTrue(try parser.parse(String(repeating: "x", count: SseParser.maxBufferByteCount)).isEmpty)
        XCTAssertThrowsError(try parser.parse("x")) {
            XCTAssertEqual($0 as? SseParserError, .bufferOverflow)
        }
        XCTAssertEqual(try parser.parse("data: recovered\n\n").first?.data, "recovered")
    }

    func testEmptyChunkPreservesPendingCRLF() throws {
        var parser = SseParser()
        XCTAssertEqual(try parser.parse("data: first\r\r").first?.data, "first")
        XCTAssertTrue(try parser.parse("").isEmpty)
        XCTAssertTrue(try parser.parse("\n").isEmpty)
        XCTAssertEqual(try parser.parse("data: second\r\n\r\n").first?.data, "second")
    }
}
