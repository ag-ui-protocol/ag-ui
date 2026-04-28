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

import AGUIClient
import AGUICore
import AGUITools
import Foundation

/// HTTP implementation of `ToolResponseHandler`.
///
/// Sends tool results back to the agent by initiating a new run containing
/// only the tool result message. This mirrors the Kotlin `ClientToolResponseHandler`.
///
/// ## How it works
///
/// When a tool call completes, the result must be delivered back to the agent
/// so it can continue the conversation. `ClientToolResponseHandler` does this
/// by constructing a minimal `RunAgentInput` containing the `ToolMessage` and
/// executing a new run through the same `HttpAgent`. The resulting events are
/// consumed and discarded — callers receive the results through the ongoing
/// conversation stream, not here.
///
/// ## Example
///
/// ```swift
/// let httpAgent = HttpAgent(baseURL: agentURL)
/// let handler = ClientToolResponseHandler(httpAgent: httpAgent)
/// let manager = ToolExecutionManager(
///     toolRegistry: registry,
///     responseHandler: handler
/// )
/// ```
public final class ClientToolResponseHandler: ToolResponseHandler, @unchecked Sendable {

    private let httpAgent: HttpAgent

    /// Creates a handler that routes tool responses through the given agent.
    ///
    /// - Parameter httpAgent: The HTTP agent used to deliver tool results
    public init(httpAgent: HttpAgent) {
        self.httpAgent = httpAgent
    }

    public func sendToolResponse(
        _ message: ToolMessage,
        threadId: String?,
        runId: String?
    ) async throws {
        let input = RunAgentInput(
            threadId: threadId ?? "tool_\(UUID().uuidString)",
            runId: runId ?? "run_\(UUID().uuidString)",
            messages: [message]
        )
        // Drive the full pipeline; discard resulting events.
        // Use the AbstractAgent pipeline override (run(input:) with external label).
        for try await _ in httpAgent.run(input: input) { }
    }
}
