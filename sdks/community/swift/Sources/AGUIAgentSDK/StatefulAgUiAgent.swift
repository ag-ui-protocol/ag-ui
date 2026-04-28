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

/// Stateful AG-UI agent that automatically manages conversation history.
///
/// `StatefulAgUiAgent` provides a high-level, iOS-friendly API for building
/// conversational AI interfaces. It automatically tracks message history per thread,
/// manages state updates, and provides convenient methods for common patterns.
///
/// ## Basic Usage
///
/// ```swift
/// let agent = StatefulAgUiAgent(baseURL: URL(string: "https://agent.example.com")!)
///
/// let stream = try await agent.chat(message: "Hello!")
/// for try await event in stream {
///     if let content = event as? TextMessageContentEvent {
///         print(content.delta, terminator: "")
///     }
/// }
/// ```
///
/// ## Advanced Configuration
///
/// ```swift
/// var config = StatefulAgUiAgentConfig(baseURL: agentURL)
/// config.systemPrompt = "You are a helpful AI assistant."
/// config.maxHistoryLength = 50
/// config.timeout = .seconds(60)
///
/// let agent = StatefulAgUiAgent(configuration: config)
///
/// // Multi-turn conversation
/// _ = try await agent.chat(message: "What's the weather?")
/// _ = try await agent.chat(message: "And tomorrow?") // Maintains context
/// ```
///
/// ## Thread Management
///
/// Each conversation can have its own thread with independent history:
///
/// ```swift
/// // Conversation 1
/// let stream1 = try await agent.chat(message: "Hello", threadId: "user-123")
///
/// // Conversation 2 (separate history)
/// let stream2 = try await agent.chat(message: "Hi", threadId: "user-456")
/// ```
///
/// ## Features
///
/// - **Automatic History**: User and assistant messages are tracked automatically
/// - **System Prompts**: Configurable system message for agent behavior
/// - **History Trimming**: Keeps conversations within token limits
/// - **State Management**: Tracks and updates agent state from events
/// - **Thread Safety**: Actor-based concurrency for safe multi-threaded use
///
/// - SeeAlso: ``StatefulAgUiAgentConfig``, ``ConversationHistoryManager``
public final class StatefulAgUiAgent: Sendable {
    /// The underlying HTTP agent for communication.
    private let httpAgent: HttpAgent

    /// Manager for conversation histories across threads.
    private let historyManager: ConversationHistoryManager

    /// Configuration for this agent.
    public let config: StatefulAgUiAgentConfig

    /// Actor for managing current state (thread-safe).
    private let stateManager: StateManager

    /// Optional tool execution manager. Created when `config.toolRegistry` is set.
    private let toolExecutionManager: ToolExecutionManager?

    /// Creates a new stateful agent with a base URL.
    ///
    /// - Parameter baseURL: The base URL of the AG-UI agent server
    ///
    /// ## Example
    ///
    /// ```swift
    /// let agent = StatefulAgUiAgent(baseURL: URL(string: "https://agent.example.com")!)
    /// ```
    public init(baseURL: URL) {
        let config = StatefulAgUiAgentConfig(baseURL: baseURL)
        self.config = config
        let agent = HttpAgent(configuration: HttpAgentConfiguration(
            baseURL: config.baseURL,
            timeout: config.timeout,
            headers: config.headers,
            debug: config.debug
        ))
        self.httpAgent = agent
        self.historyManager = ConversationHistoryManager()
        self.stateManager = StateManager(initialState: config.initialState)
        if let registry = config.toolRegistry {
            self.toolExecutionManager = ToolExecutionManager(
                toolRegistry: registry,
                responseHandler: ClientToolResponseHandler(httpAgent: agent)
            )
        } else {
            self.toolExecutionManager = nil
        }
    }

