@file:Suppress("DEPRECATION")

package com.agui.client.state

import com.agui.client.agent.AbstractAgent
import com.agui.client.agent.AgentEventParams
import com.agui.client.agent.AgentState
import com.agui.client.agent.AgentStateMutation
import com.agui.client.agent.AgentSubscriber
import com.agui.client.agent.ReasoningEncryptedValue
import com.agui.client.agent.ReasoningStreamState
import com.agui.client.agent.ReasoningTelemetryState
import com.agui.client.agent.ThinkingTelemetryState
import com.agui.client.agent.runSubscribersWithMutation
import com.agui.core.types.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.transform
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import co.touchlab.kermit.Logger

private val logger = Logger.withTag("DefaultApplyEvents")

private fun createStreamingMessage(messageId: String, role: Role): Message = when (role) {
    Role.DEVELOPER -> DeveloperMessage(id = messageId, content = "")
    Role.SYSTEM -> SystemMessage(id = messageId, content = "")
    Role.ASSISTANT -> AssistantMessage(id = messageId, content = "")
    Role.USER -> UserMessage(id = messageId, content = "")
    Role.TOOL -> ToolMessage(id = messageId, content = "", toolCallId = messageId)
    Role.ACTIVITY -> ActivityMessage(id = messageId, activityType = "", activityContent = kotlinx.serialization.json.JsonObject(emptyMap()))
    Role.REASONING -> ReasoningMessage(id = messageId, content = "")
}

private fun Message.appendDelta(delta: String): Message = when (this) {
    is DeveloperMessage -> copy(content = this.content + delta)
    is SystemMessage -> copy(content = (this.content ?: "") + delta)
    is AssistantMessage -> copy(content = (this.content ?: "") + delta)
    is UserMessage -> copy(content = this.content + delta)
    else -> this
}

private fun mergeMetadata(previous: Metadata?, incoming: Metadata?): Metadata? =
    if (incoming == null) previous else JsonObject(previous.orEmpty() + incoming)

private fun Message.withEnvelope(incoming: Metadata?, owner: String?, speaker: String? = null): Message {
    val merged = mergeMetadata(metadata, incoming)
    val attribution = owner ?: subagentRunId
    return when (this) {
        is AssistantMessage -> copy(name = speaker ?: name, metadata = merged, subagentRunId = attribution)
        is UserMessage -> copy(name = speaker ?: name, metadata = merged, subagentRunId = attribution)
        is DeveloperMessage -> copy(name = speaker ?: name, metadata = merged, subagentRunId = attribution)
        is SystemMessage -> copy(name = speaker ?: name, metadata = merged, subagentRunId = attribution)
        is ToolMessage -> copy(metadata = merged, subagentRunId = attribution)
        is ReasoningMessage -> copy(metadata = merged, subagentRunId = attribution)
        is ActivityMessage -> copy(metadata = merged, subagentRunId = attribution)
    }
}

internal fun applyStateDelta(delta: JsonArray, initialState: JsonElement): JsonElement {
    // Kotlin null denotes an absent document; JsonNull remains a valid JSON value.
    var candidate: JsonElement? = initialState
    for (element in delta) {
        val operation = element.jsonObject
        val name = operation.getValue("op").jsonPrimitive.content
        val path = operation.getValue("path").jsonPrimitive.content
        if (name == "add" && path.isEmpty()) {
            candidate = operation.getValue("value")
            continue
        }
        val currentState = candidate
            ?: throw JsonPatchApplicationException("State delta '$name' at '$path' requires an existing document")
        val tokens = statePatchPathTokens(path)
        when (name) {
            "test" -> {
                val actual = statePatchValue(currentState, path)
                if (!jsonPatchValuesEqual(actual, operation.getValue("value"))) {
                    throw JsonPatchApplicationException("[TEST Operation] value mismatch at '$path'")
                }
            }
            "copy", "move" -> {
                val from = operation.getValue("from").jsonPrimitive.content
                val source = statePatchValue(currentState, from)
                val sourceTokens = statePatchPathTokens(from)
                if (name == "move" && sourceTokens == tokens) continue
                if (name == "move" && tokens.take(sourceTokens.size) == sourceTokens) {
                    throw JsonPatchApplicationException("State delta cannot move '$from' into its descendant '$path'")
                }
                val destination = if (name == "move") withoutStatePatchSource(currentState, sourceTokens) else currentState
                requireStatePatchPath(destination, path, allowAddition = true)
                candidate = writeStatePatch(destination, tokens, source, adding = true)
            }
            "remove" -> {
                requireStatePatchPath(currentState, path)
                candidate = if (tokens.isEmpty()) null else withoutStatePatchSource(currentState, tokens)
            }
            else -> {
                requireStatePatchPath(currentState, path, allowAddition = name == "add")
                candidate = writeStatePatch(currentState, tokens, operation.getValue("value"), adding = name == "add")
            }
        }
    }
    return candidate ?: throw JsonPatchApplicationException("State delta cannot leave the document absent")
}

