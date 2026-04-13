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

/// A message containing the AI agent's responses.
///
/// Assistant messages represent the agent's output, which can include:
/// - **Text content**: Responses, explanations, questions to the user
/// - **Tool calls**: Requests to execute external functions
/// - **Mixed content**: Text combined with tool calls for explained actions
///
/// ## Content Types
///
/// Assistant messages can contain:
/// 1. **Text only**: Simple responses without tool invocations
/// 2. **Tool calls only**: Silent function invocations without explanation
/// 3. **Text + tool calls**: Explained actions combining both
///
/// ## Streaming Construction
///
/// Assistant messages may be built incrementally through streaming events:
/// 1. Start with basic structure (id, role)
/// 2. Add text content through TextMessageContent events
/// 3. Add tool calls through ToolCallStart/Args/End events
/// 4. Complete with TextMessageEnd or ToolCallEnd events
///
/// ## Example
///
/// ```swift
/// // Simple text response
/// let textResponse = AssistantMessage(
///     id: "asst-1",
///     content: "I understand your question. Let me explain..."
/// )
///
/// // Tool call with explanation
/// let weatherCall = ToolCall(
///     id: "call_weather",
///     function: FunctionCall(
///         name: "get_current_weather",
///         arguments: "{\"location\":\"San Francisco\"}"
///     )
/// )
///
/// let toolResponse = AssistantMessage(
///     id: "asst-2",
///     content: "Let me check the weather for you.",
///     toolCalls: [weatherCall]
/// )
///
/// // Multiple simultaneous tool calls
/// let multiToolResponse = AssistantMessage(
///     id: "asst-3",
///     content: "Gathering information from multiple sources...",
///     toolCalls: [
///         ToolCall(...),
///         ToolCall(...),
///         ToolCall(...)
///     ]
/// )
/// ```
///
/// ## Tool Call Flow
///
/// When an assistant message includes tool calls:
/// 1. Assistant creates message with toolCalls array
/// 2. Tool system executes each tool call
/// 3. Results returned in ``ToolMessage`` instances with matching toolCallId
/// 4. Assistant processes results and continues conversation
///
/// - SeeAlso: ``Message``, ``ToolCall``, ``ToolMessage``
public struct AssistantMessage: Message, Sendable, Hashable {
    /// Unique identifier for this message.
    public let id: String

    /// The role of this message (always `.assistant`).
    public let role: Role

    /// The agent's text response.
    ///
    /// This content is optional because:
    /// - The message may contain only tool calls without explanatory text
    /// - Streaming messages start with structure before content arrives
    /// - Tool-only operations may not require text explanation
    public let content: String?

    /// Optional identifier for the assistant.
    ///
    /// This can distinguish between different assistant personas, modes,
    /// or variants in multi-agent systems.
    public let name: String?

    /// Optional array of tool calls the assistant is requesting.
    ///
    /// When present, indicates the assistant wants to execute one or more
    /// external functions. Each tool call has a unique ID that will be
    /// referenced in the corresponding ``ToolMessage`` response.
    ///
    /// Tool calls may be executed:
    /// - Sequentially (one after another)
    /// - In parallel (multiple simultaneous calls)
    /// - Conditionally (based on previous results)
    public let toolCalls: [ToolCall]?

    /// Creates a new assistant message.
    ///
    /// - Parameters:
    ///   - id: Unique identifier for this message
    ///   - content: The agent's text response (optional)
    ///   - name: Optional identifier for the assistant
    ///   - toolCalls: Optional array of tool calls to execute
    public init(
        id: String,
        content: String? = nil,
        name: String? = nil,
        toolCalls: [ToolCall]? = nil
    ) {
        self.id = id
        self.role = .assistant
        self.content = content
        self.name = name
        self.toolCalls = toolCalls
    }
}
