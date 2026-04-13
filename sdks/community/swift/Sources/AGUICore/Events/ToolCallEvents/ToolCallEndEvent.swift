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

/// Event indicating that a tool call has completed.
///
/// This event is emitted when an agent finishes invoking a tool. It signals the end
/// of the tool call process and is associated with the tool call via the `toolCallId`
/// field, which matches the ID from the corresponding `ToolCallStartEvent`.
///
/// - SeeAlso: `ToolCallStartEvent`, `ToolCallArgsEvent`, `ToolCallResultEvent`, `ToolCallChunkEvent`
public struct ToolCallEndEvent: AGUIEvent, Equatable, Hashable, Sendable {

    // MARK: - Properties

    /// The unique identifier for this tool call.
    ///
    /// This ID matches the `toolCallId` from the corresponding `ToolCallStartEvent`
    /// and is used to associate this end event with the correct tool call.
    public let toolCallId: String

    /// Optional timestamp when the tool call finished.
    ///
    /// Represented as milliseconds since Unix epoch.
    public let timestamp: Int64?

    /// Optional raw event data as received from the agent.
    public let rawEvent: Data?

    /// The type of this event (always `.toolCallEnd`).
    public var eventType: EventType { .toolCallEnd }

    // MARK: - Initialization

    /// Creates a new `ToolCallEndEvent`.
    ///
    /// - Parameters:
    ///   - toolCallId: The unique identifier for this tool call (matches ToolCallStartEvent)
    ///   - timestamp: Optional timestamp in milliseconds since epoch
    ///   - rawEvent: Optional raw event data as received from the agent
    public init(
        toolCallId: String,
        timestamp: Int64? = nil,
        rawEvent: Data? = nil
    ) {
        self.toolCallId = toolCallId
        self.timestamp = timestamp
        self.rawEvent = rawEvent
    }
}

// MARK: - CustomStringConvertible
extension ToolCallEndEvent: CustomStringConvertible {
    public var description: String {
        "ToolCallEndEvent(toolCallId: \(toolCallId), timestamp: \(timestamp?.description ?? "nil"))"
    }
}

// MARK: - CustomDebugStringConvertible
extension ToolCallEndEvent: CustomDebugStringConvertible {
    public var debugDescription: String {
        """
        ToolCallEndEvent {
            toolCallId: "\(toolCallId)"
            timestamp: \(timestamp.map(String.init) ?? "nil")
            eventType: \(eventType.rawValue)
        }
        """
    }
}
