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

// MARK: - AgentConfig

/// Base configuration for AG-UI agents.
public struct AgentConfig: Sendable {
    /// Optional agent identifier for logging and tracking.
    public var agentId: String?
    /// Textual description of the agent's purpose.
    public var description: String
    /// Default thread ID used when none is specified.
    public var threadId: String
    /// Initial messages prepended to every run.
    public var initialMessages: [any Message]
    /// Initial JSON state.
    public var initialState: State
    /// When `true`, logs verbose pipeline output.
    public var debug: Bool

    public init(
        agentId: String? = nil,
        description: String = "",
        threadId: String = "default",
        initialMessages: [any Message] = [],
        initialState: State = Data("{}".utf8),
        debug: Bool = false
    ) {
        self.agentId = agentId
        self.description = description
        self.threadId = threadId
        self.initialMessages = initialMessages
        self.initialState = initialState
        self.debug = debug
    }
}

// MARK: - HttpAgentConfig

/// HTTP-specific agent configuration.
public struct HttpAgentConfig: Sendable {
    /// Base agent configuration.
    public var base: AgentConfig
    /// The agent endpoint URL string.
    public var url: String
    /// Custom HTTP headers.
    public var headers: [String: String]
    /// Request timeout in seconds. Default: 600.
    public var requestTimeout: TimeInterval
    /// Connection timeout in seconds. Default: 30.
    public var connectTimeout: TimeInterval
    /// Bearer token — automatically added as `Authorization: Bearer <token>`.
    public var bearerToken: String? {
        didSet {
            if let token = bearerToken {
                headers["Authorization"] = "Bearer \(token)"
            }
        }
    }
    /// API key value.
    public var apiKey: String?
    /// Header name for the API key. Default: "X-API-Key".
    public var apiKeyHeader: String

    public init(url: String, base: AgentConfig = AgentConfig()) {
        self.base = base
        self.url = url
        self.headers = [:]
        self.requestTimeout = 600
        self.connectTimeout = 30
        self.bearerToken = nil
        self.apiKey = nil
        self.apiKeyHeader = "X-API-Key"
    }
}

// MARK: - RunAgentParameters

/// Parameters for a single agent run.
public struct RunAgentParameters: Sendable {
    public var runId: String?
    public var tools: [Tool]?
    public var context: [Context]?
    public var forwardedProps: State?

    public init(
        runId: String? = nil,
        tools: [Tool]? = nil,
        context: [Context]? = nil,
        forwardedProps: State? = nil
    ) {
        self.runId = runId
        self.tools = tools
        self.context = context
        self.forwardedProps = forwardedProps
    }
}
