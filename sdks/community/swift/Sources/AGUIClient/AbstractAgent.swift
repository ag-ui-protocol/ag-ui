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

// MARK: - AgentStorage

/// Thread-safe mutable storage for an agent's runtime state.
///
/// All reads and writes are serialized through the actor executor,
/// ensuring data-race-free access across concurrent tasks.
internal actor AgentStorage {
    var messages: [any Message] = []
    var currentState: State = Data("{}".utf8)
    var rawEvents: [RawEvent] = []
    var customEvents: [CustomEvent] = []
    var thinking: ThinkingTelemetryState?
    var currentTask: Task<Void, Error>?
    var isDisposed: Bool = false
}

// MARK: - AgentStorage Mutation Helpers

internal extension AgentStorage {
    func setMessages(_ messages: [any Message]) { self.messages = messages }
    func setState(_ state: State) { self.currentState = state }
    func setThinking(_ thinking: ThinkingTelemetryState?) { self.thinking = thinking }
    func setRawEvents(_ rawEvents: [RawEvent]) { self.rawEvents = rawEvents }
    func setCustomEvents(_ customEvents: [CustomEvent]) { self.customEvents = customEvents }
    func setCurrentTask(_ task: Task<Void, Error>?) { self.currentTask = task }
    func setDisposed(_ disposed: Bool) { self.isDisposed = disposed }
}

// MARK: - AbstractAgent

/// Base class for AG-UI agents.
///
/// `AbstractAgent` provides the full lifecycle pipeline — including chunk
/// transformation, protocol verification, state application, and subscriber
/// notification — while delegating the raw event stream to subclasses via
/// `run(input:)`.
///
/// ## Subclassing
///
/// Override `run(input:)` to return a stream of raw AG-UI events:
///
/// ```swift
/// final class MyAgent: AbstractAgent {
///     override func run(input: RunAgentInput) -> AsyncThrowingStream<any AGUIEvent, Error> {
///         // Return your event stream here
///     }
/// }
/// ```
///
/// ## Thread Safety
///
/// The `@unchecked Sendable` annotation is required because `open class`
/// with mutable stored properties cannot automatically synthesize `Sendable`
/// conformance. Thread safety is provided by the internal `AgentStorage` actor.
open class AbstractAgent: @unchecked Sendable {

    // MARK: - Internal storage

    internal let storage: AgentStorage
    internal let subscriberManager: SubscriberManager

    // MARK: - Configuration (immutable after init)

    /// When `true`, logs verbose pipeline output to stdout.
    public let debug: Bool

    // MARK: - Initialization

    /// Creates a new abstract agent.
    ///
    /// - Parameter debug: When `true`, enables verbose pipeline logging.
    public init(debug: Bool = false) {
        self.storage = AgentStorage()
        self.subscriberManager = SubscriberManager()
        self.debug = debug
    }

    // MARK: - Async state accessors (cross actor boundary)

    /// The current conversation message list.
    public var messages: [any Message] { get async { await storage.messages } }

    /// The current JSON state.
    public var state: State { get async { await storage.currentState } }

    /// The accumulated raw events received during runs.
    public var rawEvents: [RawEvent] { get async { await storage.rawEvents } }

    /// The accumulated custom events received during runs.
    public var customEvents: [CustomEvent] { get async { await storage.customEvents } }

    /// The current thinking/reasoning telemetry state, if any.
    public var thinking: ThinkingTelemetryState? { get async { await storage.thinking } }

    // MARK: - Abstract run method (subclasses must override)

    /// Returns a stream of raw decoded AG-UI events for the given input.
    ///
    /// Subclasses **must** override this method. The default implementation
    /// triggers a `fatalError`.
    ///
    /// - Parameter input: The run agent input.
    /// - Returns: An `AsyncThrowingStream` of AG-UI events.
    open func run(input: RunAgentInput) -> AsyncThrowingStream<any AGUIEvent, Error> {
        fatalError("AbstractAgent subclasses must implement run(input:)")
    }

    // MARK: - Public pipeline methods