    /// Creates a new stateful agent with custom configuration.
    ///
    /// - Parameter configuration: The stateful agent configuration
    ///
    /// ## Example
    ///
    /// ```swift
    /// var config = StatefulAgUiAgentConfig(baseURL: agentURL)
    /// config.systemPrompt = "You are helpful"
    /// config.maxHistoryLength = 100
    ///
    /// let agent = StatefulAgUiAgent(configuration: config)
    /// ```
    public init(configuration: StatefulAgUiAgentConfig) {
        self.config = configuration
        let agent = HttpAgent(configuration: HttpAgentConfiguration(
            baseURL: configuration.baseURL,
            timeout: configuration.timeout,
            headers: configuration.headers,
            debug: configuration.debug
        ))
        self.httpAgent = agent
        self.historyManager = ConversationHistoryManager()
        self.stateManager = StateManager(initialState: configuration.initialState)
        if let registry = configuration.toolRegistry {
            self.toolExecutionManager = ToolExecutionManager(
                toolRegistry: registry,
                responseHandler: ClientToolResponseHandler(httpAgent: agent)
            )
        } else {
            self.toolExecutionManager = nil
        }
    }

    /// Sends a chat message with automatic history management.
    ///
    /// This is a convenience method that delegates to ``sendMessage(message:threadId:state:includeSystemPrompt:)``
    /// with sensible defaults for casual chat interactions.
    ///
    /// - Parameters:
    ///   - message: The user's message text
    ///   - threadId: The conversation thread ID (default: "default")
    /// - Returns: Event stream from the agent
    /// - Throws: `ClientError` if the request fails
    ///
    /// ## Example
    ///
    /// ```swift
    /// let stream = try await agent.chat(message: "Hello!")
    /// for try await event in stream {
    ///     // Process events
    /// }
    /// ```
    public func chat(
        message: String,
        threadId: String = "default"
    ) async throws -> AsyncThrowingStream<any AGUIEvent, Error> {
        let currentState = await stateManager.currentState()
        return try await sendMessage(
            message: message,
            threadId: threadId,
            state: currentState,
            includeSystemPrompt: true
        )
    }

    /// Sends a message with full control over state and system prompt.
    ///
    /// This method provides complete control over the message sending process,
    /// including custom state and system prompt inclusion.
    ///
    /// - Parameters:
    ///   - message: The user's message text
    ///   - threadId: The conversation thread ID
    ///   - state: Custom state to send (defaults to current state)
    ///   - includeSystemPrompt: Whether to add system prompt for new threads (default: true)
    /// - Returns: Event stream from the agent
    /// - Throws: `ClientError` if the request fails
    ///
    /// ## Example
    ///
    /// ```swift
    /// let customState = Data("{\"mode\":\"creative\"}".utf8)
    /// let stream = try await agent.sendMessage(
    ///     message: "Tell me a story",
    ///     threadId: "story-session",
    ///     state: customState,
    ///     includeSystemPrompt: true
    /// )
    /// ```
    public func sendMessage(
        message: String,
        threadId: String,
        state: State?,
        includeSystemPrompt: Bool
    ) async throws -> AsyncThrowingStream<any AGUIEvent, Error> {
        // Get conversation history for this thread
        var history = await historyManager.history(for: threadId)

        // Add system prompt if it's the first message and includeSystemPrompt is true
        if history.isEmpty && includeSystemPrompt, let systemPrompt = config.systemPrompt {
            let systemMessage = SystemMessage(
                id: "sys_\(UUID().uuidString)",
                content: systemPrompt
            )
            await historyManager.append(message: systemMessage, to: threadId)
            history.append(systemMessage)
        }

        // Create and add the user message
        let userMessage = UserMessage(
            id: "usr_\(UUID().uuidString)",
            content: message
        )
        await historyManager.append(message: userMessage, to: threadId)
        history.append(userMessage)

        // Apply history length limit if configured
        if config.maxHistoryLength > 0 {
            await historyManager.trim(threadId: threadId, maxLength: config.maxHistoryLength)
            history = await historyManager.history(for: threadId)
        }

        // Use the provided state or the current state
        let stateToUse: State
        if let providedState = state {
            stateToUse = providedState
        } else {
            stateToUse = await stateManager.currentState()
        }

        // Build the base run input
        let baseInput = try RunAgentInput.builder()
            .threadId(threadId)
            .runId("run_\(UUID().uuidString)")
            .messages(history)
            .state(stateToUse)
            .build()

        // Include tool definitions if a registry is configured
        let inputWithTools: RunAgentInput
        if let registry = config.toolRegistry {
            let tools = await registry.allTools()
            inputWithTools = RunAgentInput(
                threadId: baseInput.threadId,
                runId: baseInput.runId,
                parentRunId: baseInput.parentRunId,
                state: baseInput.state,
                messages: baseInput.messages,
                tools: tools,
                context: config.context.isEmpty ? baseInput.context : config.context,
                forwardedProps: baseInput.forwardedProps
            )
        } else {
            inputWithTools = RunAgentInput(
                threadId: baseInput.threadId,
                runId: baseInput.runId,
                parentRunId: baseInput.parentRunId,
                state: baseInput.state,
                messages: baseInput.messages,
                tools: baseInput.tools,
                context: config.context.isEmpty ? baseInput.context : config.context,
                forwardedProps: baseInput.forwardedProps
            )
        }

        // Execute the run
        let rawStream = try await httpAgent.run(inputWithTools, endpoint: config.endpoint)

        // Wrap through tool execution manager if present, otherwise pass through
        let eventStream: AsyncThrowingStream<any AGUIEvent, Error>
        if let manager = toolExecutionManager {
            eventStream = await manager.processEventStream(
                rawStream,
                threadId: inputWithTools.threadId,
                runId: inputWithTools.runId
            )
        } else {
            eventStream = AsyncThrowingStream { continuation in
                Task {
                    do {
                        for try await event in rawStream { continuation.yield(event) }
                        continuation.finish()
                    } catch { continuation.finish(throwing: error) }
                }
            }
        }

        // Wrap the stream to track history and state updates
        return trackHistoryAndState(stream: eventStream, threadId: threadId)
    }

