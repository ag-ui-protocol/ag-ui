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

/// Event containing a chunk of argument data for a tool call.
///
/// This event is emitted multiple times during tool call argument streaming, each time
/// containing a delta (incremental change) of argument data. The delta must be a
/// non-empty string. These events are associated with a tool call via the `toolCallId`
/// field, which matches the ID from the corresponding `ToolCallStartEvent`.
///
/// - SeeAlso: `ToolCallStartEvent`, `ToolCallEndEvent`, `ToolCallResultEvent`, `ToolCallChunkEvent`
public struct ToolCallArgsEvent: AGUIEvent, Equatable, Hashable, Sendable {

    // MARK: - Properties

    /// The unique identifier for this tool call.
    ///
    /// This ID matches the `toolCallId` from the corresponding `ToolCallStartEvent`
    /// and is used to associate this argument chunk with the correct tool call.
    public let toolCallId: String

    /// The argument data delta (incremental change).
    ///
    /// This is a non-empty string containing a chunk of the tool call arguments.
    /// Multiple `ToolCallArgsEvent` instances with the same `toolCallId`
    /// represent the complete arguments when concatenated.
    public let delta: String

    /// Optional timestamp when this argument chunk was received.
    ///
    /// Represented as milliseconds since Unix epoch.
    public let timestamp: Int64?

    /// Optional raw event data as received from the agent.
    public let rawEvent: Data?

    /// The type of this event (always `.toolCallArgs`).
    public var eventType: EventType { .toolCallArgs }

    // MARK: - Initialization

    /// Creates a new `ToolCallArgsEvent`.
    ///
    /// - Parameters:
    ///   - toolCallId: The unique identifier for this tool call (matches ToolCallStartEvent)
    ///   - delta: The argument data delta (must be non-empty)
    ///   - timestamp: Optional timestamp in milliseconds since epoch
    ///   - rawEvent: Optional raw event data as received from the agent
    public init(
        toolCallId: String,
        delta: String,
        timestamp: Int64? = nil,
        rawEvent: Data? = nil
    ) {
        self.toolCallId = toolCallId
        self.delta = delta
        self.timestamp = timestamp
        self.rawEvent = rawEvent
    }
}

// MARK: - CustomStringConvertible
extension ToolCallArgsEvent: CustomStringConvertible {
    public var description: String {
        "ToolCallArgsEvent(toolCallId: \(toolCallId), delta: \"\(delta)\", " +
        "timestamp: \(timestamp?.description ?? "nil"))"
    }
}

// MARK: - CustomDebugStringConvertible
extension ToolCallArgsEvent: CustomDebugStringConvertible {
    public var debugDescription: String {
        """
        ToolCallArgsEvent {
            toolCallId: "\(toolCallId)"
            delta: "\(delta)"
            timestamp: \(timestamp.map(String.init) ?? "nil")
            eventType: \(eventType.rawValue)
        }
        """
    }
}