    /// Executes the full pipeline and blocks until the run completes.
    ///
    /// The pipeline applies chunk transformation, protocol verification, and
    /// state application. Registered subscribers (plus any one-off `subscriber`
    /// passed here) are notified at each lifecycle hook.
    ///
    /// - Parameters:
    ///   - parameters: Optional run parameters. When `nil`, defaults are used.
    ///   - subscriber: Optional one-off subscriber for this run only.
    /// - Throws: Rethrows any error produced by the event stream.
    public func runAgent(
        parameters: RunAgentParameters? = nil,
        subscriber: (any AgentSubscriber)? = nil
    ) async throws {
        guard await !storage.isDisposed else { return }

        let input = buildInput(from: parameters)

        // Collect all subscribers
        let registeredSubscribers = await subscriberManager.allSubscribers()
        var allSubscribers = registeredSubscribers
        if let s = subscriber { allSubscribers.append(s) }

        // onRunInitialized
        let initMutation = await runSubscribersWithMutation(
            subscribers: allSubscribers,
            messages: await storage.messages,
            state: await storage.currentState
        ) { sub, msgs, st in
            let params = AgentSubscriberParams(messages: msgs, state: st, input: input)
            return await sub.onRunInitialized(params: params)
        }
        if let msgs = initMutation.messages { await storage.setMessages(msgs) }
        if let st = initMutation.state { await storage.setState(st) }

        let task = Task<Void, Error> {
            defer {
                Task { await self.storage.setCurrentTask(nil) }
            }
            do {
                let eventStream = self.run(input: input)
                let processedStream = eventStream
                    .transformChunks()
                    .verifyEvents(debug: self.debug)
                    .applyEvents(input: input, subscribers: allSubscribers)

                for try await agentState in processedStream {
                    await self.applyAgentState(agentState, input: input, subscribers: allSubscribers)
                }

                // onRunFinalized
                let finalMessages = await self.storage.messages
                let finalState = await self.storage.currentState
                _ = await runSubscribersWithMutation(
                    subscribers: allSubscribers,
                    messages: finalMessages,
                    state: finalState
                ) { sub, msgs, st in
                    let params = AgentSubscriberParams(messages: msgs, state: st, input: input)
                    return await sub.onRunFinalized(params: params)
                }
            } catch {
                let currentMsgs = await self.storage.messages
                let currentSt = await self.storage.currentState
                _ = await runSubscribersWithMutation(
                    subscribers: allSubscribers,
                    messages: currentMsgs,
                    state: currentSt
                ) { sub, msgs, st in
                    let params = AgentRunFailureParams(error: error, messages: msgs, state: st, input: input)
                    return await sub.onRunFailed(params: params)
                }
                throw error
            }
        }

        await storage.setCurrentTask(task)
        try await task.value
    }

    /// Returns the processed event stream without driving the pipeline internally.
    ///
    /// Events pass through chunk transformation and protocol verification but
    /// state is **not** applied internally. Callers are responsible for
    /// consuming the stream and managing state.
    ///
    /// - Parameter input: The run agent input.
    /// - Returns: A verified, chunk-transformed event stream.
    public func runAgentObservable(
        input: RunAgentInput
    ) -> AsyncThrowingStream<any AGUIEvent, Error> {
        run(input: input)
            .transformChunks()
            .verifyEvents(debug: debug)
    }

    /// Cancels the current in-flight run task, if any.
    public func abortRun() {
        Task { await storage.currentTask?.cancel() }
    }

    /// Prevents further runs from starting.
    ///
    /// Calling `runAgent` after `dispose()` is a no-op.
    public func dispose() {
        Task { await storage.setDisposed(true) }
    }

    /// Subscribes to agent lifecycle events.
    ///
    /// - Parameter subscriber: The subscriber to register.
    /// - Returns: A subscription handle that can be used to unsubscribe.
    public func subscribe(_ subscriber: any AgentSubscriber) async -> any AgentSubscription {
        let id = await subscriberManager.subscribe(subscriber)
        return DefaultAgentSubscription {
            await self.subscriberManager.unsubscribe(id)
        }
    }

    // MARK: - Internal helpers

    internal func buildInput(from parameters: RunAgentParameters?) -> RunAgentInput {
        RunAgentInput(
            threadId: "default",
            runId: parameters?.runId ?? "run_\(UUID().uuidString)",
            tools: parameters?.tools ?? [],
            context: parameters?.context ?? [],
            forwardedProps: parameters?.forwardedProps ?? Data("{}".utf8)
        )
    }

    internal func applyAgentState(
        _ agentState: AgentState,
        input: RunAgentInput,
        subscribers: [any AgentSubscriber]
    ) async {
        if let messages = agentState.messages {
            await storage.setMessages(messages)
            let params = AgentStateChangedParams(
                messages: messages,
                state: await storage.currentState,
                input: input
            )
            for sub in subscribers { await sub.onMessagesChanged(params: params) }
        }
        if let state = agentState.state {
            await storage.setState(state)
            let msgs = await storage.messages
            let params = AgentStateChangedParams(messages: msgs, state: state, input: input)
            for sub in subscribers { await sub.onStateChanged(params: params) }
        }
        if let thinking = agentState.thinking {
            await storage.setThinking(thinking)
        }
        if let rawEvents = agentState.rawEvents {
            await storage.setRawEvents(rawEvents)
        }
        if let customEvents = agentState.customEvents {
            await storage.setCustomEvents(customEvents)
        }
    }
}
