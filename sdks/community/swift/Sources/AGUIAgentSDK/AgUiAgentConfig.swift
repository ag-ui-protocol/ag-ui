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
import AGUITools
import Foundation

/// Configuration for ``AgUiAgent``.
///
/// `AgUiAgentConfig` provides all options for a stateless AG-UI agent, including
/// authentication helpers, tool registry, per-request context, and timeout tuning.
///
/// ## Example
///
/// ```swift
/// let agent = AgUiAgent(url: agentURL) { config in
///     config.bearerToken = "sk-…"
///     config.systemPrompt = "You are a helpful assistant."
///     config.toolRegistry = myRegistry
/// }
/// ```
///
/// ## Auth Convenience
///
/// Setting `bearerToken` or `apiKey` automatically merges the corresponding header
/// into the final header dictionary via ``buildHeaders()``. Explicit entries in
/// ``headers`` take precedence over auto-generated auth headers.
///
/// - SeeAlso: ``AgUiAgent``, ``AgentBuilders``
public struct AgUiAgentConfig: Sendable {

    // MARK: - Auth

    /// Bearer token for authentication.
    ///
    /// When set, ``buildHeaders()`` includes `Authorization: Bearer <token>`.
    ///
    /// Default: `nil`
    public var bearerToken: String?

    /// API key value.
    ///
    /// Used together with ``apiKeyHeader`` by ``buildHeaders()``.
    ///
    /// Default: `nil`
    public var apiKey: String?

    /// Header name for the API key.
    ///
    /// Default: `"X-API-Key"`
    public var apiKeyHeader: String

    // MARK: - HTTP

    /// Arbitrary HTTP headers included in every request.
    ///
    /// These override auto-generated auth headers when the same key appears.
    ///
    /// Default: `[:]`
    public var headers: [String: String]

    /// Request (read) timeout in seconds.
    ///
    /// Default: `600`
    public var requestTimeout: TimeInterval

    /// Connection timeout in seconds.
    ///
    /// Default: `30`
    public var connectTimeout: TimeInterval

    // MARK: - Agent behaviour

    /// Optional system prompt prepended to each call's message list.
    ///
    /// Default: `nil`
    public var systemPrompt: String?

    /// When `true`, enables verbose pipeline logging.
    ///
    /// Default: `false`
    public var debug: Bool

    // MARK: - Tools & Context

    /// Optional tool registry.
    ///
    /// When set, tool definitions are included in every `RunAgentInput` and
    /// tool calls from the agent are executed automatically via
    /// ``ToolExecutionManager``.
    ///
    /// Default: `nil`
    public var toolRegistry: (any ToolRegistry)?

    /// Persistent user ID that can be used for attribution or routing.
    ///
    /// Default: `nil`
    public var userId: String?

    /// Context items included with every request.
    ///
    /// Default: `[]`
    public var context: [Context]

    /// Forwarded properties included in every `RunAgentInput` as JSON.
    ///
    /// Default: `{}`
    public var forwardedProps: State

    // MARK: - Initialization

    /// Creates a new `AgUiAgentConfig` with default values.
    public init() {
        bearerToken = nil
        apiKey = nil
        apiKeyHeader = "X-API-Key"
        headers = [:]
        requestTimeout = 600
        connectTimeout = 30
        systemPrompt = nil
        debug = false
        toolRegistry = nil
        userId = nil
        context = []
        forwardedProps = Data("{}".utf8)
    }

    // MARK: - Header builder

    /// Builds the final HTTP header dictionary by merging auth helpers into ``headers``.
    ///
    /// Priority (highest → lowest):
    /// 1. Entries already in ``headers``
    /// 2. `bearerToken` → `Authorization: Bearer <token>`
    /// 3. `apiKey` → `<apiKeyHeader>: <key>`
    ///
    /// - Returns: Merged header dictionary ready for `HttpAgentConfiguration`.
    public func buildHeaders() -> [String: String] {
        var result: [String: String] = [:]

        // Low-priority auth headers first
        if let key = apiKey {
            result[apiKeyHeader] = key
        }
        if let token = bearerToken {
            result["Authorization"] = "Bearer \(token)"
        }

        // User-supplied headers override auth helpers
        for (k, v) in headers {
            result[k] = v
        }

        return result
    }
}
