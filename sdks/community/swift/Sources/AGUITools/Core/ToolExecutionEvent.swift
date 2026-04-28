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

/// Events emitted during the tool execution lifecycle.
///
/// Observe these to monitor tool execution progress for logging, metrics,
/// or UI feedback.
public enum ToolExecutionEvent: Sendable {
    /// Tool call received and queued for execution.
    case started(toolCallId: String, toolName: String)
    /// Tool is actively running.
    case executing(toolCallId: String, toolName: String)
    /// Tool completed successfully.
    case succeeded(toolCallId: String, toolName: String, result: ToolExecutionResult)
    /// Tool failed (either not found or threw an error).
    case failed(toolCallId: String, toolName: String, error: String)

    public var toolCallId: String {
        switch self {
        case .started(let id, _), .executing(let id, _), .succeeded(let id, _, _), .failed(let id, _, _):
            return id
        }
    }

    public var toolName: String {
        switch self {
        case .started(_, let n), .executing(_, let n), .succeeded(_, let n, _), .failed(_, let n, _):
            return n
        }
    }
}