private fun statePatchValue(state: JsonElement, path: String): JsonElement {
    requireStatePatchPath(state, path)
    return statePatchPathTokens(path).fold(state) { current, token ->
        when (current) {
            is JsonObject -> current.getValue(token)
            is JsonArray -> current[token.toInt()]
            else -> throw JsonPatchApplicationException("Invalid pointer '$path'")
        }
    }
}

private fun writeStatePatch(state: JsonElement, tokens: List<String>, value: JsonElement, adding: Boolean): JsonElement {
    if (tokens.isEmpty()) return value
    val token = tokens.first()
    val tail = tokens.drop(1)
    return when (state) {
        is JsonObject -> JsonObject(state.toMutableMap().apply {
            this[token] = if (tail.isEmpty()) value else writeStatePatch(getValue(token), tail, value, adding)
        })
        is JsonArray -> JsonArray(state.toMutableList().apply {
            val index = if (token == "-") size else token.toInt()
            if (tail.isNotEmpty()) this[index] = writeStatePatch(get(index), tail, value, adding)
            else if (adding) add(index, value) else this[index] = value
        })
        else -> throw JsonPatchApplicationException("Patch destination must have an object or array parent")
    }
}

private fun statePatchPathTokens(path: String): List<String> =
    if (path.isEmpty()) emptyList() else path.substring(1).split('/').map {
        it.replace("~1", "/").replace("~0", "~")
    }

private fun requireStatePatchPath(state: JsonElement, path: String, allowAddition: Boolean = false) {
    val tokens = statePatchPathTokens(path)
    var current = state
    for ((position, token) in tokens.withIndex()) {
        val adding = allowAddition && position == tokens.lastIndex
        current = when (current) {
            is JsonObject -> {
                if (adding) return
                current[token]
            }
            is JsonArray -> {
                if (adding && token == "-") return
                val index = token.toIntOrNull()
                val lastIndex = if (adding) current.size else current.lastIndex
                if (index == null || token != index.toString() || index !in 0..lastIndex) {
                    null
                } else {
                    if (adding) return
                    current[index]
                }
            }
            else -> null
        } ?: throw JsonPatchApplicationException("State delta path '$path' cannot resolve token $position ('$token')")
    }
}

private fun withoutStatePatchSource(state: JsonElement, path: List<String>, position: Int = 0): JsonElement {
    val token = path[position]
    val isLeaf = position == path.lastIndex
    return when (state) {
        is JsonObject -> JsonObject(state.toMutableMap().apply {
            if (isLeaf) remove(token)
            else this[token] = withoutStatePatchSource(getValue(token), path, position + 1)
        })
        is JsonArray -> JsonArray(state.toMutableList().apply {
            val index = token.toInt()
            if (isLeaf) removeAt(index)
            else this[index] = withoutStatePatchSource(get(index), path, position + 1)
        })
        else -> throw JsonPatchApplicationException("State delta move source must have an object or array parent")
    }
}

