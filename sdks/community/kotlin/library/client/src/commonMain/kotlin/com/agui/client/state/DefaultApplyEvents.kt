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

/**
 * Applies [delta] to [initialState] atomically.
 *
 * The delta is validated before any operation runs: every operation must be one of the six RFC 6902
 * operations with a well-formed `path` (and `from` for `copy`/`move`). Callers that tolerate unknown
 * operations must filter them out first. Every failure, including invalid input, is reported as
 * [JsonPatchApplicationException].
 */
internal fun applyStateDelta(delta: JsonArray, initialState: JsonElement): JsonElement {
    try {
        AgUiV1.validate("event", buildJsonObject {
            put("type", "STATE_DELTA")
            put("delta", delta)
        })
    } catch (e: IllegalArgumentException) {
        throw JsonPatchApplicationException("Invalid state delta: ${e.message}", e)
    } catch (e: IllegalStateException) {
        throw JsonPatchApplicationException("Invalid state delta: ${e.message}", e)
    }
    return try {
        applyValidatedStateDelta(delta, initialState)
    } catch (e: JsonPatchApplicationException) {
        throw e
    } catch (e: RuntimeException) {
        throw JsonPatchApplicationException("Failed to apply state delta: ${e.message}", e)
    }
}

private fun applyValidatedStateDelta(delta: JsonArray, initialState: JsonElement): JsonElement {
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
            ?: throw JsonPatchApplicationException("State delta '$name' at '$path' has no target document")
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
            "add" -> {
                requireStatePatchPath(currentState, path, allowAddition = true)
                candidate = writeStatePatch(currentState, tokens, operation.getValue("value"), adding = true)
            }
            "replace" -> {
                requireStatePatchPath(currentState, path)
                candidate = writeStatePatch(currentState, tokens, operation.getValue("value"), adding = false)
            }
            else -> throw JsonPatchApplicationException("Unsupported state delta operation '$name'")
        }
    }
    // Not an RFC 6902 rule: the application requires a state document after every delta.
    return candidate ?: throw JsonPatchApplicationException("State delta would leave an absent document")
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
    val token = tokens.last()
    return rewriteStatePatchParent(state, tokens, "Patch destination must have an object or array parent") { parent ->
        when (parent) {
            is JsonObject -> JsonObject(parent.toMutableMap().apply { this[token] = value })
            is JsonArray -> JsonArray(parent.toMutableList().apply {
                val index = if (token == "-") size else token.toInt()
                if (adding) add(index, value) else this[index] = value
            })
            else -> throw JsonPatchApplicationException("Patch destination must have an object or array parent")
        }
    }
}

/**
 * Replaces the parent of the location [tokens] points to with [rewrite]'s result, and copies every
 * container above it. Uses loops, not recursion: pointers are as long as the agent makes them, so
 * recursion here would overflow the stack on deeply nested state.
 */
private fun rewriteStatePatchParent(
    state: JsonElement,
    tokens: List<String>,
    notAContainer: String,
    rewrite: (JsonElement) -> JsonElement
): JsonElement {
    val ancestors = ArrayList<JsonElement>(tokens.lastIndex)
    var parent = state
    for (position in 0 until tokens.lastIndex) {
        ancestors.add(parent)
        val token = tokens[position]
        parent = when (parent) {
            is JsonObject -> parent.getValue(token)
            is JsonArray -> parent[token.toInt()]
            else -> throw JsonPatchApplicationException(notAContainer)
        }
    }
    var rewritten = rewrite(parent)
    for (position in ancestors.lastIndex downTo 0) {
        val token = tokens[position]
        val child = rewritten
        rewritten = when (val ancestor = ancestors[position]) {
            is JsonObject -> JsonObject(ancestor.toMutableMap().apply { this[token] = child })
            is JsonArray -> JsonArray(ancestor.toMutableList().apply { this[token.toInt()] = child })
            else -> throw JsonPatchApplicationException(notAContainer)
        }
    }
    return rewritten
}

