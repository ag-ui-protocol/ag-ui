// Copyright (c) 2025 Perfect Aduh. MIT License. See LICENSE for details.

import AGUICore
import Foundation

// MARK: - AsyncSequence Extension

extension AsyncSequence where Element == any AGUIEvent {
    /// Transforms an AG-UI event stream into a stream of `AgentState` emissions.
    ///
    /// Each emission carries only the fields that changed in response to the
    /// triggering event. Callers should accumulate values from successive emissions
    /// to build the complete agent state.
    ///
    /// ## Example
    ///
    /// ```swift
    /// var currentMessages: [any Message] = []
    /// var currentState: State = Data("{}".utf8)
    ///
    /// for try await agentState in eventStream.applyEvents(input: input) {
    ///     if let messages = agentState.messages {
    ///         currentMessages = messages
    ///     }
    ///     if let state = agentState.state {
    ///         currentState = state
    ///     }
    /// }
    /// ```
    ///
    /// - Parameters:
    ///   - input: The `RunAgentInput` that seeded this run, providing initial messages and state.
    ///   - subscribers: Optional list of subscribers to notify of events (reserved for future use).
    /// - Returns: An `AsyncThrowingStream` of `AgentState` emissions.
    public func applyEvents(
        input: RunAgentInput,
        subscribers: [any AgentSubscriber] = []
    ) -> AsyncThrowingStream<AgentState, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                // Mutable state — all access is serialized within this single Task
                var messages: [any Message] = input.messages
                var currentState: State = input.state
                var rawEvents: [RawEvent] = []
                var customEvents: [CustomEvent] = []
                var initialMessagesEmitted: Bool = false
                var activeToolCallIds: Set<String> = []
                var replaceToolCallArgs: Set<String> = []

