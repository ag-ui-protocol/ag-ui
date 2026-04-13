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

import AGUICore
import Foundation

/// AsyncSequence of AG-UI events from a streaming HTTP response.
///
/// `EventStream` integrates the complete event streaming pipeline:
/// 1. Reads bytes from HTTP response (any AsyncSequence<UInt8>)
/// 2. Parses Server-Sent Events (SSE) using SseParser
/// 3. Decodes AG-UI events using AGUIEventDecoder
/// 4. Handles errors gracefully
///
/// ## Usage
///
/// ```swift
/// let transport = HttpTransport(configuration: config)
/// let bytes = try await transport.execute(endpoint: "/run", input: input)
/// let decoder = AGUIEventDecoder()
/// let stream = EventStream(bytes: bytes, decoder: decoder)
///
/// for try await event in stream {
///     switch event.eventType {
///     case .textMessageChunk:
///         let chunk = event as! TextMessageChunkEvent
///         print(chunk.delta, terminator: "")
///     case .runFinished:
///         print("\nDone!")
///     default:
///         break
///     }
/// }
/// ```
///
/// ## Error Handling
///
/// - Malformed JSON events are logged and skipped
/// - Unknown event types are returned as `UnknownEvent`
/// - UTF-8 decoding errors are handled gracefully
/// - Network errors propagate to the caller
///
/// ## Thread Safety
///
/// `EventStream` is Sendable and can be used across concurrency domains.
/// Each iteration creates a new iterator with isolated state.
public struct EventStream<Bytes: AsyncSequence>: AsyncSequence where Bytes.Element == UInt8 {
    public typealias Element = any AGUIEvent

    /// The source byte stream from HTTP response.
    private let bytes: Bytes

    /// The AG-UI event decoder.
    private let decoder: AGUIEventDecoder

    /// Creates a new event stream.
    ///
    /// - Parameters:
    ///   - bytes: Async sequence of bytes from HTTP streaming response
    ///   - decoder: AG-UI event decoder
    public init(bytes: Bytes, decoder: AGUIEventDecoder) {
        self.bytes = bytes
        self.decoder = decoder
    }

    /// Creates an async iterator for streaming events.
    public func makeAsyncIterator() -> AsyncIterator {
        AsyncIterator(bytes: bytes.makeAsyncIterator(), decoder: decoder)
    }

    /// Iterator that processes streaming bytes into AG-UI events.
    ///
    /// The iterator maintains internal state for:
    /// - UTF-8 byte accumulation
    /// - SSE event parsing
    /// - Event queue management
    public struct AsyncIterator: AsyncIteratorProtocol {
        /// Source byte iterator.
        private var bytesIterator: Bytes.AsyncIterator

        /// AG-UI event decoder.
        private let decoder: AGUIEventDecoder

        /// SSE parser for extracting events from stream.
        private var sseParser = SseParser()

        /// Queue of decoded events ready to return.
        private var eventQueue: [any AGUIEvent] = []

        /// Buffer for accumulating UTF-8 bytes.
        private var utf8Buffer: [UInt8] = []

        /// Creates a new iterator.
        ///
        /// - Parameters:
        ///   - bytes: Source byte iterator
        ///   - decoder: AG-UI event decoder
        init(bytes: Bytes.AsyncIterator, decoder: AGUIEventDecoder) {
            self.bytesIterator = bytes
            self.decoder = decoder
        }

        /// Returns the next AG-UI event from the stream.
        ///
        /// This method:
        /// 1. Returns queued events first
        /// 2. Reads and accumulates bytes until valid UTF-8
        /// 3. Parses SSE events from UTF-8 strings
        /// 4. Decodes AG-UI events from SSE data
        /// 5. Returns the next available event
        ///
        /// - Returns: Next event, or nil when stream ends
        /// - Throws: Network errors or critical decoding failures
        public mutating func next() async throws -> (any AGUIEvent)? {
            // Return queued events first
            guard eventQueue.isEmpty else {
                return eventQueue.removeFirst()
            }

            // Read and process bytes until we have events
            while let byte = try await bytesIterator.next() {
                utf8Buffer.append(byte)

                // Try to decode accumulated bytes as UTF-8
                if let string = String(bytes: utf8Buffer, encoding: .utf8) {
                    // Successful decode - process the chunk
                    utf8Buffer.removeAll()

                    // Parse SSE events from the string chunk
                    let sseEvents = sseParser.parse(string)

                    // Decode AG-UI events from SSE data
                    for sseEvent in sseEvents {
                        guard let data = sseEvent.data.data(using: .utf8) else {
                            // Skip events with invalid UTF-8 data
                            continue
                        }

                        do {
                            let event = try decoder.decode(data)
                            eventQueue.append(event)
                        } catch {
                            // Non-fatal decoding errors are silently ignored
                            // The stream continues processing subsequent events
                            // Applications can implement custom error handling if needed
                            #if DEBUG
                            print("[EventStream] ⚠ Decode error: \(error) — raw: \(sseEvent.data.prefix(200))")
                            #endif
                        }
                    }

                    // Return first decoded event if available
                    guard eventQueue.isEmpty else {
                        return eventQueue.removeFirst()
                    }
                } else if utf8Buffer.count > 4 {
                    // Invalid UTF-8 sequence (UTF-8 characters are max 4 bytes)
                    // Skip the first byte and try to resynchronize
                    utf8Buffer.removeFirst()
                }
            }

            // Stream ended - return any remaining queued events
            guard eventQueue.isEmpty else {
                return eventQueue.removeFirst()
            }

            // No more events
            return nil
        }
    }
}