private fun jsonPatchValuesEqual(actual: JsonElement, expected: JsonElement): Boolean {
    if (actual == expected) return true
    return when {
        actual is JsonObject && expected is JsonObject ->
            actual.keys == expected.keys && actual.all { (key, value) ->
                jsonPatchValuesEqual(value, expected.getValue(key))
            }
        actual is JsonArray && expected is JsonArray ->
            actual.size == expected.size && actual.indices.all { index ->
                jsonPatchValuesEqual(actual[index], expected[index])
            }
        actual is JsonPrimitive && expected is JsonPrimitive && !actual.isString && !expected.isString -> {
            val actualNumber = normalizedJsonNumber(actual.content)
            actualNumber != null && actualNumber == normalizedJsonNumber(expected.content)
        }
        else -> false
    }
}

private val jsonNumberPattern = Regex("""(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?""")

private fun normalizedJsonNumber(value: String): Pair<String, String>? {
    val (sign, integer, fraction, exponent) = jsonNumberPattern.matchEntire(value)?.destructured ?: return null
    val digits = (integer + fraction).trimStart('0')
    if (digits.isEmpty()) return "0" to "0"
    val significantDigits = digits.trimEnd('0')
    val adjustment = digits.length - significantDigits.length - fraction.length
    return sign + significantDigits to adjustDecimalExponent(exponent.ifEmpty { "0" }, adjustment)
}

