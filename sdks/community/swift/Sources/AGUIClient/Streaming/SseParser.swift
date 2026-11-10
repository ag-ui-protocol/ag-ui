// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

/// Fatal errors encountered while parsing an SSE stream.
public enum SseParserError: Error, Equatable {
    case bufferOverflow
}

/// Incremental parser for Server-Sent Events (SSE) streams.
///
/// `SseParser` is a stateful parser that handles SSE data arriving in
/// arbitrary chunks. It maintains an internal buffer for incomplete events
/// and returns complete events as they become available.
///
public struct SseParser {
    /// Maximum number of UTF-8 bytes the internal buffer may hold.
    ///
    /// If a stream sends data faster than complete events arrive — or sends a
    /// pathologically large payload without a double-newline terminator — the
    /// buffer is reset and `SseParserError.bufferOverflow` is thrown. This prevents
    /// unbounded memory growth from malformed or malicious streams.
    public static let maxBufferByteCount = 10 * 1_048_576 // 10 MB

    /// Internal buffer for incomplete events.
    private var buffer: [UInt8] = []

    /// True when the previous chunk's last raw character was a lone `\r`.
    ///
    /// Per the WHATWG SSE spec, `\r`, `\n`, and `\r\n` are all valid line
    /// terminators. When `\r` arrives at the end of one chunk and `\n` at the
    /// start of the next, they form a single `\r\n` line terminator — not two
    /// separate newlines. This flag lets `parse(_:)` detect and handle that
    /// cross-chunk `\r\n` sequence correctly.
    private var endsWithCR = false

    /// Creates a new SSE parser.
    public init() {}

    /// Parses a chunk of SSE data and returns complete events.
    ///
    /// This method is designed for incremental parsing of streaming data.
    /// Incomplete events are buffered internally and will be completed
    /// when subsequent chunks arrive.
    ///
    /// - Parameter chunk: A chunk of SSE text data
    /// - Throws: `SseParserError.bufferOverflow` when buffered UTF-8 exceeds the limit.
    /// - Returns: Array of complete events parsed from this chunk
    ///
    /// ## Example
    ///
    /// ```swift
    /// var parser = SseParser()
    ///
    /// // First chunk: incomplete event
    /// var events = try parser.parse("data: {\"te")
    /// // returns: []
    ///
    /// // Second chunk: completes the event
    /// events = try parser.parse("st\":\"value\"}\n\n")
    /// // returns: [SseEvent(data: "{\"test\":\"value\"}")]
    /// ```
    ///
    /// ## Edge Cases
    ///
    /// - Empty chunks are handled gracefully
    /// - Partial UTF-8 sequences are preserved in buffer
    /// - Very long lines are supported
    /// - Multiple events in one chunk are all returned
    public mutating func parse(_ chunk: String) throws -> [SseEvent] {
        var events: [SseEvent] = []
        // Consume each new byte once. Never rescan the accumulated frame for
        // every network byte: a large snapshot must remain linear-time.
        for byte in chunk.utf8 {
            if endsWithCR {
                endsWithCR = false
                if byte == 10 { continue }
            }
            let normalized: UInt8
            if byte == 13 {
                endsWithCR = true
                normalized = 10
            } else {
                normalized = byte
            }
            if normalized == 10 && buffer.last == 10 {
                buffer.removeLast()
                if let event = parseEvent(String(decoding: buffer, as: UTF8.self)) {
                    events.append(event)
                }
                buffer.removeAll(keepingCapacity: true)
                continue
            }
            guard buffer.count < Self.maxBufferByteCount else {
                reset()
                throw SseParserError.bufferOverflow
            }
            buffer.append(normalized)
        }
        return events
    }

    /// Parses a single complete event from its text representation.
    ///
    /// - Parameter text: The event text (between double newlines)
    /// - Returns: Parsed event, or nil if no data field present
    private func parseEvent(_ text: String) -> SseEvent? {
        var dataLines: [String] = []
        var id: String?
        var eventType: String?
        var retry: Int?

        // Process each line in the event
        for line in text.components(separatedBy: "\n") {
            // Skip empty lines
            guard !line.isEmpty else { continue }

            // Comments start with ':'
            if line.hasPrefix(":") {
                continue
            }

            // Find the colon separator
            guard let colonIndex = line.firstIndex(of: ":") else {
                // Lines without colon are ignored per spec
                continue
            }

            let field = String(line[..<colonIndex])
            var value = String(line[line.index(after: colonIndex)...])

            // Remove single leading space after colon (per spec)
            if value.hasPrefix(" ") {
                value = String(value.dropFirst())
            }

            // Process field
            switch field {
            case "data":
                dataLines.append(value)
            case "id":
                if !value.contains("\0") { id = value }
            case "retry":
                if !value.isEmpty, value.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }),
                   let interval = Int(value) {
                    retry = interval
                }
            case "event":
                eventType = value
            default:
                // Unknown fields are ignored per spec
                break
            }
        }

        // Events without data field are ignored
        guard !dataLines.isEmpty else {
            return nil
        }

        // Concatenate multiple data lines with newlines
        let data = dataLines.joined(separator: "\n")

        return SseEvent(
            data: data,
            id: id,
            event: eventType ?? "message",
            retry: retry
        )
    }

    /// Resets the parser, clearing any buffered incomplete events.
    ///
    /// Use this when starting a new stream or when an error requires
    /// discarding incomplete data.
    ///
    /// ## Example
    ///
    /// ```swift
    /// var parser = SseParser()
    /// _ = try parser.parse("data: incomplete")
    ///
    /// // Discard buffered data
    /// parser.reset()
    ///
    /// // Start fresh
    /// let events = try parser.parse("data: new\n\n")
    /// ```
    public mutating func reset() {
        buffer.removeAll(keepingCapacity: false)
        endsWithCR = false
    }
}
