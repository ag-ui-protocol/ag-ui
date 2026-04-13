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

// MARK: - Core Tool Execution Framework

// Core types are defined in:
// - Core/ToolExecutionResult.swift
// - Core/ToolExecutionContext.swift
// - Core/ToolExecutor.swift

// MARK: - Legacy Placeholder (Deprecated)

/// AGUITools provides the tool execution framework for AG-UI agents.
///
/// The AGUITools module provides a comprehensive framework for:
/// - Defining and registering tool executors
/// - Executing tool calls from agents
/// - Managing tool lifecycle and error handling
/// - Circuit breaker patterns for reliability
///
/// ## Core Components
///
/// - ``ToolExecutor``: Protocol for implementing tool executors
/// - ``ToolExecutionResult``: Result type for tool executions
/// - ``ToolExecutionContext``: Context provided to tool executors
/// - ``ToolRegistry``: Registry for managing and executing tools
/// - ``ToolExecutionManager``: Manages tool execution lifecycle
///
/// ## Usage Example
///
/// ```swift
/// // Define a tool executor
/// actor MyToolExecutor: ToolExecutor {
///     let tool = Tool(name: "my_tool", description: "...", parameters: ...)
///
///     func execute(context: ToolExecutionContext) async throws -> ToolExecutionResult {
///         // Your tool implementation
///         return .success(message: "Done")
///     }
/// }
///
/// // Register and use with a tool registry
/// let registry = DefaultToolRegistry()
/// await registry.register(executor: MyToolExecutor())
/// ```
@available(*, deprecated, message: "Use ToolExecutor protocol and related types directly")
public struct AGUITools {
    private let core: AGUICore

    public init() {
        self.core = AGUICore()
    }

    /// Legacy tools functionality example
    @available(*, deprecated, message: "Use ToolExecutor protocol instead")
    public func toolsFunction() -> String {
        "AGUITools is working with \(core.coreFunction())"
    }
}
