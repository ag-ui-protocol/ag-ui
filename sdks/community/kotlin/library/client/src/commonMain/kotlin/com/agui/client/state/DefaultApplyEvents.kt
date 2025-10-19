package com.agui.client.state

import com.agui.client.agent.AgentState
import com.agui.client.agent.ThinkingTelemetryState
import com.agui.core.types.*
import com.reidsync.kxjsonpatch.JsonPatch
import kotlinx.coroutines.flow.*
import co.touchlab.kermit.Logger

private val logger = Logger.withTag("DefaultApplyEvents")

/**
 * Default implementation of event application logic with comprehensive event handling.
 * 
 * This function transforms a stream of AG-UI protocol events into a stream of agent states.
 * It handles all standard event types and maintains consistency between messages and state.
 * 
 * Key features:
 * - Handles all AG-UI protocol events (text messages, tool calls, state changes)
 * - Applies JSON Patch operations for state deltas
 * - Maintains message history and tool call tracking
 * - Surfaces RAW and CUSTOM events for application-level handling
 * - Provides error handling and recovery for state operations
 * - Integrates with custom state change handlers
 * 
 * Event Processing:
 * - Text message events: Build and update assistant messages incrementally
 * - Tool call events: Track tool calls and their arguments as they stream in
 * - State events: Apply snapshots and deltas using RFC 6902 JSON Patch
 * - RAW and CUSTOM events: Forward untyped and application-specific payloads
 * 
 * @param input The initial agent input containing messages, state, and configuration
 * @param events Stream of events from the agent to process
 * @param stateHandler Optional handler for state change notifications and error handling
 * @return Flow of agent states as events are processed
 * 
 * @see AgentState
 * @see BaseEvent
 * @see StateChangeHandler
 */