private fun statePatchPathTokens(path: String): List<String> {
    if (path.isEmpty()) return emptyList()
    if (!path.startsWith("/")) throw JsonPatchApplicationException("Invalid JSON Pointer '$path'")
    return path.substring(1).split('/').map {
        it.replace("~1", "/").replace("~0", "~")
    }
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

private fun withoutStatePatchSource(state: JsonElement, path: List<String>): JsonElement {
    val token = path.last()
    return rewriteStatePatchParent(state, path, "State delta move source must have an object or array parent") { parent ->
        when (parent) {
            is JsonObject -> JsonObject(parent.toMutableMap().apply { remove(token) })
            is JsonArray -> JsonArray(parent.toMutableList().apply { removeAt(token.toInt()) })
            else -> throw JsonPatchApplicationException("State delta move source must have an object or array parent")
        }
    }
}

// Walks a work list, and only uses == on primitives: JsonObject and JsonArray equality recurses, so
// it would overflow the stack on deeply nested values.
private fun jsonElementsEqualWith(
    actual: JsonElement,
    expected: JsonElement,
    primitivesEqual: (JsonPrimitive, JsonPrimitive) -> Boolean
): Boolean {
    val pending = ArrayDeque<Pair<JsonElement, JsonElement>>()
    pending.addLast(actual to expected)
    while (pending.isNotEmpty()) {
        val (left, right) = pending.removeLast()
        when {
            left is JsonObject && right is JsonObject -> {
                if (left.keys != right.keys) return false
                left.forEach { (key, value) -> pending.addLast(value to right.getValue(key)) }
            }
            left is JsonArray && right is JsonArray -> {
                if (left.size != right.size) return false
                left.indices.forEach { index -> pending.addLast(left[index] to right[index]) }
            }
            left is JsonPrimitive && right is JsonPrimitive -> {
                if (!primitivesEqual(left, right)) return false
            }
            else -> return false
        }
    }
    return true
}

private fun jsonPatchValuesEqual(actual: JsonElement, expected: JsonElement): Boolean =
    jsonElementsEqualWith(actual, expected, ::jsonPatchPrimitivesEqual)

/**
 * Structural equality without recursing: JsonObject and JsonArray equality would overflow the
 * stack on deeply nested values, so this walks a work list instead. Unlike the JSON Patch `test`
 * operation, numbers compare by content (1 != 1.0), matching JsonElement's own equals — so it is
 * safe to use wherever StateFlow's conflation check would otherwise run.
 */
internal fun jsonElementsEqual(actual: JsonElement, expected: JsonElement): Boolean =
    jsonElementsEqualWith(actual, expected) { left, right -> left == right }

private fun jsonPatchPrimitivesEqual(actual: JsonPrimitive, expected: JsonPrimitive): Boolean {
    if (actual == expected) return true
    if (actual.isString || expected.isString) return false
    val actualNumber = normalizedJsonNumber(actual.content)
    return actualNumber != null && actualNumber == normalizedJsonNumber(expected.content)
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

/**
 * Applies [events] to the messages and state in [input] and emits the resulting [AgentState]s.
 *
 * A `STATE_DELTA` can fail in two ways, and they are handled differently:
 * - A malformed event fails the flow with [IllegalArgumentException] or [IllegalStateException] and
 *   does not reach [stateHandler]. This covers a malformed operation or JSON Pointer and an invalid
 *   event envelope, and it means the agent is not speaking the protocol.
 * - A well-formed delta that cannot be applied to the current state, such as one whose `path` does
 *   not exist, is reported through [StateChangeHandler.onStateError]. The previous state is kept and
 *   the run continues.
 *
 * Unknown operations are neither: they are dropped with a warning and the rest of the delta applies.
 */
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
        // The state is left out on purpose: JsonElement.toString recurses, so it overflows the stack on deep state.
        "defaultApplyEvents start: initial messages=${messages.joinToString { "${it.messageRole}:${it.id}" }}"
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
                // Outside the try below on purpose: a malformed event is fatal, not a state error.
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
