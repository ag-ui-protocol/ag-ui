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

/// Convenience factory functions for creating pre-configured AG-UI agents.
///
/// These free functions mirror the `AgentBuilders` pattern from the Kotlin SDK,
/// providing a clean one-liner API for the most common agent configurations.
///
/// ## Examples
///
/// ```swift
/// // Bearer-token authenticated agent
/// let agent = agentWithBearer(url: agentURL, token: "sk-…")
///
/// // API-key authenticated agent
/// let agent = agentWithApiKey(url: agentURL, apiKey: "my-key")
///
/// // Agent with custom tool registry
/// let agent = agentWithTools(url: agentURL, registry: myRegistry)
///
/// // Stateful chat agent with a system prompt
/// let agent = chatAgent(url: agentURL, systemPrompt: "You are a helpful assistant.")
///
/// // Stateful agent with pre-seeded JSON state
/// let agent = statefulAgent(url: agentURL, initialState: Data("{\"mode\":\"creative\"}".utf8))
///
/// // Debug agent that logs verbose pipeline output
/// let agent = debugAgent(url: agentURL)
/// ```

// MARK: - Stateless agents

/// Creates a stateless ``AgUiAgent`` authenticated with a Bearer token.
///
/// The token is sent as `Authorization: Bearer <token>` on every request.
///
/// - Parameters:
///   - url: Base URL of the AG-UI agent server.
///   - token: The Bearer token string.
/// - Returns: A configured ``AgUiAgent``.
public func agentWithBearer(url: URL, token: String) -> AgUiAgent {
    AgUiAgent(url: url) { config in
        config.bearerToken = token
    }
}

/// Creates a stateless ``AgUiAgent`` authenticated with an API key.
///
/// - Parameters:
///   - url: Base URL of the AG-UI agent server.
///   - apiKey: The API key value.
///   - header: The HTTP header name (default: `"X-API-Key"`).
/// - Returns: A configured ``AgUiAgent``.
public func agentWithApiKey(url: URL, apiKey: String, header: String = "X-API-Key") -> AgUiAgent {
    AgUiAgent(url: url) { config in
        config.apiKey = apiKey
        config.apiKeyHeader = header
    }
}

/// Creates a stateless ``AgUiAgent`` backed by a tool registry.
///
/// Tool definitions are included in every `RunAgentInput` and tool calls from
/// the agent are executed automatically via ``ToolExecutionManager``.
///
/// - Parameters:
///   - url: Base URL of the AG-UI agent server.
///   - registry: The tool registry to use.
/// - Returns: A configured ``AgUiAgent``.
public func agentWithTools(url: URL, registry: any ToolRegistry) -> AgUiAgent {
    AgUiAgent(url: url) { config in
        config.toolRegistry = registry
    }
}

/// Creates a stateless ``AgUiAgent`` with verbose pipeline logging enabled.
///
/// - Parameter url: Base URL of the AG-UI agent server.
/// - Returns: A configured ``AgUiAgent`` with `debug = true`.
public func debugAgent(url: URL) -> AgUiAgent {
    AgUiAgent(url: url) { config in
        config.debug = true
    }
}

// MARK: - Stateful agents

/// Creates a ``StatefulAgUiAgent`` with a pre-configured system prompt.
///
/// The system prompt is prepended to every new thread's conversation history.
///
/// - Parameters:
///   - url: Base URL of the AG-UI agent server.
///   - systemPrompt: The system prompt text.
/// - Returns: A configured ``StatefulAgUiAgent``.
public func chatAgent(url: URL, systemPrompt: String) -> StatefulAgUiAgent {
    var config = StatefulAgUiAgentConfig(baseURL: url)
    config.systemPrompt = systemPrompt
    return StatefulAgUiAgent(configuration: config)
}

/// Creates a ``StatefulAgUiAgent`` with pre-seeded JSON state.
///
/// The initial state is sent on the first run and then updated by state events
/// from the agent server.
///
/// - Parameters:
///   - url: Base URL of the AG-UI agent server.
///   - initialState: The initial JSON state as `Data`.
/// - Returns: A configured ``StatefulAgUiAgent``.
public func statefulAgent(url: URL, initialState: State) -> StatefulAgUiAgent {
    var config = StatefulAgUiAgentConfig(baseURL: url)
    config.initialState = initialState
    return StatefulAgUiAgent(configuration: config)
}
