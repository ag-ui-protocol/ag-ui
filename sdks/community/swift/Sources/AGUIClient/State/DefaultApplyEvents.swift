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
            Task {
                // Mutable state — all access is serialized within this single Task
                var messages: [any Message] = input.messages
                var currentState: State = input.state
                var rawEvents: [RawEvent] = []
                var customEvents: [CustomEvent] = []
                var thinkingActive: Bool = false
                var thinkingTitle: String? = nil
                var thinkingMessages: [String] = []
                var thinkingBuffer: String? = nil
                var initialMessagesEmitted: Bool = false

                do {
                    for try await event in self {
                        // Emit initial messages on first event if present
                        if !initialMessagesEmitted {
                            initialMessagesEmitted = true
                            if !messages.isEmpty {
                                continuation.yield(AgentState(messages: messages))
                            }
                        }

                        switch event {
                        case let e as RunStartedEvent:
                            _ = e
                            // Reset thinking state on new run
                            thinkingActive = false
                            thinkingTitle = nil
                            thinkingMessages = []
                            thinkingBuffer = nil

                        case let e as TextMessageStartEvent:
                            let newMessage = AssistantMessage(id: e.messageId, content: "")
                            messages.append(newMessage)
                            continuation.yield(AgentState(messages: messages))

                        case let e as TextMessageContentEvent:
                            let id = e.messageId
                            if let idx = messages.lastIndex(where: { $0.id == id }),
                               let assistantMsg = messages[idx] as? AssistantMessage {
                                messages[idx] = assistantMsg.withContent(
                                    (assistantMsg.content ?? "") + e.delta
                                )
                                continuation.yield(AgentState(messages: messages))
                            }

                        case is TextMessageEndEvent:
                            // No-op: no state emission for end event
                            break

                        case let e as ToolCallStartEvent:
                            let toolCall = ToolCall(
                                id: e.toolCallId,
                                function: FunctionCall(name: e.toolCallName, arguments: "")
                            )
                            if let parentId = e.parentMessageId,
                               let idx = messages.lastIndex(where: { $0.id == parentId }),
                               let assistantMsg = messages[idx] as? AssistantMessage {
                                messages[idx] = assistantMsg.withAppendedToolCall(toolCall)
                            } else if let idx = messages.lastIndex(where: { $0 is AssistantMessage }),
                                      let assistantMsg = messages[idx] as? AssistantMessage {
                                messages[idx] = assistantMsg.withAppendedToolCall(toolCall)
                            } else {
                                // Create a new AssistantMessage to hold this tool call
                                let newMsg = AssistantMessage(
                                    id: e.parentMessageId ?? e.toolCallId,
                                    content: nil,
                                    toolCalls: [toolCall]
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
                                        appendDelta: e.delta
                                    )
                                    break
                                }
                            }
                            continuation.yield(AgentState(messages: messages))

                        case is ToolCallEndEvent:
                            // No-op: no state emission for end event
                            break

                        case let e as ToolCallResultEvent:
                            let toolMsg = ToolMessage(
                                id: e.messageId,
                                content: e.content,
                                toolCallId: e.toolCallId
                            )
                            messages.append(toolMsg)
                            continuation.yield(AgentState(messages: messages))

                        case let e as MessagesSnapshotEvent:
                            let decoder = MessageDecoder()
                            let rawArray = try JSONSerialization.jsonObject(
                                with: e.messages,
                                options: []
                            ) as? [[String: Any]] ?? []
                            let decodedMessages = try rawArray.compactMap { dict -> (any Message)? in
                                let data = try JSONSerialization.data(withJSONObject: dict)
                                return try? decoder.decode(data)
                            }
                            messages = decodedMessages
                            continuation.yield(AgentState(messages: messages))

                        case let e as StateSnapshotEvent:
                            currentState = e.snapshot
                            continuation.yield(AgentState(state: currentState))

                        case let e as StateDeltaEvent:
                            let applicator = PatchApplicator()
                            currentState = try applicator.apply(patch: e.delta, to: currentState)
                            continuation.yield(AgentState(state: currentState))

                        case let e as RawEvent:
                            rawEvents.append(e)
                            continuation.yield(AgentState(rawEvents: rawEvents))

                        case let e as CustomEvent:
                            customEvents.append(e)
                            continuation.yield(AgentState(customEvents: customEvents))

                        case let e as ThinkingStartEvent:
                            thinkingActive = true
                            thinkingTitle = e.title
                            continuation.yield(AgentState(
                                thinking: ThinkingTelemetryState(
                                    isThinking: true,
                                    title: thinkingTitle,
                                    messages: thinkingMessages
                                )
                            ))

                        case is ThinkingEndEvent:
                            // Finalize any in-progress buffer
                            if let buffer = thinkingBuffer {
                                thinkingMessages.append(buffer)
                                thinkingBuffer = nil
                            }
                            thinkingActive = false
                            continuation.yield(AgentState(
                                thinking: ThinkingTelemetryState(
                                    isThinking: false,
                                    title: thinkingTitle,
                                    messages: thinkingMessages
                                )
                            ))

                        case is ThinkingTextMessageStartEvent:
                            thinkingBuffer = ""

                        case let e as ThinkingTextMessageContentEvent:
                            thinkingBuffer = (thinkingBuffer ?? "") + e.delta

                        case is ThinkingTextMessageEndEvent:
                            if let buffer = thinkingBuffer {
                                thinkingMessages.append(buffer)
                                thinkingBuffer = nil
                                continuation.yield(AgentState(
                                    thinking: ThinkingTelemetryState(
                                        isThinking: thinkingActive,
                                        title: thinkingTitle,
                                        messages: thinkingMessages
                                    )
                                ))
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

// MARK: - AssistantMessage Mutation Helpers

private extension AssistantMessage {
    func withContent(_ newContent: String) -> AssistantMessage {
        AssistantMessage(id: id, content: newContent, name: name, toolCalls: toolCalls)
    }

    func withAppendedToolCall(_ toolCall: ToolCall) -> AssistantMessage {
        var calls = toolCalls ?? []
        calls.append(toolCall)
        return AssistantMessage(id: id, content: content, name: name, toolCalls: calls)
    }

    func withUpdatedToolCallArguments(toolCallId: String, appendDelta: String) -> AssistantMessage {
        guard let calls = toolCalls else { return self }
        let updated = calls.map { call in
            if call.id == toolCallId {
                return ToolCall(
                    id: call.id,
                    function: FunctionCall(
                        name: call.function.name,
                        arguments: call.function.arguments + appendDelta
                    )
                )
            }
            return call
        }
        return AssistantMessage(id: id, content: content, name: name, toolCalls: updated)
    }
}
