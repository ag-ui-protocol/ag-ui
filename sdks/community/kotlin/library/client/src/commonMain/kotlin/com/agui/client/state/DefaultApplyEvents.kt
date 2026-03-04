package com.agui.client.state

import com.agui.client.agent.AbstractAgent
import com.agui.client.agent.AgentEventParams
import com.agui.client.agent.AgentState
import com.agui.client.agent.AgentStateMutation
import com.agui.client.agent.AgentSubscriber
import com.agui.client.agent.ThinkingTelemetryState
import com.agui.client.agent.runSubscribersWithMutation
import com.agui.core.types.*
import com.reidsync.kxjsonpatch.JsonPatch
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.transform
import co.touchlab.kermit.Logger

private val logger = Logger.withTag("DefaultApplyEvents")

private fun createStreamingMessage(messageId: String, role: Role): Message = when (role) {
    Role.DEVELOPER -> DeveloperMessage(id = messageId, content = "")
    Role.SYSTEM -> SystemMessage(id = messageId, content = "")
    Role.ASSISTANT -> AssistantMessage(id = messageId, content = "")
    Role.USER -> UserMessage(id = messageId, content = "")
    Role.TOOL -> ToolMessage(id = messageId, content = "", toolCallId = messageId)
    Role.ACTIVITY -> ActivityMessage(id = messageId, activityType = "", activityContent = kotlinx.serialization.json.JsonObject(emptyMap()))
}

private fun Message.appendDelta(delta: String): Message = when (this) {
    is DeveloperMessage -> copy(content = this.content + delta)
    is SystemMessage -> copy(content = (this.content ?: "") + delta)
    is AssistantMessage -> copy(content = (this.content ?: "") + delta)
    is UserMessage -> copy(content = this.content + delta)
    else -> this
}

