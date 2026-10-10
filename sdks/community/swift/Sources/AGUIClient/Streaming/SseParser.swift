// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import Foundation

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
    /// buffer is reset and parsing continues with the next chunk. This prevents
    /// unbounded memory growth from malformed or malicious streams.
    public static let maxBufferByteCount = 10 * 1_048_576 // 10 MB

    /// Internal buffer for incomplete events.
    private var buffer: String = ""

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
    /// - Returns: Array of complete events parsed from this chunk
    ///
    /// ## Example
    ///
    /// ```swift
    /// var parser = SseParser()
    ///
    /// // First chunk: incomplete event
    /// var events = parser.parse("data: {\"te")
    /// // returns: []
    ///
    /// // Second chunk: completes the event
    /// events = parser.parse("st\":\"value\"}\n\n")
    /// // returns: [SseEvent(data: "{\"test\":\"value\"}")]
    /// ```
    ///
    /// ## Edge Cases
    ///
    /// - Empty chunks are handled gracefully
    /// - Partial UTF-8 sequences are preserved in buffer
    /// - Very long lines are supported
    /// - Multiple events in one chunk are all returned
    public mutating func parse(_ chunk: String) -> [SseEvent] {
        // WHATWG SSE spec: \r, \n, and \r\n are all valid line terminators.
        // Normalise line endings to \n — but handle the cross-chunk case where
        // \r arrives at the end of one chunk and \n at the start of the next.
        // Without special handling, the lone \r would be stored as \n in the
        // buffer and the subsequent \n would create \n\n, which the parser
        // incorrectly reads as an event separator.
        var toNormalize = chunk

        if endsWithCR {
            if toNormalize.hasPrefix("\n") {
                // The \r at the end of the previous chunk and the \n at the
                // start of this chunk together form a single \r\n line ending.
                // Undo the \n that was already added to the buffer for the lone
                // \r, then consume the leading \n from this chunk.
                buffer.removeLast()
                toNormalize = String(toNormalize.dropFirst())
                buffer += "\n" // one correct \n for the \r\n pair
            }
            // else: the lone \r was a standalone line terminator — the \n
            // already in the buffer is correct; nothing to undo.
            endsWithCR = false
        }

        // Replace \r\n first so that any remaining lone \r is genuinely standalone.
        let step1 = toNormalize.replacingOccurrences(of: "\r\n", with: "\n")
        // Remember whether this chunk ends with a lone \r before it is erased.
        endsWithCR = step1.hasSuffix("\r")
        let normalized = step1.replacingOccurrences(of: "\r", with: "\n")
        buffer += normalized

        // Guard against unbounded buffer growth from malformed/malicious streams.
        guard buffer.utf8.count <= Self.maxBufferByteCount else {
            buffer = ""
            return []
        }

        var events: [SseEvent] = []

        // Split on double newline (event separator — handles \n\n after normalization)
        let parts = buffer.components(separatedBy: "\n\n")

        // Keep the last part in buffer (might be incomplete)
        buffer = parts.last ?? ""

        // Process complete events (all parts except the last)
        for part in parts.dropLast() where !part.isEmpty {
            if let event = parseEvent(part) {
                events.append(event)
            }
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
                id = value
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
            event: eventType ?? "message"
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
    /// _ = parser.parse("data: incomplete")
    ///
    /// // Discard buffered data
    /// parser.reset()
    ///
    /// // Start fresh
    /// let events = parser.parse("data: new\n\n")
    /// ```
    public mutating func reset() {
        buffer = ""
        endsWithCR = false
    }
}
