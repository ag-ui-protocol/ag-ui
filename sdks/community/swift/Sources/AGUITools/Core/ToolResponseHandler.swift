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

import AGUICore
import Foundation

/// Contract for sending tool execution results back to the agent.
///
/// Conforming types deliver `ToolMessage` responses to whatever transport
/// the agent uses (HTTP, WebSocket, in-process, etc.).
public protocol ToolResponseHandler: Sendable {
    /// Sends a tool response message back to the agent.
    ///
    /// - Parameters:
    ///   - message: The completed tool message to send
    ///   - threadId: The conversation thread ID (may be nil)
    ///   - runId: The run ID this response belongs to (may be nil)
    func sendToolResponse(
        _ message: ToolMessage,
        threadId: String?,
        runId: String?
    ) async throws
}

/// No-op implementation that discards all tool responses.
///
/// Useful for testing or when tool responses are not needed.
public struct NullToolResponseHandler: ToolResponseHandler {
    public init() {}
    public func sendToolResponse(_ message: ToolMessage, threadId: String?, runId: String?) async throws {}
}
