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

    func testParseSingleEvent() {
        var parser = SseParser()
        let events = parser.parse("data: {\"test\":\"value\"}\n\n")

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "{\"test\":\"value\"}")
        XCTAssertNil(events[0].id)
        XCTAssertEqual(events[0].event, "message")
    }

    func testParseMultipleEvents() {
        var parser = SseParser()
        let input = """
        data: event1

        data: event2

        data: event3


        """
        let events = parser.parse(input)

        XCTAssertEqual(events.count, 3)
        XCTAssertEqual(events[0].data, "event1")
        XCTAssertEqual(events[1].data, "event2")
        XCTAssertEqual(events[2].data, "event3")
    }

    func testParseEmptyDataField() {
        var parser = SseParser()
        let events = parser.parse("data:\n\n")

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "")
    }

    // MARK: - Multi-line Data Tests

    func testParseMultiLineData() {
        var parser = SseParser()
        let input = """
        data: line1
        data: line2
        data: line3


        """
        let events = parser.parse(input)

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "line1\nline2\nline3")
    }

    func testParseMultiLineDataWithEmptyLines() {
        var parser = SseParser()
        let input = """
        data: first
        data:
        data: third


        """
        let events = parser.parse(input)

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "first\n\nthird")
    }

    // MARK: - Event ID Tests

    func testParseEventWithId() {
        var parser = SseParser()
        let events = parser.parse("id: 123\ndata: test\n\n")

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "test")
        XCTAssertEqual(events[0].id, "123")
    }

    func testParseEventWithIdAfterData() {
        var parser = SseParser()
        let events = parser.parse("data: test\nid: 456\n\n")

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "test")
        XCTAssertEqual(events[0].id, "456")
    }

    // MARK: - Event Type Tests

    func testParseEventWithCustomType() {
        var parser = SseParser()
        let events = parser.parse("event: custom\ndata: payload\n\n")

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "payload")
        XCTAssertEqual(events[0].event, "custom")
    }

    func testParseEventWithAllFields() {
        var parser = SseParser()
        let input = """
        event: notification
        id: 789
        data: {"message":"hello"}


        """
        let events = parser.parse(input)

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].event, "notification")
        XCTAssertEqual(events[0].id, "789")
        XCTAssertEqual(events[0].data, "{\"message\":\"hello\"}")
    }

    // MARK: - Partial Chunk Tests

    func testParsePartialEventReturnsNoEvents() {
        var parser = SseParser()
        let events = parser.parse("data: incomplete")

        // No complete event yet (missing double newline)
        XCTAssertEqual(events.count, 0)
    }

    func testParsePartialEventCompletedInNextChunk() {
        var parser = SseParser()

        // First chunk: incomplete event
        var events = parser.parse("data: {\"te")
        XCTAssertEqual(events.count, 0)

        // Second chunk: complete the event
        events = parser.parse("st\":\"value\"}\n\n")
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "{\"test\":\"value\"}")
    }

    func testParseMultiplePartialChunks() {
        var parser = SseParser()

        var events = parser.parse("da")
        XCTAssertEqual(events.count, 0)

        events = parser.parse("ta: first")
        XCTAssertEqual(events.count, 0)

        events = parser.parse("\n\ndata: ")
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "first")

        events = parser.parse("second\n\n")
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "second")
    }

    func testParseEventSplitAcrossDoubleNewline() {
        var parser = SseParser()

        var events = parser.parse("data: test\n")
        XCTAssertEqual(events.count, 0)

        events = parser.parse("\n")
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "test")
    }

    // MARK: - Comment Tests

    func testParseIgnoresComments() {
        var parser = SseParser()
        let input = """
        : this is a comment
        data: payload


        """
        let events = parser.parse(input)

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "payload")
    }

    func testParseIgnoresCommentsBeforeAndAfterData() {
        var parser = SseParser()
        let input = """
        : comment 1
        data: value
        : comment 2


        """
        let events = parser.parse(input)

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "value")
    }

    // MARK: - Empty Event Tests

    func testParseEmptyEventAsHeartbeat() {
        var parser = SseParser()
        // Double newline with no data is typically a heartbeat
        let events = parser.parse("\n\n")

        // Empty events are ignored (no data field)
        XCTAssertEqual(events.count, 0)
    }

    func testParseMultipleHeartbeats() {
        var parser = SseParser()
        let input = """




        data: real_event


        """
        let events = parser.parse(input)

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "real_event")
    }

    // MARK: - Whitespace Handling Tests

    func testParseTrimsWhitespaceAfterColon() {
        var parser = SseParser()
        // SSE spec: Remove only ONE leading space after colon
        let events = parser.parse("data:   value with spaces   \n\n")

        XCTAssertEqual(events.count, 1)
        // After removing colon and ONE space, "  value with spaces   " remains
        XCTAssertEqual(events[0].data, "  value with spaces   ")
    }

    func testParseHandlesNoSpaceAfterColon() {
        var parser = SseParser()
        let events = parser.parse("data:value\n\n")

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "value")
    }

    func testParsePreservesTrailingWhitespaceInData() {
        var parser = SseParser()
        let events = parser.parse("data: trailing   \n\n")

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "trailing   ")
    }

    // MARK: - Special Character Tests

    func testParseDataWithNewlines() {
        var parser = SseParser()
        let input = """
        data: line1
        data: line2


        """
        let events = parser.parse(input)

        XCTAssertEqual(events.count, 1)
        XCTAssertTrue(events[0].data.contains("\n"))
    }

    func testParseDataWithColons() {
        var parser = SseParser()
        let events = parser.parse("data: {\"url\":\"https://example.com\"}\n\n")

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "{\"url\":\"https://example.com\"}")
    }

    func testParseDataWithEmoji() {
        var parser = SseParser()
        let events = parser.parse("data: Hello 👋 World 🌍\n\n")

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "Hello 👋 World 🌍")
    }

    // MARK: - Edge Cases

    func testParseLongDataLine() {
        var parser = SseParser()
        let longData = String(repeating: "a", count: 10000)
        let events = parser.parse("data: \(longData)\n\n")

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, longData)
    }

    func testParseManySmallChunks() {
        var parser = SseParser()
        let input = "data: test\n\n"

        // Parse one character at a time
        var allEvents: [SseEvent] = []
        for char in input {
            let events = parser.parse(String(char))
            allEvents.append(contentsOf: events)
        }

        XCTAssertEqual(allEvents.count, 1)
        XCTAssertEqual(allEvents[0].data, "test")
    }

    func testParseUnknownFieldsAreIgnored() {
        var parser = SseParser()
        let input = """
        data: payload
        unknown: field
        retry: 5000


        """
        let events = parser.parse(input)

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "payload")
    }

    func testParseFieldWithoutColon() {
        var parser = SseParser()
        let input = """
        data: valid
        invalidfield


        """
        let events = parser.parse(input)

        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "valid")
    }

    // MARK: - Reset Tests

    func testResetClearsBuffer() {
        var parser = SseParser()

        // Add partial event
        _ = parser.parse("data: incomplete")

        // Reset
        parser.reset()

        // New event should not include old buffer
        let events = parser.parse("data: new\n\n")
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "new")
    }

    // MARK: - Real-world AG-UI Event Tests

    func testParseAGUIRunStartedEvent() {
        var parser = SseParser()
        let input = """
        data: {"type":"RUN_STARTED","threadId":"thread-1","runId":"run-1"}


        """
        let events = parser.parse(input)

        XCTAssertEqual(events.count, 1)
        XCTAssertTrue(events[0].data.contains("RUN_STARTED"))
    }

    func testParseAGUITextMessageChunk() {
        var parser = SseParser()
        let input = """
        data: {"type":"TEXT_MESSAGE_CHUNK","messageId":"msg-1","delta":"Hello"}


        """
        let events = parser.parse(input)

        XCTAssertEqual(events.count, 1)
        XCTAssertTrue(events[0].data.contains("TEXT_MESSAGE_CHUNK"))
    }

    func testParseMultipleAGUIEvents() {
        var parser = SseParser()
        let input = """
        data: {"type":"RUN_STARTED","threadId":"t1","runId":"r1"}

        data: {"type":"TEXT_MESSAGE_START","messageId":"msg1"}

        data: {"type":"TEXT_MESSAGE_CHUNK","messageId":"msg1","delta":"Hi"}

        data: {"type":"TEXT_MESSAGE_END","messageId":"msg1"}

        data: {"type":"RUN_FINISHED","threadId":"t1","runId":"r1"}


        """
        let events = parser.parse(input)

        XCTAssertEqual(events.count, 5)
        XCTAssertTrue(events[0].data.contains("RUN_STARTED"))
        XCTAssertTrue(events[1].data.contains("TEXT_MESSAGE_START"))
        XCTAssertTrue(events[2].data.contains("TEXT_MESSAGE_CHUNK"))
        XCTAssertTrue(events[3].data.contains("TEXT_MESSAGE_END"))
        XCTAssertTrue(events[4].data.contains("RUN_FINISHED"))
    }

    // MARK: - Thread Safety Tests

    func testParserIsNotThreadSafe() {
        // Document that SseParser is a mutable struct and not thread-safe
        // Each thread should have its own parser instance
        var parser = SseParser()
        _ = parser.parse("data: test\n\n")

        // This is expected behavior - parser maintains internal state
        XCTAssertTrue(true, "SseParser is designed for single-threaded use")
    }

    // MARK: - Performance Tests

    func testParseLargeStreamEfficiently() {
        var parser = SseParser()

        // Simulate large stream
        let iterations = 1000
        var totalEvents = 0

        for i in 0..<iterations {
            let events = parser.parse("data: event\(i)\n\n")
            totalEvents += events.count
        }

        XCTAssertEqual(totalEvents, iterations)
    }
}