                do {
                    for try await event in self {
                        try Task.checkCancellation()
                        let mutation = await runSubscribersWithMutation(
                            subscribers: subscribers,
                            messages: messages,
                            state: currentState
                        ) { subscriber, currentMessages, currentState in
                            await subscriber.onEvent(params: AgentEventParams(
                                event: event,
                                messages: currentMessages,
                                state: currentState,
                                input: input
                            ))
                        }
                        if let changed = mutation.messages {
                            messages = changed
                            continuation.yield(AgentState(messages: messages))
                        }
                        if let changed = mutation.state {
                            currentState = changed
                            continuation.yield(AgentState(state: currentState))
                        }
                        // Emit initial messages on first event if present
                        if !initialMessagesEmitted {
                            initialMessagesEmitted = true
                            if !messages.isEmpty {
                                continuation.yield(AgentState(messages: messages))
                            }
                        }
                        if mutation.stopPropagation { continue }

                        switch event {
                        case is RunStartedEvent:
                            activeToolCallIds.removeAll()
                            replaceToolCallArgs.removeAll()

                        case let e as TextMessageStartEvent:
                            if !messages.contains(where: { $0.id == e.messageId }) {
                                switch e.role {
                                case "user":
                                    messages.append(UserMessage(id: e.messageId, content: ""))
                                case "system":
                                    messages.append(SystemMessage(id: e.messageId, content: ""))
                                case "developer":
                                    messages.append(DeveloperMessage(id: e.messageId, content: ""))
                                default:
                                    messages.append(AssistantMessage(id: e.messageId, content: "",
                                        metadata: eventMetadata(event),
                                        subagentRunId: eventAttribution(event)))
                                }
                            }
                            continuation.yield(AgentState(messages: messages))

                        case let e as TextMessageContentEvent:
                            let id = e.messageId
                            if let idx = messages.lastIndex(where: { $0.id == id }) {
                                let message = messages[idx]
                                switch message {
                                case let m as AssistantMessage:
                                    messages[idx] = m.withContent((m.content ?? "") + e.delta,
                                        metadata: mergedMetadata(m.metadata, eventMetadata(event)))
                                case let m as UserMessage where !m.isMultimodal:
                                    messages[idx] = UserMessage(id: m.id, content: (m.content ?? "") + e.delta,
                                        name: m.name, encryptedValue: m.encryptedValue)
                                case let m as SystemMessage:
                                    messages[idx] = SystemMessage(id: m.id, content: m.content + e.delta,
                                        name: m.name, encryptedValue: m.encryptedValue)
                                case let m as DeveloperMessage:
                                    messages[idx] = DeveloperMessage(id: m.id, content: (m.content ?? "") + e.delta,
                                        name: m.name, encryptedValue: m.encryptedValue)
                                default: break
                                }
                                continuation.yield(AgentState(messages: messages))
                            }

                        case is TextMessageEndEvent:
                            // No-op: no state emission for end event
                            break

                        case let e as ReasoningMessageStartEvent:
                            if !messages.contains(where: { $0.id == e.messageId }) {
                                messages.append(ReasoningMessage(id: e.messageId, content: ""))
                            }
                            continuation.yield(AgentState(messages: messages))

                        case let e as ReasoningMessageContentEvent:
                            if let idx = messages.lastIndex(where: { $0.id == e.messageId }),
                               let reasoning = messages[idx] as? ReasoningMessage {
                                messages[idx] = ReasoningMessage(id: e.messageId,
                                    content: (reasoning.content ?? "") + e.delta,
                                    encryptedValue: reasoning.encryptedValue)
                                continuation.yield(AgentState(messages: messages))
                            }

                        case let e as ToolCallStartEvent:
                            if let idx = messages.firstIndex(where: {
                                ($0 as? AssistantMessage)?.toolCalls?.contains { $0.id == e.toolCallId } == true
                            }), let assistant = messages[idx] as? AssistantMessage {
                                if activeToolCallIds.insert(e.toolCallId).inserted {
                                    replaceToolCallArgs.insert(e.toolCallId)
                                }
                                messages[idx] = assistant.withToolCallStart(e)
                                continuation.yield(AgentState(messages: messages))
                                continue
                            }
                            activeToolCallIds.insert(e.toolCallId)
                            let toolCall = ToolCall(
                                id: e.toolCallId,
                                function: FunctionCall(name: e.toolCallName, arguments: ""),
                                metadata: eventMetadata(event)
                            )
                            if let parentId = e.parentMessageId,
                               let idx = messages.lastIndex(where: { $0.id == parentId }),
                               let assistantMsg = messages[idx] as? AssistantMessage {
                                messages[idx] = assistantMsg.withAppendedToolCall(toolCall)
                            } else {
                                // Create a new AssistantMessage to hold this tool call
                                let newMsg = AssistantMessage(
                                    id: e.parentMessageId.flatMap { parent in
                                        messages.contains { $0.id == parent } ? nil : parent
                                    } ?? e.toolCallId,
                                    content: nil,
                                    toolCalls: [toolCall],
                                    subagentRunId: eventAttribution(event)
                                )
                                messages.append(newMsg)
                            }
                            continuation.yield(AgentState(messages: messages))

                        case let e as ToolCallArgsEvent:
                            let id = e.toolCallId
                            for idx in messages.indices {
                                if let assistantMsg = messages[idx] as? AssistantMessage,
                                   assistantMsg.toolCalls?.contains(where: { $0.id == id }) == true {
                                    messages[idx] = assistantMsg.withUpdatedToolCallArguments(
                                        toolCallId: id,
                                        appendDelta: e.delta,
                                        replace: replaceToolCallArgs.remove(id) != nil,
                                        metadata: eventMetadata(event)
                                    )
                                    break
                                }
                            }
                            continuation.yield(AgentState(messages: messages))

                        case let e as ToolCallEndEvent:
                            activeToolCallIds.remove(e.toolCallId)
                            replaceToolCallArgs.remove(e.toolCallId)
                            for idx in messages.indices {
                                if let assistant = messages[idx] as? AssistantMessage,
                                   assistant.toolCalls?.contains(where: { $0.id == e.toolCallId }) == true {
                                    messages[idx] = assistant.withUpdatedToolCallArguments(
                                        toolCallId: e.toolCallId, appendDelta: "",
                                        metadata: eventMetadata(event))
                                    continuation.yield(AgentState(messages: messages))
                                    break
                                }
                            }

                        case let e as ToolCallResultEvent:
                            let toolMsg = ToolMessage(
                                id: e.messageId,
                                content: e.content,
                                toolCallId: e.toolCallId,
                                contentParts: toolResultParts(e)
                            )
                            if let index = messages.firstIndex(where: {
                                $0.id == e.messageId && ($0 as? ToolMessage)?.toolCallId == e.toolCallId
                            }) {
                                messages[index] = toolMsg
                            } else {
                                var owner: Int?
                                var newest: Int?
                                var answered = false
                                for index in messages.indices.reversed() {
                                    if (messages[index] as? ToolMessage)?.toolCallId == e.toolCallId {
                                        answered = true
                                    } else if (messages[index] as? AssistantMessage)?.toolCalls?.contains(where: {
                                        $0.id == e.toolCallId
                                    }) == true {
                                        if newest == nil { newest = index }
                                        if !answered { owner = index; break }
                                        answered = false
                                    }
                                }
                                if let owner = owner ?? newest {
                                    var index = owner + 1
                                    while index < messages.count &&
                                        (messages[index] is ToolMessage || messages[index] is ActivityMessage) {
                                        index += 1
                                    }
                                    messages.insert(toolMsg, at: index)
                                } else {
                                    messages.append(toolMsg)
                                }
                            }
                            continuation.yield(AgentState(messages: messages))

                        case let e as MessagesSnapshotEvent:
                            messages = e.messages
                            continuation.yield(AgentState(messages: messages))

                        case let e as ActivitySnapshotEvent:
                            if let index = messages.firstIndex(where: { $0.id == e.messageId }) {
                                if e.replace {
                                    messages[index] = ActivityMessage(id: e.messageId,
                                        activityType: e.activityType, content: e.content)
                                }
                            } else {
                                messages.append(ActivityMessage(id: e.messageId,
                                    activityType: e.activityType, content: e.content))
                            }
                            continuation.yield(AgentState(messages: messages))

                        case let e as ActivityDeltaEvent:
                            if let index = messages.firstIndex(where: { $0.id == e.messageId }),
                               let activity = messages[index] as? ActivityMessage,
                               let content = try? PatchApplicator().apply(patch: e.patch, to: activity.content) {
                                messages[index] = ActivityMessage(id: activity.id,
                                    activityType: activity.activityType, content: content)
                                continuation.yield(AgentState(messages: messages))
                            }

                        case let e as StateSnapshotEvent:
                            currentState = e.snapshot
                            continuation.yield(AgentState(state: currentState))

                        case let e as StateDeltaEvent:
                            let applicator = PatchApplicator()
                            // A valid patch document may still be inapplicable to the
                            // current state; retain the last usable snapshot.
                            do {
                                let updated = try applicator.apply(patch: e.delta, to: currentState)
                                currentState = updated
                                continuation.yield(AgentState(state: currentState))
                            } catch {
                                FileHandle.standardError.write(Data("Failed to apply state patch; retaining prior state\n".utf8))
                                break
                            }

                        case let e as RawEvent:
                            rawEvents.append(e)
                            continuation.yield(AgentState(rawEvents: rawEvents))

                        case let e as CustomEvent:
                            customEvents.append(e)
                            continuation.yield(AgentState(customEvents: customEvents))

                        default:
                            break
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

// MARK: - AssistantMessage Mutation Helpers

private func eventMetadata(_ event: any AGUIEvent) -> Data? {
    guard let raw = event.rawEvent,
          let metadata = (try? AGUIJSON.parse(raw))?.object?["metadata"]
    else { return nil }
    return try? metadata.encoded()
}

private func toolResultParts(_ event: ToolCallResultEvent) -> Data? {
    guard let raw = event.rawEvent,
          let content = (try? AGUIJSON.parse(raw))?.object?["content"],
          content.array != nil else { return nil }
    return try? content.encoded()
}

private func eventAttribution(_ event: any AGUIEvent) -> String? {
    guard let raw = event.rawEvent,
          let object = (try? JSONSerialization.jsonObject(with: raw)) as? [String: Any]
    else { return nil }
    return object["subagentRunId"] as? String
}

private func mergedMetadata(_ current: Data?, _ next: Data?) -> Data? {
    guard let next else { return current }
    var merged = (current.flatMap { try? AGUIJSON.parse($0).object }) ?? [:]
    for (key, value) in ((try? AGUIJSON.parse(next).object) ?? [:]) {
        merged[key] = value
    }
    return try? AGUIJSON.object(merged).encoded()
}

private extension AssistantMessage {
    func withToolCallStart(_ event: ToolCallStartEvent) -> AssistantMessage {
        let calls = toolCalls?.map { call in
            guard call.id == event.toolCallId else { return call }
            return ToolCall(id: call.id,
                function: FunctionCall(name: event.toolCallName, arguments: call.function.arguments),
                encryptedValue: call.encryptedValue,
                metadata: mergedMetadata(call.metadata, eventMetadata(event)))
        }
        return AssistantMessage(id: id, content: content, name: name, toolCalls: calls,
            encryptedValue: encryptedValue, metadata: metadata, subagentRunId: subagentRunId)
    }


    func withContent(_ newContent: String, metadata: Data? = nil) -> AssistantMessage {
        AssistantMessage(id: id, content: newContent, name: name, toolCalls: toolCalls,
            encryptedValue: encryptedValue, metadata: metadata ?? self.metadata,
            subagentRunId: subagentRunId)
    }

    func withAppendedToolCall(_ toolCall: ToolCall) -> AssistantMessage {
        var calls = toolCalls ?? []
        calls.append(toolCall)
        return AssistantMessage(id: id, content: content, name: name, toolCalls: calls,
            encryptedValue: encryptedValue, metadata: metadata,
            subagentRunId: subagentRunId)
    }

    func withUpdatedToolCallArguments(toolCallId: String, appendDelta: String, replace: Bool = false, metadata next: Data? = nil) -> AssistantMessage {
        guard let calls = toolCalls else { return self }
        let updated = calls.map { call in
            if call.id == toolCallId {
                return ToolCall(
                    id: call.id,
                    function: FunctionCall(
                        name: call.function.name,
                        arguments: (replace ? "" : call.function.arguments) + appendDelta
                    ),
                    encryptedValue: call.encryptedValue,
                    metadata: mergedMetadata(call.metadata, next)
                )
            }
            return call
        }
        return AssistantMessage(id: id, content: content, name: name, toolCalls: updated,
            encryptedValue: encryptedValue, metadata: metadata,
            subagentRunId: subagentRunId)
    }
}
