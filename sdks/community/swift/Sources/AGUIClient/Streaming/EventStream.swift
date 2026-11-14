// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

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
/// - Malformed JSON (`EventDecodingError.invalidJSON`) is skipped — bytes may arrive
///   truncated and that is not a protocol violation.
/// - Protocol violations — `unknownEventType`, `missingTypeField`, `decodingFailed`,
///   `unsupportedEventType` — are re-thrown, terminating the stream. This matches the
///   TypeScript reference implementation which calls `eventSubject.error(err)` for all
///   decode failures.
/// - In tolerant mode (`.returnUnknown` strategy), unknown event types are wrapped in
///   `UnknownEvent` by the decoder before reaching this layer, so `unknownEventType` is
///   never thrown.
/// - Network errors propagate to the caller.
///
/// ## Last-Event-ID tracking
///
/// `lastEventId` exposes the most recent `id:` field seen in the SSE stream.
/// It is updated as events arrive and can be read after a mid-stream failure
/// to resume from the correct position on reconnect.
///
/// ## Thread Safety
///
/// `EventStream` is Sendable and can be used across concurrency domains.
/// Each iteration creates a new iterator with isolated state.
public struct EventStream<Bytes: AsyncSequence>: AsyncSequence where Bytes.Element == UInt8 {
    public typealias Element = any AGUIEvent

    // MARK: - Shared last-event-id box

    /// Reference box that lets the iterator write the last SSE id back to the stream.
    ///
    /// Using a class (reference semantics) means every iterator created from the same
    /// stream updates the same location, so callers can read `lastEventId` on the
    /// stream value after an iterator throws.
    ///
    /// Declared as an `actor` so the compiler synthesises `Sendable` automatically
    /// and serialises all reads and writes without manual locking.
    actor LastEventIdBox {
        var value: String?

        func set(_ newValue: String?) {
            value = newValue
        }
    }

    // MARK: - Stored properties

    /// The source byte stream from HTTP response.
    private let bytes: Bytes

    /// The AG-UI event decoder.
    private let decoder: AGUIEventDecoder

    /// Shared box updated by the iterator whenever a non-nil SSE `id:` field is seen.
    private let lastEventIdBox = LastEventIdBox()

    // MARK: - Public surface

    /// The most recent SSE event `id:` field received, or `nil` if none has arrived yet.
    ///
    /// Read this after a mid-stream failure to obtain the resume cursor for
    /// `Last-Event-ID` on reconnect.
    public var lastEventId: String? { get async { await lastEventIdBox.value } }

    // MARK: - Initialization

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
        AsyncIterator(bytes: bytes.makeAsyncIterator(), decoder: decoder, lastEventIdBox: lastEventIdBox)
    }

    /// Iterator that processes streaming bytes into AG-UI events.
    ///
    /// The iterator maintains internal state for:
    /// - SSE byte parsing
    /// - Last-Event-ID tracking (via shared `LastEventIdBox`)
    public struct AsyncIterator: AsyncIteratorProtocol {
        /// Source byte iterator.
        private var bytesIterator: Bytes.AsyncIterator

        /// AG-UI event decoder.
        private let decoder: AGUIEventDecoder

        /// SSE parser for extracting events from stream.
        private var sseParser = SseParser()

        /// Shared reference that is updated with the most recent SSE `id:` value.
        private let lastEventIdBox: LastEventIdBox

        /// Creates a new iterator.
        ///
        /// - Parameters:
        ///   - bytes: Source byte iterator
        ///   - decoder: AG-UI event decoder
        ///   - lastEventIdBox: Shared box written to whenever a non-nil SSE id is seen
        init(bytes: Bytes.AsyncIterator, decoder: AGUIEventDecoder, lastEventIdBox: LastEventIdBox) {
            self.bytesIterator = bytes
            self.decoder = decoder
            self.lastEventIdBox = lastEventIdBox
        }

        /// Returns the next AG-UI event from the stream.
        ///
        /// This method:
        /// 1. Feeds bytes to the SSE parser until an event is complete
        /// 2. Records the event's `id:` for reconnection
        /// 3. Decodes the AG-UI event from the SSE data
        /// 4. Returns the event, or nil when the stream ends
        ///
        /// - Returns: Next event, or nil when stream ends
        /// - Throws: Network errors or critical decoding failures
        public mutating func next() async throws -> (any AGUIEvent)? {
            while let byte = try await bytesIterator.next() {
                // Throws SseParserError.bufferOverflow if an event exceeds
                // maxBufferByteCount — treat as a fatal stream error.
                guard let sseEvent = try sseParser.consume(byte) else { continue }

                // Track the last-event-id for reconnection support.
                // The id is captured before decoding so it is available even
                // when the accompanying data fails to decode.
                if let id = sseEvent.id {
                    await lastEventIdBox.set(id)
                }

                do {
                    let event = try decoder.decode(Data(sseEvent.data.utf8))
                    // Yield so callers on the main actor can render between events
                    // that arrived in a single network packet.
                    await Task.yield()
                    return event
                } catch let error as EventDecodingError {
                    switch error {
                    case .invalidJSON:
                        // Malformed bytes are not a protocol violation — the packet
                        // may have arrived truncated. Skip and keep the stream alive.
                        #if DEBUG
                        print("[EventStream] ⚠ Malformed JSON — skipping: \(sseEvent.data.prefix(200))")
                        #endif
                    case .unknownEventType, .missingTypeField, .decodingFailed, .unsupportedEventType:
                        // Protocol violations: the TypeScript reference implementation
                        // calls eventSubject.error(err) for all of these — the stream
                        // terminates. Re-throw to match that behaviour.
                        throw error
                    }
                }
            }

            // No more events
            return nil
        }
    }
}
