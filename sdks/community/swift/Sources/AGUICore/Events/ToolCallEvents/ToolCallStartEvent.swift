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

/// Event indicating that a tool call has started.
///
/// This event is emitted when an agent begins invoking a tool. It provides the
/// tool call identifier and name that will be used to associate subsequent
/// argument chunks, the result, and the end event with this tool call.
///
/// - SeeAlso: `ToolCallArgsEvent`, `ToolCallEndEvent`, `ToolCallResultEvent`, `ToolCallChunkEvent`
public struct ToolCallStartEvent: AGUIEvent, Equatable, Hashable, Sendable {

    // MARK: - Properties

    /// The unique identifier for this tool call.
    ///
    /// This ID is used to associate argument chunks, the result, and the end event
    /// with this specific tool call instance.
    public let toolCallId: String

    /// The name of the tool being called.
    ///
    /// This identifies which tool function is being invoked.
    public let toolCallName: String

    /// Optional identifier of the parent message.
    ///
    /// If provided, this associates the tool call with a specific message
    /// in the conversation.
    public let parentMessageId: String?

    /// Optional timestamp when the tool call started.
    ///
    /// Represented as milliseconds since Unix epoch.
    public let timestamp: Int64?

    /// Optional raw event data as received from the agent.
    public let rawEvent: Data?

    /// The type of this event (always `.toolCallStart`).
    public var eventType: EventType { .toolCallStart }

    // MARK: - Initialization

    /// Creates a new `ToolCallStartEvent`.
    ///
    /// - Parameters:
    ///   - toolCallId: The unique identifier for this tool call
    ///   - toolCallName: The name of the tool being called
    ///   - parentMessageId: Optional identifier of the parent message
    ///   - timestamp: Optional timestamp in milliseconds since epoch
    ///   - rawEvent: Optional raw event data as received from the agent
    public init(
        toolCallId: String,
        toolCallName: String,
        parentMessageId: String? = nil,
        timestamp: Int64? = nil,
        rawEvent: Data? = nil
    ) {
        self.toolCallId = toolCallId
        self.toolCallName = toolCallName
        self.parentMessageId = parentMessageId
        self.timestamp = timestamp
        self.rawEvent = rawEvent
    }
}

// MARK: - CustomStringConvertible
extension ToolCallStartEvent: CustomStringConvertible {
    public var description: String {
        "ToolCallStartEvent(toolCallId: \(toolCallId), toolCallName: \(toolCallName), " +
        "parentMessageId: \(parentMessageId ?? "nil"), " +
        "timestamp: \(timestamp?.description ?? "nil"))"
    }
}

// MARK: - CustomDebugStringConvertible
extension ToolCallStartEvent: CustomDebugStringConvertible {
    public var debugDescription: String {
        """
        ToolCallStartEvent {
            toolCallId: "\(toolCallId)"
            toolCallName: "\(toolCallName)"
            parentMessageId: \(parentMessageId.map { "\"\($0)\"" } ?? "nil")
            timestamp: \(timestamp.map(String.init) ?? "nil")
            eventType: \(eventType.rawValue)
        }
        """
    }
}
