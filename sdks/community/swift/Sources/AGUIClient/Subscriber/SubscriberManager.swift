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

// MARK: - DefaultAgentSubscription

/// Default implementation of ``AgentSubscription``.
///
/// This subscription maintains a reference to the subscriber manager
/// and its own ID to enable unsubscription.
actor DefaultAgentSubscription: AgentSubscription {
    private var isActive: Bool = true
    private let onUnsubscribe: @Sendable () async -> Void

    /// Creates a new subscription.
    ///
    /// - Parameter onUnsubscribe: Closure to call when unsubscribing
    init(onUnsubscribe: @escaping @Sendable () async -> Void) {
        self.onUnsubscribe = onUnsubscribe
    }

    /// Unsubscribes from the agent.
    ///
    /// After calling this method, no further callbacks will be delivered
    /// to the subscriber.
    public func unsubscribe() async {
        guard isActive else { return }
        isActive = false
        await onUnsubscribe()
    }
}

// MARK: - SubscriberManager

/// Thread-safe manager for agent subscribers.
///
/// This actor maintains the list of active subscribers and provides
/// methods to execute them in sequence with mutation chaining.
public actor SubscriberManager {
    private var subscribers: [UUID: any AgentSubscriber] = [:]

    public init() {}

    /// Subscribes a new subscriber.
    ///
    /// - Parameter subscriber: The subscriber to add
    /// - Returns: The unique ID for this subscription
    public func subscribe(_ subscriber: any AgentSubscriber) -> UUID {
        let id = UUID()
        subscribers[id] = subscriber
        return id
    }

    /// Unsubscribes a subscriber by ID.
    ///
    /// - Parameter id: The subscription ID to remove
    public func unsubscribe(_ id: UUID) {
        subscribers.removeValue(forKey: id)
    }

    /// Returns all active subscribers.
    ///
    /// - Returns: Array of all subscribers in registration order
    public func allSubscribers() -> [any AgentSubscriber] {
        Array(subscribers.values)
    }
}

// MARK: - Mutation Execution

/// Executes subscribers sequentially, feeding the latest message/state snapshot.
///
/// This function implements mutation chaining: each subscriber receives the
/// messages and state as modified by previous subscribers. If any subscriber
/// returns `stopPropagation: true`, execution stops immediately.
///
/// ## Example
///
/// ```swift
/// let mutation = await runSubscribersWithMutation(
///     subscribers: [subscriber1, subscriber2],
///     messages: currentMessages,
///     state: currentState
/// ) { subscriber, messages, state in
///     let params = AgentSubscriberParams(
///         messages: messages,
///         state: state,
///         input: input
///     )
///     return await subscriber.onRunInitialized(params: params)
/// }
///
/// if let updatedMessages = mutation.messages {
///     currentMessages = updatedMessages
/// }
/// ```
///
/// - Parameters:
///   - subscribers: Array of subscribers to execute
///   - messages: Initial messages
///   - state: Initial state
///   - executor: Closure that calls the specific subscriber method
/// - Returns: Aggregated mutation from all subscribers
public func runSubscribersWithMutation(
    subscribers: [any AgentSubscriber],
    messages: [any Message],
    state: State,
    executor: @Sendable (any AgentSubscriber, [any Message], State) async -> AgentStateMutation?
) async -> AgentStateMutation {
    var currentMessages = messages
    var currentState = state
    var aggregatedMessages: [any Message]?
    var aggregatedState: State?
    var stopPropagation = false

    for subscriber in subscribers {
        // Swift structs have value semantics, so copying is automatic
        let mutation = await executor(subscriber, currentMessages, currentState)

        if let mutation = mutation {
            if let newMessages = mutation.messages {
                currentMessages = newMessages
                aggregatedMessages = newMessages
            }
            if let newState = mutation.state {
                currentState = newState
                aggregatedState = newState
            }
            if mutation.stopPropagation {
                stopPropagation = true
                break
            }
        }
    }

    return AgentStateMutation(
        messages: aggregatedMessages,
        state: aggregatedState,
        stopPropagation: stopPropagation
    )
}