fun defaultApplyEvents(
    input: RunAgentInput,
    events: Flow<BaseEvent>,
    stateHandler: StateChangeHandler? = null,
    agent: AbstractAgent? = null,
    subscribers: List<AgentSubscriber> = emptyList()
): Flow<AgentState> {
    val messages = input.messages.toMutableList()
    var state = input.state
    val rawEvents = mutableListOf<RawEvent>()
    val customEvents = mutableListOf<CustomEvent>()
    var thinkingActive = false
    var thinkingVisible = false
    var thinkingTitle: String? = null
    val thinkingMessages = mutableListOf<String>()
    var thinkingBuffer: StringBuilder? = null
    var initialMessagesEmitted = false

    logger.d {
        "defaultApplyEvents start: initial messages=${messages.joinToString { "${it.messageRole}:${it.id}" }} state=$state"
    }

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

    suspend fun dispatchToSubscribers(event: BaseEvent): AgentStateMutation {
        if (agent == null || subscribers.isEmpty()) {
            return AgentStateMutation()
        }
        return runSubscribersWithMutation(subscribers, messages.toList(), state) { subscriber, msgSnapshot, stateSnapshot ->
            subscriber.onEvent(
                AgentEventParams(
                    event = event,
                    messages = msgSnapshot,
                    state = stateSnapshot,
                    agent = agent,
                    input = input
                )
            )
        }
    }

    fun applySubscriberMutation(mutation: AgentStateMutation): Pair<Boolean, Boolean> {
        var messagesUpdated = false
        var stateUpdated = false
        mutation.messages?.let {
            messages.clear()
            messages.addAll(it)
            messagesUpdated = true
        }
        mutation.state?.let {
            state = it
            stateUpdated = true
        }
        return messagesUpdated to stateUpdated
    }

    return events.transform { event ->
        if (!initialMessagesEmitted && messages.isNotEmpty()) {
            emit(AgentState(messages = messages.toList()))
            initialMessagesEmitted = true
        }

        var emitted = false
        var subscriberMessagesUpdated = false
        var subscriberStateUpdated = false

        if (agent != null && subscribers.isNotEmpty()) {
            val mutation = dispatchToSubscribers(event)
            val (msgUpdated, stateUpdated) = applySubscriberMutation(mutation)
            subscriberMessagesUpdated = subscriberMessagesUpdated || msgUpdated
            subscriberStateUpdated = subscriberStateUpdated || stateUpdated
            if (mutation.stopPropagation) {
                if (subscriberMessagesUpdated || subscriberStateUpdated) {
                    emit(
                        AgentState(
                            messages = if (subscriberMessagesUpdated) messages.toList() else null,
                            state = if (subscriberStateUpdated) state else null
                        )
                    )
                    emitted = true
                }
                return@transform
            }
        }

        when (event) {
            is TextMessageStartEvent -> {
                val role = event.role
                messages.add(createStreamingMessage(event.messageId, role))
                logger.d {
                    "Added streaming message start id=${event.messageId} role=$role; messages=${messages.joinToString { it.id }}"
                }
                emit(AgentState(messages = messages.toList()))
                emitted = true
            }

            is TextMessageContentEvent -> {
                val index = messages.indexOfFirst { it.id == event.messageId }
                if (index >= 0) {
                    messages[index] = messages[index].appendDelta(event.delta)
                    logger.d {
                        val updated = messages[index]
                        val preview = when (updated) {
                            is AssistantMessage -> updated.content
                            is UserMessage -> updated.content
                            is SystemMessage -> updated.content ?: ""
                            is DeveloperMessage -> updated.content
                            else -> ""
                        }
                        "Updated message ${event.messageId} content='${preview?.take(80)}'"
                    }
                    emit(AgentState(messages = messages.toList()))
                    emitted = true
                } else {
                    logger.e { "Received content for unknown message ${event.messageId}; current ids=${messages.joinToString { it.id }}. Dropping delta: '${event.delta.take(80)}'" }
                }
            }

            is TextMessageEndEvent -> {
                // No state update needed
            }

            is ToolCallStartEvent -> {
                val parentIndex = event.parentMessageId?.let { id ->
                    messages.indexOfLast { it.id == id && it is AssistantMessage }
                } ?: messages.indexOfLast { it is AssistantMessage }

                val targetAssistant = parentIndex.takeIf { it >= 0 }?.let { messages[it] as AssistantMessage }

                if (targetAssistant != null) {
                    val updatedCalls = (targetAssistant.toolCalls ?: emptyList()) + ToolCall(
                        id = event.toolCallId,
                        function = FunctionCall(
                            name = event.toolCallName,
                            arguments = ""
                        )
                    )
                    messages[parentIndex] = targetAssistant.copy(toolCalls = updatedCalls)
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
                emitted = true
            }

            is ToolCallArgsEvent -> {
                val messageIndex = messages.indexOfLast { message ->
                    (message as? AssistantMessage)?.toolCalls?.any { it.id == event.toolCallId } == true
                }
                if (messageIndex >= 0) {
                    val assistantMessage = messages[messageIndex] as AssistantMessage
                    val updatedCalls = assistantMessage.toolCalls?.map { toolCall ->
                        if (toolCall.id == event.toolCallId) {
                            toolCall.copy(
                                function = toolCall.function.copy(
                                    arguments = toolCall.function.arguments + event.delta
                                )
                            )
                        } else {
                            toolCall
                        }
                    }
                    messages[messageIndex] = assistantMessage.copy(toolCalls = updatedCalls)
                }
                emit(AgentState(messages = messages.toList()))
                emitted = true
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
                emitted = true
            }

            is RunStartedEvent -> {
                thinkingActive = false
                thinkingVisible = false
                thinkingTitle = null
                thinkingMessages.clear()
                thinkingBuffer = null
                currentThinkingState()?.let {
                    emit(AgentState(thinking = it))
                    emitted = true
                } ?: run {
                    emit(AgentState(thinking = ThinkingTelemetryState(isThinking = false, title = null, messages = emptyList())))
                    emitted = true
                }
            }

            is StateSnapshotEvent -> {
                state = event.snapshot
                stateHandler?.onStateSnapshot(state)
                emit(AgentState(state = state))
                emitted = true
            }

            is StateDeltaEvent -> {
                try {
                    state = JsonPatch.apply(event.delta, state)
                    stateHandler?.onStateDelta(event.delta)
                    emit(AgentState(state = state))
                    emitted = true
                } catch (e: Exception) {
                    logger.e(e) { "Failed to apply state delta" }
                    stateHandler?.onStateError(e, event.delta)
                }
            }

            is MessagesSnapshotEvent -> {
                messages.clear()
                messages.addAll(event.messages)
                emit(AgentState(messages = messages.toList()))
                emitted = true
            }

            is RawEvent -> {
                rawEvents.add(event)
                emit(AgentState(rawEvents = rawEvents.toList()))
                emitted = true
            }

            is CustomEvent -> {
                customEvents.add(event)
                emit(AgentState(customEvents = customEvents.toList()))
                emitted = true
            }

            is ThinkingStartEvent -> {
                thinkingActive = true
                thinkingVisible = true
                thinkingTitle = event.title
                thinkingMessages.clear()
                thinkingBuffer = null
                currentThinkingState()?.let {
                    emit(AgentState(thinking = it))
                    emitted = true
                }
            }

            is ThinkingEndEvent -> {
                finalizeThinkingMessage()
                thinkingActive = false
                currentThinkingState()?.let {
                    emit(AgentState(thinking = it))
                    emitted = true
                }
            }

            is ThinkingTextMessageStartEvent -> {
                thinkingVisible = true
                if (!thinkingActive) {
                    thinkingActive = true
                }
                finalizeThinkingMessage()
                thinkingBuffer = StringBuilder()
                currentThinkingState()?.let {
                    emit(AgentState(thinking = it))
                    emitted = true
                }
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
                currentThinkingState()?.let {
                    emit(AgentState(thinking = it))
                    emitted = true
                }
            }

            is ThinkingTextMessageEndEvent -> {
                finalizeThinkingMessage()
                currentThinkingState()?.let {
                    emit(AgentState(thinking = it))
                    emitted = true
                }
            }

            else -> {
                // Other events don't affect state
            }
        }

        if (!emitted && (subscriberMessagesUpdated || subscriberStateUpdated)) {
            emit(
                AgentState(
                    messages = if (subscriberMessagesUpdated) messages.toList() else null,
                    state = if (subscriberStateUpdated) state else null
                )
            )
        }
    }
}
