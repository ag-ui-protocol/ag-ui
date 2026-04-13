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

/// Stateless AG-UI agent providing a simple `sendMessage` API.
///
/// `AgUiAgent` is a convenience wrapper around `HttpAgent` for cases where no
/// persistent conversation history is needed. Each call to ``sendMessage(_:threadId:state:includeSystemPrompt:)``
/// builds a fresh `RunAgentInput` from scratch — callers manage history externally.
///
/// ## Basic Usage
///
/// ```swift
/// let agent = AgUiAgent(url: URL(string: "https://agent.example.com")!)
///
/// let stream = agent.sendMessage("Hello!")
/// for try await event in stream {
///     if let chunk = event as? TextMessageChunkEvent {
///         print(chunk.delta ?? "", terminator: "")
///     }
/// }
/// ```
///
/// ## Authentication
///
/// ```swift
/// let agent = AgUiAgent(url: agentURL) { config in
///     config.bearerToken = "sk-…"
/// }
/// ```
///
/// ## With Tools
///
/// ```swift
/// let agent = AgUiAgent(url: agentURL) { config in
///     config.toolRegistry = myToolRegistry
///     config.systemPrompt = "You can use tools to help users."
/// }
/// ```
///
/// ## Subclassing
///
/// Override ``run(input:)`` to customise transport (e.g. WebSocket, mock):
///
/// ```swift
/// final class MockAgent: AgUiAgent {
///     override func run(input: RunAgentInput) -> AsyncThrowingStream<any AGUIEvent, Error> {
///         // return test events
///     }
/// }
/// ```
///
/// - SeeAlso: ``AgUiAgentConfig``, ``StatefulAgUiAgent``, ``AgentBuilders``
open class AgUiAgent: @unchecked Sendable {

    // MARK: - Public properties

    /// The resolved configuration for this agent.
    public let config: AgUiAgentConfig

    // MARK: - Private state

    private let httpAgent: HttpAgent
    private let toolExecutionManager: ToolExecutionManager?

    // MARK: - Initialization

    /// Creates an agent pointing at `url`, optionally configured via a closure.
    ///
    /// - Parameters:
    ///   - url: Base URL of the AG-UI agent server.
    ///   - configure: Closure for customising ``AgUiAgentConfig`` before the agent is created.
    ///                Defaults to a no-op (all defaults apply).
    public init(
        url: URL,
        configure: (inout AgUiAgentConfig) -> Void = { _ in }
    ) {
        var cfg = AgUiAgentConfig()
        configure(&cfg)
        self.config = cfg

        var httpConfig = HttpAgentConfiguration(baseURL: url)
        httpConfig.timeout = cfg.requestTimeout
        httpConfig.headers = cfg.buildHeaders()

        let agent = HttpAgent(configuration: httpConfig)
        self.httpAgent = agent

        if let registry = cfg.toolRegistry {
            self.toolExecutionManager = ToolExecutionManager(
                toolRegistry: registry,
                responseHandler: ClientToolResponseHandler(httpAgent: agent)
            )
        } else {
            self.toolExecutionManager = nil
        }
    }

    // MARK: - Core run method (overrideable)

    /// Returns a raw event stream for the given input.
    ///
    /// The default implementation delegates to the internal `HttpAgent`.
    /// Override this in subclasses to replace the transport (e.g. for testing).
    ///
    /// - Parameter input: The run agent input.
    /// - Returns: An `AsyncThrowingStream` of raw AG-UI events.
    open func run(input: RunAgentInput) -> AsyncThrowingStream<any AGUIEvent, Error> {
        httpAgent.run(input: input)
    }

    // MARK: - sendMessage (primary API)

    /// Sends a single message and returns the resulting event stream.
    ///
    /// Each call builds a fresh `RunAgentInput` — no history is carried between calls.
    /// An optional system prompt is prepended as the first message when `includeSystemPrompt`
    /// is `true` and ``AgUiAgentConfig/systemPrompt`` is set.
    ///
    /// - Parameters:
    ///   - message: The user message text.
    ///   - threadId: Conversation thread ID (default: a new UUID per call).
    ///   - state: Optional JSON state to include (default: `{}`).
    ///   - includeSystemPrompt: When `true` and a system prompt is configured, it is added
    ///                           as the first message (default: `true`).
    /// - Returns: An `AsyncThrowingStream` of AG-UI events.
    open func sendMessage(
        _ message: String,
        threadId: String = UUID().uuidString,
        state: State? = nil,
        includeSystemPrompt: Bool = true
    ) -> AsyncThrowingStream<any AGUIEvent, Error> {
        AsyncThrowingStream { continuation in
            Task {
                do {
                    // Build message list (no history — stateless per call)
                    var messages: [any Message] = []

                    if includeSystemPrompt, let prompt = self.config.systemPrompt {
                        messages.append(SystemMessage(
                            id: "sys_\(UUID().uuidString)",
                            content: prompt
                        ))
                    }

                    messages.append(UserMessage(
                        id: "usr_\(UUID().uuidString)",
                        content: message
                    ))

                    // Resolve tool definitions from the registry
                    var tools: [Tool] = []
                    if let registry = self.config.toolRegistry {
                        tools = await registry.allTools()
                    }

                    let input = RunAgentInput(
                        threadId: threadId,
                        runId: "run_\(UUID().uuidString)",
                        state: state ?? Data("{}".utf8),
                        messages: messages,
                        tools: tools,
                        context: self.config.context,
                        forwardedProps: self.config.forwardedProps
                    )

                    // Route through ToolExecutionManager when a registry is configured
                    let rawStream = self.run(input: input)

                    if let manager = self.toolExecutionManager {
                        let managed = await manager.processEventStream(
                            rawStream,
                            threadId: input.threadId,
                            runId: input.runId
                        )
                        for try await event in managed {
                            continuation.yield(event)
                        }
                    } else {
                        for try await event in rawStream {
                            continuation.yield(event)
                        }
                    }

                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
        }
    }

    // MARK: - Subscriber

    /// Subscribes to lifecycle events from the underlying `HttpAgent`.
    ///
    /// - Parameter subscriber: The subscriber to register.
    /// - Returns: A subscription handle that can be used to unsubscribe.
    public func subscribe(_ subscriber: any AgentSubscriber) async -> any AgentSubscription {
        await httpAgent.subscribe(subscriber)
    }

    // MARK: - Lifecycle

    /// Cancels any in-flight tool executions and disposes the underlying agent.
    ///
    /// After calling `close()`, further calls to ``sendMessage(_:threadId:state:includeSystemPrompt:)``
    /// will start a new run (the underlying agent's `dispose()` prevents its own `runAgent`
    /// pipeline from re-entering, but direct `run(input:)` calls continue to work for subclasses).
    open func close() {
        Task {
            if let manager = self.toolExecutionManager {
                await manager.cancelAllExecutions()
            }
        }
        httpAgent.dispose()
    }
}
