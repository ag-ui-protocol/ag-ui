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

/// Represents a parsed Server-Sent Event.
///
/// Server-Sent Events (SSE) is a standard for server-to-client streaming
/// over HTTP. Each event can contain data, an ID for reconnection, and an
/// event type.
///
/// ## SSE Format
///
/// ```
/// event: notification
/// id: 123
/// data: {"message":"hello"}
///
/// ```
///
/// ## Example
///
/// ```swift
/// let event = SseEvent(
///     data: "{\"type\":\"MESSAGE\"}",
///     id: "123",
///     event: "message"
/// )
/// ```
///
/// ## Reference
///
/// SSE specification: https://html.spec.whatwg.org/multipage/server-sent-events.html
public struct SseEvent: Sendable, Equatable {
    /// The event data payload.
    ///
    /// Multiple `data:` fields in an SSE event are concatenated with newlines.
    /// This field contains the raw string data, typically JSON for AG-UI events.
    public let data: String

    /// Optional event ID for reconnection.
    ///
    /// The `id:` field in SSE events is used to track the last received event.
    /// When reconnecting, the client can send `Last-Event-ID` header to resume
    /// from the last processed event.
    public let id: String?

    /// Event type name.
    ///
    /// Defaults to `"message"` if not specified in the SSE stream.
    /// The `event:` field allows distinguishing different event types.
    public let event: String

    /// Creates a new SSE event.
    ///
    /// - Parameters:
    ///   - data: The event data payload
    ///   - id: Optional event ID (default: nil)
    ///   - event: Event type name (default: "message")
    public init(data: String, id: String? = nil, event: String = "message") {
        self.data = data
        self.id = id
        self.event = event
    }
}