private fun adjustDecimalExponent(exponent: String, adjustment: Int): String {
    val negative = exponent.startsWith('-')
    val magnitude = exponent.removePrefix("-").removePrefix("+").trimStart('0').ifEmpty { "0" }
    // Ten digits plus an Int-sized adjustment fit safely in Long, including a sign change.
    if (magnitude.length <= 10) {
        val signedExponent = if (negative) -magnitude.toLong() else magnitude.toLong()
        return (signedExponent + adjustment.toLong()).toString()
    }

    // Larger exponents cannot change sign. Adjust their digits without expanding the number.
    var carry = if (negative) -adjustment.toLong() else adjustment.toLong()
    val reversed = StringBuilder()
    for (index in magnitude.lastIndex downTo 0) {
        val value = magnitude[index].digitToInt().toLong() + carry
        val digit = ((value % 10 + 10) % 10).toInt()
        reversed.append(digit)
        carry = (value - digit) / 10
    }
    if (carry != 0L) reversed.append(carry)
    val adjusted = reversed.reverse().toString().trimStart('0')
    return if (negative) "-$adjusted" else adjusted
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

    // Reasoning telemetry — per-messageId streams, ordered by first appearance.
    class MutableReasoningStream(
        val messageId: String,
        var isActive: Boolean = true,
        val text: StringBuilder = StringBuilder(),
        val encryptedValues: MutableList<ReasoningEncryptedValue> = mutableListOf()
    )
    val reasoningStreams = linkedMapOf<String, MutableReasoningStream>()
    var reasoningVisible = false
    var lastActiveReasoningMessageId: String? = null

    fun reasoningStream(messageId: String): MutableReasoningStream =
        reasoningStreams.getOrPut(messageId) { MutableReasoningStream(messageId) }

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

    fun currentReasoningState(): ReasoningTelemetryState? {
        if (!reasoningVisible && reasoningStreams.isEmpty()) return null
        return ReasoningTelemetryState(
            streams = reasoningStreams.values.map {
                ReasoningStreamState(
                    messageId = it.messageId,
                    isActive = it.isActive,
                    text = it.text.toString(),
                    encryptedValues = it.encryptedValues.toList()
                )
            }
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
                messages.add(createStreamingMessage(event.messageId, role).withEnvelope(event.metadata, event.subagentRunId, event.name))
                logger.d {
                    "Added streaming message start id=${event.messageId} role=$role; messages=${messages.joinToString { it.id }}"
                }
                emit(AgentState(messages = messages.toList()))
                emitted = true
            }

            is TextMessageContentEvent -> {
                val index = messages.indexOfFirst { it.id == event.messageId }
                if (index >= 0) {
                    messages[index] = messages[index].appendDelta(event.delta).withEnvelope(event.metadata, event.subagentRunId)
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
                val index = messages.indexOfLast { it.id == event.messageId }
                if (index >= 0) {
                    messages[index] = messages[index].withEnvelope(event.metadata, event.subagentRunId)
                    emit(AgentState(messages = messages.toList()))
                    emitted = true
                }
            }

            is ToolCallStartEvent -> {
                val parentIndex = event.parentMessageId?.let { id ->
                    messages.indexOfLast { it.id == id && it is AssistantMessage }
                } ?: messages.indexOfLast { it is AssistantMessage }

                val targetAssistant = parentIndex.takeIf { it >= 0 }?.let { messages[it] as AssistantMessage }

                if (targetAssistant != null) {
                    val updatedCalls = (targetAssistant.toolCalls ?: emptyList()) + ToolCall(
                        id = event.toolCallId,
                        metadata = event.metadata,
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
                            subagentRunId = event.subagentRunId,
                            content = null,
                            toolCalls = listOf(
                                ToolCall(
                                    id = event.toolCallId,
                                    metadata = event.metadata,
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
                                metadata = mergeMetadata(toolCall.metadata, event.metadata),
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
                for (index in messages.indices) {
                    val message = messages[index] as? AssistantMessage ?: continue
                    messages[index] = message.copy(toolCalls = message.toolCalls?.map {
                        if (it.id == event.toolCallId) it.copy(metadata = mergeMetadata(it.metadata, event.metadata)) else it
                    })
                }
                emit(AgentState(messages = messages.toList()))
                emitted = true
            }

            is ToolCallResultEvent -> {
                val toolMessage = ToolMessage(
                    id = event.messageId,
                    content = event.content,
                    toolCallId = event.toolCallId,
                    name = event.role,
                    contentParts = event.contentParts,
                    metadata = event.metadata,
                    subagentRunId = event.subagentRunId
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

                reasoningStreams.clear()
                reasoningVisible = false
                lastActiveReasoningMessageId = null
                emit(AgentState(reasoning = ReasoningTelemetryState(streams = emptyList())))
                emitted = true
            }

            is StateSnapshotEvent -> {
                state = event.snapshot
                stateHandler?.onStateSnapshot(state)
                emit(AgentState(state = state))
                emitted = true
            }

            is StateDeltaEvent -> {
                val delta = JsonArray(event.delta.filterIndexed { index, value ->
                    require(value is JsonObject) { "State delta operation at index $index must be an object" }
                    val op = value["op"]
                    require(op is JsonPrimitive && op.isString) {
                        "State delta operation at index $index requires a string op"
                    }
                    when (op.content) {
                        "add", "remove", "replace", "move", "copy", "test" -> true
                        else -> {
                            logger.w { "Unknown state delta operation '${op.content}' at index $index; dropping operation" }
                            false
                        }
                    }
                })
                // Validate the original JSON tree; serialization can coerce opaque numeric literals.
                AgUiV1.validate("event", buildJsonObject {
                    put("type", "STATE_DELTA")
                    put("delta", delta)
                    event.timestamp?.let { put("timestamp", it) }
                    event.rawEvent?.let { put("rawEvent", it) }
                    event.metadata?.let { put("metadata", it) }
                    event.subagentRunId?.let { put("subagentRunId", it) }
                })
                val patchedState = try {
                    applyStateDelta(delta, state)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    logger.w(e) { "Failed to apply state delta; preserving previous state" }
                    stateHandler?.onStateError(e, delta)
                    null
                }
                if (patchedState != null) {
                    state = patchedState
                    stateHandler?.onStateDelta(delta)
                    emit(AgentState(state = state))
                    emitted = true
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

            is ReasoningStartEvent -> {
                reasoningVisible = true
                val stream = reasoningStream(event.messageId)
                stream.isActive = true
                lastActiveReasoningMessageId = event.messageId
                currentReasoningState()?.let {
                    emit(AgentState(reasoning = it))
                    emitted = true
                }
            }

            is ReasoningMessageStartEvent -> {
                reasoningVisible = true
                val stream = reasoningStream(event.messageId)
                stream.isActive = true
                lastActiveReasoningMessageId = event.messageId
                currentReasoningState()?.let {
                    emit(AgentState(reasoning = it))
                    emitted = true
                }
            }

            is ReasoningMessageContentEvent -> {
                reasoningVisible = true
                val stream = reasoningStream(event.messageId)
                stream.isActive = true
                stream.text.append(event.delta)
                lastActiveReasoningMessageId = event.messageId
                currentReasoningState()?.let {
                    emit(AgentState(reasoning = it))
                    emitted = true
                }
            }

            is ReasoningMessageEndEvent -> {
                // Per-message end; keep stream open until REASONING_END.
                currentReasoningState()?.let {
                    emit(AgentState(reasoning = it))
                    emitted = true
                }
            }

            is ReasoningMessageChunkEvent -> {
                val messageId = event.messageId ?: lastActiveReasoningMessageId
                if (messageId != null) {
                    reasoningVisible = true
                    val stream = reasoningStream(messageId)
                    stream.isActive = true
                    event.delta?.let { stream.text.append(it) }
                    lastActiveReasoningMessageId = messageId
                    currentReasoningState()?.let {
                        emit(AgentState(reasoning = it))
                        emitted = true
                    }
                } else {
                    logger.w {
                        "Received REASONING_MESSAGE_CHUNK with no messageId and no active reasoning stream; dropping."
                    }
                }
            }

            is ReasoningEndEvent -> {
                val stream = reasoningStream(event.messageId)
                stream.isActive = false
                if (lastActiveReasoningMessageId == event.messageId) {
                    lastActiveReasoningMessageId = null
                }
                currentReasoningState()?.let {
                    emit(AgentState(reasoning = it))
                    emitted = true
                }
            }

            is ReasoningEncryptedValueEvent -> {
                for (index in messages.indices) {
                    val message = messages[index]
                    if (event.subtype == "message" && message.id == event.entityId) {
                        messages[index] = when (message) {
                            is AssistantMessage -> message.copy(encryptedValue = event.encryptedValue)
                            is UserMessage -> message.copy(encryptedValue = event.encryptedValue)
                            is SystemMessage -> message.copy(encryptedValue = event.encryptedValue)
                            is DeveloperMessage -> message.copy(encryptedValue = event.encryptedValue)
                            is ToolMessage -> message.copy(encryptedValue = event.encryptedValue)
                            is ReasoningMessage -> message.copy(encryptedValue = event.encryptedValue)
                            else -> message
                        }
                    } else if (event.subtype == "tool-call" && message is AssistantMessage) {
                        messages[index] = message.copy(toolCalls = message.toolCalls?.map {
                            if (it.id == event.entityId) it.copy(encryptedValue = event.encryptedValue) else it
                        })
                    }
                }
                emit(AgentState(messages = messages.toList()))
                emitted = true
                // The encrypted-value event has no messageId; attach to the most recently active stream.
                val targetMessageId = lastActiveReasoningMessageId
                    ?: reasoningStreams.values.lastOrNull { it.isActive }?.messageId
                    ?: reasoningStreams.values.lastOrNull()?.messageId
                if (targetMessageId != null) {
                    reasoningVisible = true
                    val stream = reasoningStream(targetMessageId)
                    stream.encryptedValues.add(
                        ReasoningEncryptedValue(
                            subtype = event.subtype,
                            entityId = event.entityId,
                            encryptedValue = event.encryptedValue
                        )
                    )
                    currentReasoningState()?.let {
                        emit(AgentState(reasoning = it))
                        emitted = true
                    }
                } else {
                    logger.w {
                        "Received REASONING_ENCRYPTED_VALUE with no reasoning stream to attach to; dropping (subtype=${event.subtype}, entityId=${event.entityId})."
                    }
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