fun defaultApplyEvents(
    input: RunAgentInput,
    events: Flow<BaseEvent>,
    stateHandler: StateChangeHandler? = null
): Flow<AgentState> {
    // Mutable state copies
    val messages = input.messages.toMutableList()
    var state = input.state
    val rawEvents = mutableListOf<RawEvent>()
    val customEvents = mutableListOf<CustomEvent>()
    var thinkingActive = false
    var thinkingVisible = false
    var thinkingTitle: String? = null
    val thinkingMessages = mutableListOf<String>()
    var thinkingBuffer: StringBuilder? = null

    fun finalizeThinkingMessage() {
        thinkingBuffer?.toString()?.takeIf { it.isNotEmpty() }?.let {
            thinkingMessages.add(it)
        }
        thinkingBuffer = null
    }

    fun currentThinkingState(): ThinkingTelemetryState? {
        val inProgress = thinkingBuffer?.toString()
        val snapshot = mutableListOf<String>().apply {
            addAll(thinkingMessages)
            inProgress?.takeIf { it.isNotEmpty() }?.let { add(it) }
        }
        val active = thinkingActive || (inProgress?.isNotEmpty() == true)
        if (!thinkingVisible && !active && snapshot.isEmpty() && thinkingTitle == null) {
            return null
        }
        return ThinkingTelemetryState(
            isThinking = active,
            title = thinkingTitle,
            messages = snapshot
        )
    }
    
    return events.transform { event ->
        when (event) {
            is TextMessageStartEvent -> {
                messages.add(
                    AssistantMessage(
                        id = event.messageId,
                        content = ""
                    )
                )
                emit(AgentState(messages = messages.toList()))
            }
            
            is TextMessageContentEvent -> {
                val lastMessage = messages.lastOrNull() as? AssistantMessage
                if (lastMessage != null && lastMessage.id == event.messageId) {
                    messages[messages.lastIndex] = lastMessage.copy(
                        content = (lastMessage.content ?: "") + event.delta
                    )
                    emit(AgentState(messages = messages.toList()))
                }
            }
            
            is TextMessageEndEvent -> {
                // No state update needed
            }
            
            is ToolCallStartEvent -> {
                val targetMessage = when {
                    event.parentMessageId != null && 
                    messages.lastOrNull()?.id == event.parentMessageId -> {
                        messages.last() as? AssistantMessage
                    }
                    else -> null
                }
                
                if (targetMessage != null) {
                    val updatedCalls = (targetMessage.toolCalls ?: emptyList()) + ToolCall(
                        id = event.toolCallId,
                        function = FunctionCall(
                            name = event.toolCallName,
                            arguments = ""
                        )
                    )
                    messages[messages.lastIndex] = targetMessage.copy(toolCalls = updatedCalls)
                } else {
                    messages.add(
                        AssistantMessage(
                            id = event.parentMessageId ?: event.toolCallId,
                            content = null,
                            toolCalls = listOf(
                                ToolCall(
                                    id = event.toolCallId,
                                    function = FunctionCall(
                                        name = event.toolCallName,
                                        arguments = ""
                                    )
                                )
                            )
                        )
                    )
                }
                emit(AgentState(messages = messages.toList()))
            }
            
            is ToolCallArgsEvent -> {
                val lastMessage = messages.lastOrNull() as? AssistantMessage
                val toolCalls = lastMessage?.toolCalls?.toMutableList()
                val lastToolCall = toolCalls?.lastOrNull()
                
                if (lastToolCall != null && lastToolCall.id == event.toolCallId) {
                    val updatedCall = lastToolCall.copy(
                        function = lastToolCall.function.copy(
                            arguments = lastToolCall.function.arguments + event.delta
                        )
                    )
                    toolCalls[toolCalls.lastIndex] = updatedCall
                    messages[messages.lastIndex] = lastMessage.copy(toolCalls = toolCalls)
                    emit(AgentState(messages = messages.toList()))
                } else {
                    emit(AgentState(messages = messages.toList()))
                }
            }
            
            is ToolCallEndEvent -> {
                // No state update needed
            }
            
            is ToolCallResultEvent -> {
                val toolMessage = ToolMessage(
                    id = event.messageId,
                    content = event.content,
                    toolCallId = event.toolCallId,
                    name = event.role
                )
                messages.add(toolMessage)
                emit(AgentState(messages = messages.toList()))
            }

            is RunStartedEvent -> {
                thinkingActive = false
                thinkingVisible = false
                thinkingTitle = null
                thinkingMessages.clear()
                thinkingBuffer = null
                emit(AgentState(thinking = ThinkingTelemetryState(isThinking = false, title = null, messages = emptyList())))
            }
            
            is StateSnapshotEvent -> {
                state = event.snapshot
                stateHandler?.onStateSnapshot(state)
                emit(AgentState(state = state))
            }
            
            is StateDeltaEvent -> {
                try {
                    // Use JsonPatch library for proper patch application
                    state = JsonPatch.apply(event.delta, state)
                    stateHandler?.onStateDelta(event.delta)
                    emit(AgentState(state = state))
                } catch (e: Exception) {
                    logger.e(e) { "Failed to apply state delta" }
                    stateHandler?.onStateError(e, event.delta)
                }
            }
            
            is MessagesSnapshotEvent -> {
                messages.clear()
                messages.addAll(event.messages)
                emit(AgentState(messages = messages.toList()))
            }
            
            is RawEvent -> {
                rawEvents.add(event)
                emit(AgentState(rawEvents = rawEvents.toList()))
            }
            
            is CustomEvent -> {
                customEvents.add(event)
                emit(AgentState(customEvents = customEvents.toList()))
            }
            
            is ThinkingStartEvent -> {
                thinkingActive = true
                thinkingVisible = true
                thinkingTitle = event.title
                thinkingMessages.clear()
                thinkingBuffer = null
                currentThinkingState()?.let { emit(AgentState(thinking = it)) }
            }
            
            is ThinkingEndEvent -> {
                finalizeThinkingMessage()
                thinkingActive = false
                currentThinkingState()?.let { emit(AgentState(thinking = it)) }
            }
            
            is ThinkingTextMessageStartEvent -> {
                thinkingVisible = true
                if (!thinkingActive) {
                    thinkingActive = true
                }
                finalizeThinkingMessage()
                thinkingBuffer = StringBuilder()
                currentThinkingState()?.let { emit(AgentState(thinking = it)) }
            }
            
            is ThinkingTextMessageContentEvent -> {
                thinkingVisible = true
                if (!thinkingActive) {
                    thinkingActive = true
                }
                if (thinkingBuffer == null) {
                    thinkingBuffer = StringBuilder()
                }
                thinkingBuffer!!.append(event.delta)
                currentThinkingState()?.let { emit(AgentState(thinking = it)) }
            }
            
            is ThinkingTextMessageEndEvent -> {
                finalizeThinkingMessage()
                currentThinkingState()?.let { emit(AgentState(thinking = it)) }
            }
            
            else -> {
                // Other events don't affect state
            }
        }
    }
}