    /// Retrieves the conversation history for a thread.
    ///
    /// - Parameter threadId: The thread ID (default: "default")
    /// - Returns: Array of messages in chronological order
    ///
    /// ## Example
    ///
    /// ```swift
    /// let history = await agent.history(for: "chat-session")
    /// print("Conversation has \(history.count) messages")
    /// ```
    public func history(for threadId: String = "default") async -> [any Message] {
        await historyManager.history(for: threadId)
    }

    /// Clears conversation history for one or all threads.
    ///
    /// - Parameter threadId: The thread ID to clear, or `nil` to clear all threads
    ///
    /// ## Example
    ///
    /// ```swift
    /// // Clear specific thread
    /// await agent.clearHistory(threadId: "chat-1")
    ///
    /// // Clear all threads
    /// await agent.clearHistory()
    /// ```
    public func clearHistory(threadId: String? = nil) async {
        await historyManager.clear(threadId: threadId)
    }

    // MARK: - Private Helpers

    /// Wraps an event stream to track assistant messages, tool calls, and state updates.
    private func trackHistoryAndState<S: AsyncSequence>(
        stream: S,
        threadId: String
    ) -> AsyncThrowingStream<any AGUIEvent, Error> where S.Element == any AGUIEvent {
        AsyncThrowingStream { continuation in
            Task {
                var currentAssistantMessage: AssistantMessage?
                let patchApplicator = PatchApplicator()
                let messageDecoder = MessageDecoder()

                do {
                    for try await event in stream {
                        // Yield the event downstream
                        continuation.yield(event)

                        // Track assistant messages, tool calls, and state
                        switch event {

                        // MARK: Text messages

                        case let start as TextMessageStartEvent:
                            currentAssistantMessage = AssistantMessage(
                                id: start.messageId,
                                content: ""
                            )

                        case let content as TextMessageContentEvent:
                            if let msg = currentAssistantMessage, msg.id == content.messageId {
                                let updatedContent = (msg.content ?? "") + content.delta
                                currentAssistantMessage = AssistantMessage(
                                    id: msg.id,
                                    content: updatedContent,
                                    name: msg.name,
                                    toolCalls: msg.toolCalls
                                )
                            }

                        case let end as TextMessageEndEvent:
                            if let msg = currentAssistantMessage, msg.id == end.messageId {
                                await self.historyManager.append(message: msg, to: threadId)
                                currentAssistantMessage = nil
                            }

                        // MARK: Tool calls

                        case let start as ToolCallStartEvent:
                            let newCall = ToolCall(
                                id: start.toolCallId,
                                function: FunctionCall(name: start.toolCallName, arguments: "")
                            )
                            if let msg = currentAssistantMessage {
                                var calls = msg.toolCalls ?? []
                                calls.append(newCall)
                                currentAssistantMessage = AssistantMessage(
                                    id: msg.id,
                                    content: msg.content,
                                    name: msg.name,
                                    toolCalls: calls
                                )
                            } else {
                                currentAssistantMessage = AssistantMessage(
                                    id: "asst_\(UUID().uuidString)",
                                    content: nil,
                                    toolCalls: [newCall]
                                )
                            }

                        case let args as ToolCallArgsEvent:
                            if let msg = currentAssistantMessage,
                               let calls = msg.toolCalls,
                               let idx = calls.firstIndex(where: { $0.id == args.toolCallId }) {
                                let call = calls[idx]
                                let updatedCall = ToolCall(
                                    id: call.id,
                                    function: FunctionCall(
                                        name: call.function.name,
                                        arguments: call.function.arguments + args.delta
                                    )
                                )
                                var updatedCalls = calls
                                updatedCalls[idx] = updatedCall
                                currentAssistantMessage = AssistantMessage(
                                    id: msg.id,
                                    content: msg.content,
                                    name: msg.name,
                                    toolCalls: updatedCalls
                                )
                            }

                        case let end as ToolCallEndEvent:
                            // Save the current assistant message (with completed tool calls so far).
                            // A new ToolCallStartEvent for a subsequent call will update it further,
                            // but we persist the snapshot here so history is never lost.
                            if let msg = currentAssistantMessage {
                                _ = end // tool call ID not needed here
                                await self.historyManager.append(message: msg, to: threadId)
                            }

                        case let result as ToolCallResultEvent:
                            let toolMessage = ToolMessage(
                                id: result.messageId,
                                content: result.content,
                                toolCallId: result.toolCallId
                            )
                            await self.historyManager.append(message: toolMessage, to: threadId)

                        // MARK: State events

                        case let snapshot as StateSnapshotEvent:
                            await self.stateManager.updateState(snapshot.snapshot)

                        case let delta as StateDeltaEvent:
                            let currentState = await self.stateManager.currentState()
                            if let newState = try? patchApplicator.apply(patch: delta.delta, to: currentState) {
                                await self.stateManager.updateState(newState)
                            }

                        case let msgSnapshot as MessagesSnapshotEvent:
                            // Replace the thread history with the authoritative snapshot.
                            if let rawArray = try? JSONSerialization.jsonObject(with: msgSnapshot.messages) as? [[String: Any]] {
                                let msgs: [any Message] = rawArray.compactMap { dict in
                                    guard let data = try? JSONSerialization.data(withJSONObject: dict) else { return nil }
                                    return try? messageDecoder.decode(data)
                                }
                                await self.historyManager.clear(threadId: threadId)
                                for msg in msgs {
                                    await self.historyManager.append(message: msg, to: threadId)
                                }
                            }

                        default:
                            break
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
        }
    }
}

// MARK: - StateManager

/// Thread-safe actor for managing agent state.
private actor StateManager {
    private var currentStateValue: State

    init(initialState: State) {
        self.currentStateValue = initialState
    }

    func currentState() -> State {
        currentStateValue
    }

    func updateState(_ newState: State) {
        currentStateValue = newState
    }
}
