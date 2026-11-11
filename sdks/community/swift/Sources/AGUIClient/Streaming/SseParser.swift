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

    /// Internal buffer for incomplete events, held as UTF-8 bytes.
    ///
    /// Framing happens on bytes so that a multi-byte character split across two
    /// chunks stays intact until the event holding it is complete.
    private var buffer: [UInt8] = []

    /// How many leading bytes of `buffer` have already been searched for a
    /// separator. A chunk that completes no event leaves its last byte
    /// unsearched, because the separator it starts may be finished by the chunk
    /// that follows.
    private var scanIndex = 0

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
        guard !chunk.isEmpty else { return [] }
        // WHATWG SSE spec: \r, \n, and \r\n are all valid line terminators.
        // Normalise line endings to \n — but handle the cross-chunk case where
        // \r arrives at the end of one chunk and \n at the start of the next.
        // Without special handling, the lone \r would be stored as \n in the
        // buffer and the subsequent \n would create \n\n, which the parser
        // incorrectly reads as an event separator.
        var toNormalize = chunk

        if endsWithCR {
            if toNormalize.hasPrefix("\n") {
                // The preceding CR was already processed, possibly dispatching
                // an event. Only consume its paired LF; never modify the buffer.
                toNormalize = String(toNormalize.dropFirst())
            }
            endsWithCR = false
        }

        // Replace \r\n first so that any remaining lone \r is genuinely standalone.
        let step1 = toNormalize.replacingOccurrences(of: "\r\n", with: "\n")
        // Remember whether this chunk ends with a lone \r before it is erased.
        endsWithCR = step1.hasSuffix("\r")
        let normalized = step1.replacingOccurrences(of: "\r", with: "\n")
        buffer.append(contentsOf: normalized.utf8)

        // Guard against unbounded buffer growth from malformed/malicious streams.
        guard buffer.count <= Self.maxBufferByteCount else {
            reset()
            throw SseParserError.bufferOverflow
        }

        var events: [SseEvent] = []

        // Search forward from where the previous chunk's scan stopped. Splitting
        // the whole buffer on every chunk looks again at everything already
        // held, which costs time quadratic in the size of one event.
        var eventStart = 0
        var index = scanIndex

        while index + 1 < buffer.count {
            guard buffer[index] == 0x0A, buffer[index + 1] == 0x0A else {
                index += 1
                continue
            }

            // Empty parts carry no fields, so they are skipped rather than parsed.
            if index > eventStart {
                // Decoded a whole event at a time, so an ill-formed sequence
                // becomes U+FFFD here instead of being dropped earlier.
                let part = String(decoding: buffer[eventStart..<index], as: UTF8.self)
                if let event = parseEvent(part) {
                    events.append(event)
                }
            }

            index += 2
            eventStart = index
        }

        // Keep the trailing part in buffer (might be incomplete)
        if eventStart > 0 {
            buffer.removeFirst(eventStart)
        }
        scanIndex = max(0, buffer.count - 1)

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
        buffer = []
        scanIndex = 0
        endsWithCR = false
    }
}
