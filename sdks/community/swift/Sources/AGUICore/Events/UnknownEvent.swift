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

import Foundation

/// Event representing an unknown or unsupported event type.
///
/// `UnknownEvent` is returned by `AGUIEventDecoder` when operating in tolerant mode
/// (`unknownEventStrategy = .returnUnknown`) and encounters an event that cannot be
/// decoded into a known event type.
///
/// ## When UnknownEvent is Created
///
/// An `UnknownEvent` is created in two scenarios:
///
/// 1. **Unknown Event Type**: The event's "type" field contains a value that is not
///    recognized by the `EventType` enum (e.g., a future protocol extension or custom type).
///
/// 2. **Unsupported Event Type**: The event type is recognized but no decoder handler
///    is registered for it in the decoder's registry (e.g., a known type that hasn't
///    been implemented yet).
///
/// ## Usage
///
/// ```swift
/// var config = AGUIEventDecoder.Configuration()
/// config.unknownEventStrategy = .returnUnknown
/// let decoder = AGUIEventDecoder(config: config)
///
/// let event = try decoder.decode(data)
/// if let unknown = event as? UnknownEvent {
///     print("Received unknown event type: \(unknown.typeRaw)")
///     // Access raw JSON for inspection or forwarding
///     if let rawData = unknown.rawEvent {
///         let json = try JSONSerialization.jsonObject(with: rawData)
///         // Handle or forward the unknown event
///     }
/// }
/// ```
///
/// ## Properties
///
/// - `typeRaw`: The raw string value of the "type" field from the JSON
/// - `rawEvent`: The complete original JSON data, preserved for inspection or forwarding
/// - `eventType`: Always returns `.raw` to indicate this is an unknown event
/// - `timestamp`: Always returns `nil` since unknown events cannot be parsed for timestamps
///
/// ## Forward Compatibility
///
/// Using `UnknownEvent` enables forward compatibility with protocol extensions. When
/// new event types are added to the AG-UI protocol, older SDK versions can still
/// receive and forward these events without crashing, even if they can't decode them.
///
/// - SeeAlso: `AGUIEventDecoder`, `EventDecodingError`, `EventType`
public struct UnknownEvent: AGUIEvent, Sendable {

    // MARK: - Properties

    /// The raw string value of the "type" field from the JSON event.
    ///
    /// This contains the exact type string as received from the agent, which may be:
    /// - A future event type not yet in the `EventType` enum
    /// - A custom event type defined by the agent implementation
    /// - A known event type that has no registered decoder handler
    public let typeRaw: String

    /// The complete original JSON data for this event.
    ///
    /// This preserves the full event payload, allowing you to:
    /// - Inspect the event structure for debugging
    /// - Forward the event to other systems that might understand it
    /// - Log the event for later analysis
    ///
    /// The data is guaranteed to be valid JSON (otherwise decoding would have failed earlier).
    public let rawEvent: Data?

    /// The type of this event (always `.raw`).
    ///
    /// Unknown events are categorized as `.raw` to distinguish them from
    /// properly decoded event types.
    public var eventType: EventType { .raw }

    /// Optional timestamp when the event occurred (always `nil`).
    ///
    /// Since unknown events cannot be fully decoded, timestamp information
    /// is not available. If you need the timestamp, you can parse the `rawEvent`
    /// JSON data directly.
    public var timestamp: Int64? { nil }

    // MARK: - Initialization

    /// Creates a new `UnknownEvent`.
    ///
    /// - Parameters:
    ///   - typeRaw: The raw string value of the "type" field from the JSON
    ///   - rawEvent: The complete original JSON data for this event
    public init(typeRaw: String, rawEvent: Data) {
        self.typeRaw = typeRaw
        self.rawEvent = rawEvent
    }
}
