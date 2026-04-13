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

/// Enumeration of all event types in the AG-UI protocol that can be received from or sent to an AG-UI agent.
///
/// Each case corresponds to a specific event type in the protocol specification.
/// The raw value is the exact string used in the JSON "type" field.
///
/// ## Event Categories
/// - **Lifecycle**: `runStarted`, `runFinished`, `runError`, `stepStarted`, `stepFinished`
/// - **Text Messages**: `textMessageStart`, `textMessageContent`, `textMessageEnd`, `textMessageChunk`
/// - **Tool Calls**: `toolCallStart`, `toolCallArgs`, `toolCallEnd`, `toolCallResult`, `toolCallChunk`
/// - **State**: `stateSnapshot`, `stateDelta`, `messagesSnapshot`
/// - **Thinking**: `thinkingStart`, `thinkingEnd`, `thinkingTextMessageStart`, `thinkingTextMessageContent`, `thinkingTextMessageEnd`
/// - **Activity**: `activitySnapshot`, `activityDelta`
/// - **Special**: `raw`, `custom`

@frozen
public enum EventType: String, Codable, CaseIterable, Sendable {
    // MARK: - Lifecycle Events (5)

    /// Agent run has started
    case runStarted = "RUN_STARTED"

    /// Agent run has completed successfully
    case runFinished = "RUN_FINISHED"

    /// Agent run encountered an error
    case runError = "RUN_ERROR"

    /// Agent step has started
    case stepStarted = "STEP_STARTED"

    /// Agent step has finished
    case stepFinished = "STEP_FINISHED"

    // MARK: - Text Message Events (4)

    /// Text message generation started
    case textMessageStart = "TEXT_MESSAGE_START"

    /// Text message content received
    case textMessageContent = "TEXT_MESSAGE_CONTENT"

    /// Text message generation finished
    case textMessageEnd = "TEXT_MESSAGE_END"

    /// Chunk of text message received
    case textMessageChunk = "TEXT_MESSAGE_CHUNK"

    // MARK: - Tool Call Events (5)

    /// Tool call started
    case toolCallStart = "TOOL_CALL_START"

    /// Tool call arguments received
    case toolCallArgs = "TOOL_CALL_ARGS"

    /// Tool call finished
    case toolCallEnd = "TOOL_CALL_END"

    /// Tool call result received
    case toolCallResult = "TOOL_CALL_RESULT"

    /// Chunk of tool call data received
    case toolCallChunk = "TOOL_CALL_CHUNK"

    // MARK: - State Management Events (3)

    /// State snapshot received
    case stateSnapshot = "STATE_SNAPSHOT"

    /// Incremental state update received
    case stateDelta = "STATE_DELTA"

    /// Messages snapshot received
    case messagesSnapshot = "MESSAGES_SNAPSHOT"

    // MARK: - Thinking Events (5)

    /// Thinking phase started
    case thinkingStart = "THINKING_START"

    /// Thinking phase ended
    case thinkingEnd = "THINKING_END"

    /// Thinking text message generation started
    case thinkingTextMessageStart = "THINKING_TEXT_MESSAGE_START"

    /// Thinking text message content received
    case thinkingTextMessageContent = "THINKING_TEXT_MESSAGE_CONTENT"

    /// Thinking text message generation finished
    case thinkingTextMessageEnd = "THINKING_TEXT_MESSAGE_END"

    // MARK: - Special Events (2)

    /// Raw untyped event
    case raw = "RAW"

    /// Custom event type
    case custom = "CUSTOM"

    // MARK: - Activity Events (2)

    /// Activity snapshot received
    case activitySnapshot = "ACTIVITY_SNAPSHOT"

    /// Incremental activity update received
    case activityDelta = "ACTIVITY_DELTA"
}
