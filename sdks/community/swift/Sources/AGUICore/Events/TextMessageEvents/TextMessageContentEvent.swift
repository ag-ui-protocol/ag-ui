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

/// Event containing a chunk of text content for a message.
///
/// This event is emitted multiple times during message generation, each time
/// containing a delta (incremental change) of text content. The delta must
/// be a non-empty string. These events are associated with a message via the
/// `messageId` field, which matches the ID from the corresponding
/// `TextMessageStartEvent`.
///
/// - SeeAlso: `TextMessageStartEvent`, `TextMessageEndEvent`, `TextMessageChunkEvent`
public struct TextMessageContentEvent: AGUIEvent, Equatable, Hashable, Sendable {

    // MARK: - Properties

    /// The unique identifier for this message.
    ///
    /// This ID matches the `messageId` from the corresponding `TextMessageStartEvent`
    /// and is used to associate this content chunk with the correct message.
    public let messageId: String

    /// The text content delta (incremental change).
    ///
    /// This is a non-empty string containing a chunk of the message content.
    /// Multiple `TextMessageContentEvent` instances with the same `messageId`
    /// represent the complete message when concatenated.
    public let delta: String

    /// Optional timestamp when this content chunk was received.
    ///
    /// Represented as milliseconds since Unix epoch.
    public let timestamp: Int64?

    /// Optional raw event data as received from the agent.
    public let rawEvent: Data?

    /// The type of this event (always `.textMessageContent`).
    public var eventType: EventType { .textMessageContent }

    // MARK: - Initialization

    /// Creates a new `TextMessageContentEvent`.
    ///
    /// - Parameters:
    ///   - messageId: The unique identifier for this message (matches TextMessageStartEvent)
    ///   - delta: The text content delta (must be non-empty)
    ///   - timestamp: Optional timestamp in milliseconds since epoch
    ///   - rawEvent: Optional raw event data as received from the agent
    public init(
        messageId: String,
        delta: String,
        timestamp: Int64? = nil,
        rawEvent: Data? = nil
    ) {
        self.messageId = messageId
        self.delta = delta
        self.timestamp = timestamp
        self.rawEvent = rawEvent
    }
}

// MARK: - CustomStringConvertible
extension TextMessageContentEvent: CustomStringConvertible {
    public var description: String {
        "TextMessageContentEvent(messageId: \(messageId), delta: \"\(delta)\", " +
        "timestamp: \(timestamp?.description ?? "nil"))"
    }
}

// MARK: - CustomDebugStringConvertible
extension TextMessageContentEvent: CustomDebugStringConvertible {
    public var debugDescription: String {
        """
        TextMessageContentEvent {
            messageId: "\(messageId)"
            delta: "\(delta)"
            timestamp: \(timestamp.map(String.init) ?? "nil")
            eventType: \(eventType.rawValue)
        }
        """
    }
}
