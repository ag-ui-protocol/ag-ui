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

import AGUITools
import Foundation

// MARK: - ChatAppToolRegistry

/// Factory for the ChatApp tool registry.
///
/// Creates and configures a `DefaultToolRegistry` with all client-side tool
/// executors registered. Callers provide callbacks for side effects (e.g.
/// background colour updates) to keep executors decoupled from the store.
enum ChatAppToolRegistry {

    /// Builds and returns a fully configured tool registry.
    ///
    /// - Parameter onBackground: Async closure invoked when the agent calls
    ///   `change_background`. Receives the raw hex string from the tool arguments.
    /// - Returns: A `ToolRegistry` with `change_background` registered.
    /// - Throws: `ToolRegistryError` if registration fails.
    static func makeRegistry(
        onBackground: @escaping @Sendable (String) async -> Void
    ) async throws -> any ToolRegistry {
        let registry = DefaultToolRegistry()
        let executor = ChangeBackgroundToolExecutor(onBackground: onBackground)
        try await registry.register(executor: executor)
        return registry
    }
}
