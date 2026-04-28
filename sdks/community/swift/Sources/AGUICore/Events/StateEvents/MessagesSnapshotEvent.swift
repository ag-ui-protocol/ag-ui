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

/// Event containing a complete snapshot of the conversation messages.
///
/// This event provides a full messages snapshot containing the entire conversation
/// history at a point in time. The messages are stored as raw JSON data to preserve
/// their exact structure and allow for flexible message schemas.
///
/// - SeeAlso: `StateSnapshotEvent`, `StateDeltaEvent`
public struct MessagesSnapshotEvent: AGUIEvent, Equatable, Sendable {

    // MARK: - Properties

    /// The complete messages snapshot as raw JSON data.
    ///
    /// This typically contains an array of message objects, but the structure is
    /// application-specific and can be any valid JSON value (array, object, etc.).
    /// Each message usually contains fields like id, role, content, and timestamp.
    ///
    /// To access the parsed messages, use `parsedMessages()` or parse the data
    /// using `JSONSerialization.jsonObject(with:)`.
    public let messages: Data

    /// Optional timestamp when the messages snapshot was captured.
    ///
    /// Represented as milliseconds since Unix epoch.
    public let timestamp: Int64?

    /// Optional raw event data as received from the agent.
    public let rawEvent: Data?

    /// The type of this event (always `.messagesSnapshot`).
    public var eventType: EventType { .messagesSnapshot }

    // MARK: - Initialization

    /// Creates a new `MessagesSnapshotEvent`.
    ///
    /// - Parameters:
    ///   - messages: The complete messages snapshot as raw JSON data
    ///   - timestamp: Optional timestamp in milliseconds since epoch
    ///   - rawEvent: Optional raw event data as received from the agent
    public init(
        messages: Data,
        timestamp: Int64? = nil,
        rawEvent: Data? = nil
    ) {
        self.messages = messages
        self.timestamp = timestamp
        self.rawEvent = rawEvent
    }

    // MARK: - Convenience Methods

    /// Parses the messages JSON data into a Swift object.
    ///
    /// This method uses `JSONSerialization` because the messages structure is
    /// application-specific and unknown at compile time. It can return any
    /// valid JSON value (typically an array of message objects, but could be
    /// an object with metadata, or other structures).
    ///
    /// For type-safe parsing when you know the messages structure, use
    /// `parsedMessages(as:)` instead.
    ///
    /// - Returns: The parsed JSON object (typically an array, but can be object or primitive)
    /// - Throws: An error if the messages data is not valid JSON
    public func parsedMessages() throws -> Any {
        try JSONSerialization.jsonObject(with: messages, options: .allowFragments)
    }

    /// Parses the messages JSON data into a strongly-typed Swift object.
    ///
    /// This method uses `Codable` for type-safe decoding when you know the
    /// expected structure of the messages. Use this when you have a specific
    /// type that conforms to `Decodable`.
    ///
    /// - Parameter type: The type to decode the messages as (must conform to `Decodable`)
    /// - Returns: A decoded instance of the specified type
    /// - Throws: A `DecodingError` if the messages cannot be decoded as the specified type
    ///
    /// Example:
    /// ```swift
    /// struct Message: Decodable {
    ///     let id: String
    ///     let role: String
    ///     let content: String
    /// }
    ///
    /// let messages = try event.parsedMessages(as: [Message].self)
    /// for message in messages {
    ///     print("\(message.role): \(message.content)")
    /// }
    /// ```
    public func parsedMessages<T: Decodable>(as type: T.Type, decoder: JSONDecoder = JSONDecoder()) throws -> T {
        try decoder.decode(type, from: messages)
    }
}

// MARK: - CustomStringConvertible
extension MessagesSnapshotEvent: CustomStringConvertible {
    public var description: String {
        let messagesSize = messages.count
        return "MessagesSnapshotEvent(messages: \(messagesSize) bytes, timestamp: \(timestamp?.description ?? "nil"))"
    }
}

// MARK: - CustomDebugStringConvertible
extension MessagesSnapshotEvent: CustomDebugStringConvertible {
    public var debugDescription: String {
        let messagesPreview: String
        if let jsonString = String(data: messages, encoding: .utf8) {
            let preview = String(jsonString.prefix(100))
            messagesPreview = jsonString.count > 100 ? "\(preview)..." : preview
        } else {
            messagesPreview = "\(messages.count) bytes (invalid UTF-8)"
        }

        return """
        MessagesSnapshotEvent {
            messages: \(messagesPreview)
            messagesSize: \(messages.count) bytes
            timestamp: \(timestamp.map(String.init) ?? "nil")
            eventType: \(eventType.rawValue)
        }
        """
    }
}
