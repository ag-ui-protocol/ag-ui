package com.agui.client.chunks

import com.agui.core.types.*
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.flow
import kotlinx.serialization.json.JsonElement
import co.touchlab.kermit.Logger

private val logger = Logger.withTag("ChunkTransform")

private enum class ChunkMode { TEXT, TOOL, REASONING }

private data class TextState(
    val messageId: String,
    val role: Role,
    val name: String?,
    val subagentRunId: String?,
    val fromChunk: Boolean
)

private data class ToolState(
    val toolCallId: String,
    val toolCallName: String,
    val parentMessageId: String?,
    val subagentRunId: String?,
    val fromChunk: Boolean
)

/**
 * Converts text, tool-call, and reasoning chunks into structured
 * protocol sequences. Behaviour matches the TypeScript SDK so downstream processing
 * can assume standard start/content/end triads regardless of the upstream stream shape.
 */
fun Flow<BaseEvent>.transformChunks(debug: Boolean = false): Flow<BaseEvent> = flow {
    data class Lane(val mode: ChunkMode?, val text: TextState?, val tool: ToolState?)
    val lanes = linkedMapOf<String?, Lane>()
    var mode: ChunkMode? = null
    var textState: TextState? = null
    var toolState: ToolState? = null

    suspend fun closeText(
        timestamp: Long? = null,
        rawEvent: JsonElement? = null,
        emit: suspend (BaseEvent) -> Unit
    ) {
        val state = textState
        if (state != null) {
            if (state.fromChunk) {
                val event = if (mode == ChunkMode.REASONING) ReasoningMessageEndEvent(
                    messageId = state.messageId, timestamp = timestamp, rawEvent = rawEvent,
                    subagentRunId = state.subagentRunId
                ) else TextMessageEndEvent(
                    messageId = state.messageId,
                    timestamp = timestamp,
                    rawEvent = rawEvent,
                    subagentRunId = state.subagentRunId
                )
                if (debug) {
                    logger.d { "[CHUNK_TRANSFORM]: Emit TEXT_MESSAGE_END (${state.messageId})" }
                }
                emit(event)
            }
        } else if (debug) {
            logger.d { "[CHUNK_TRANSFORM]: No text state to close" }
        }
        textState = null
        if (mode == ChunkMode.TEXT || mode == ChunkMode.REASONING) {
            mode = null
        }
    }

    suspend fun closeTool(
        timestamp: Long? = null,
        rawEvent: JsonElement? = null,
        emit: suspend (BaseEvent) -> Unit
    ) {
        val state = toolState
        if (state != null) {
            if (state.fromChunk) {
                val event = ToolCallEndEvent(
                    toolCallId = state.toolCallId,
                    timestamp = timestamp,
                    rawEvent = rawEvent,
                    subagentRunId = state.subagentRunId
                )
                if (debug) {
                    logger.d { "[CHUNK_TRANSFORM]: Emit TOOL_CALL_END (${state.toolCallId})" }
                }
                emit(event)
            }
        } else if (debug) {
            logger.d { "[CHUNK_TRANSFORM]: No tool state to close" }
        }
        toolState = null
        if (mode == ChunkMode.TOOL) {
            mode = null
        }
    }

    suspend fun closePending(
        timestamp: Long? = null,
        rawEvent: JsonElement? = null,
        emit: suspend (BaseEvent) -> Unit
    ) {
        when (mode) {
            ChunkMode.TEXT, ChunkMode.REASONING -> closeText(timestamp, rawEvent, emit)
            ChunkMode.TOOL -> closeTool(timestamp, rawEvent, emit)
            null -> Unit
        }
    }

    this@transformChunks.collect { event ->
        // Omitted attribution on an explicit continuation inherits its named opener.
        // Anonymous chunks prefer an open parent lane, or the sole active lane.
        val entityId = when (event) {
            is TextMessageChunkEvent -> event.messageId
            is ToolCallChunkEvent -> event.toolCallId
            is ReasoningMessageChunkEvent -> event.messageId
            is TextMessageContentEvent -> event.messageId
            is TextMessageEndEvent -> event.messageId
            is ToolCallArgsEvent -> event.toolCallId
            is ToolCallEndEvent -> event.toolCallId
            is ReasoningMessageContentEvent -> event.messageId
            is ReasoningMessageEndEvent -> event.messageId
            else -> null
        }
        val namedLane = entityId?.let { id ->
            lanes.entries.firstOrNull { it.value.text?.messageId == id || it.value.tool?.toolCallId == id }
        }
        if (namedLane != null && event.subagentRunId != null && namedLane.key != event.subagentRunId) {
            throw IllegalArgumentException("Chunk attribution disagrees with its opener")
        }
        val anonymousChunk = entityId == null && (event is TextMessageChunkEvent ||
            event is ToolCallChunkEvent || event is ReasoningMessageChunkEvent)
        val activeLanes = lanes.filterValues { it.mode != null }
        val owner = when {
            event.subagentRunId != null -> event.subagentRunId
            namedLane != null -> namedLane.key
            anonymousChunk && null !in activeLanes -> {
                require(activeLanes.size <= 1) { "Anonymous chunk has ambiguous attribution" }
                activeLanes.keys.singleOrNull()
            }
            else -> null
        }
        val lane = lanes[owner]
        mode = lane?.mode
        textState = lane?.text
        toolState = lane?.tool
        if (event is RunFinishedEvent || event is RunErrorEvent) {
            for (pending in lanes.values) {
                mode = pending.mode; textState = pending.text; toolState = pending.tool
                closePending(event.timestamp, event.rawEvent, this@flow::emit)
            }
            lanes.clear()
        }
        if (debug) {
            logger.d { "[CHUNK_TRANSFORM]: Processing ${event.eventType}" }
        }

        when (event) {
            is ReasoningMessageChunkEvent -> {
                val needsNew = mode != ChunkMode.REASONING ||
                    (event.messageId != null && event.messageId != textState?.messageId)
                if (!needsNew && textState?.fromChunk == false) {
                    throw IllegalArgumentException("Cannot continue explicit reasoning with a chunk")
                }
                if (needsNew) {
                    closePending(event.timestamp, event.rawEvent, this@flow::emit)
                    val id = event.messageId ?: throw IllegalArgumentException("First REASONING_MESSAGE_CHUNK must provide messageId")
                    emit(ReasoningMessageStartEvent(id, timestamp = event.timestamp, rawEvent = event.rawEvent,
                        metadata = event.metadata, subagentRunId = owner))
                    mode = ChunkMode.REASONING
                    textState = TextState(id, Role.REASONING, null, owner, true)
                }
                if (!event.delta.isNullOrEmpty() || event.metadata != null) {
                    emit(ReasoningMessageContentEvent(textState!!.messageId, event.delta.orEmpty(),
                        timestamp = event.timestamp, rawEvent = event.rawEvent,
                        metadata = event.metadata, subagentRunId = owner))
                }
            }
            is ReasoningMessageStartEvent -> {
                if (mode == ChunkMode.REASONING && textState?.fromChunk == true && textState?.messageId == event.messageId) {
                    throw IllegalArgumentException("Cannot explicitly start reasoning opened by a chunk")
                }
                closePending(event.timestamp, event.rawEvent, this@flow::emit)
                mode = ChunkMode.REASONING
                textState = TextState(event.messageId, Role.REASONING, null, owner, false)
                emit(event)
            }
            is ReasoningMessageContentEvent, is ReasoningMessageEndEvent -> {
                closePending(event.timestamp, event.rawEvent, this@flow::emit)
                emit(event)
            }
            is TextMessageChunkEvent -> {
                val messageId = event.messageId
                val delta = event.delta

                val needsNewMessage = mode != ChunkMode.TEXT ||
                    (messageId != null && messageId != textState?.messageId)

                if (!needsNewMessage && textState?.fromChunk == false) {
                    throw IllegalArgumentException("Cannot continue an explicit text message with a chunk")
                }
                if (!needsNewMessage && event.role != null && event.role != textState?.role) {
                    throw IllegalArgumentException("TEXT_MESSAGE_CHUNK role disagrees with its opener")
                }
                if (!needsNewMessage && event.name != null && event.name != textState?.name) {
                    throw IllegalArgumentException("TEXT_MESSAGE_CHUNK name disagrees with its opener")
                }
                if (!needsNewMessage && event.subagentRunId != null && event.subagentRunId != textState?.subagentRunId) {
                    throw IllegalArgumentException("TEXT_MESSAGE_CHUNK subagentRunId disagrees with its opener")
                }

                if (needsNewMessage) {
                    closePending(event.timestamp, event.rawEvent, this@flow::emit)

                    if (messageId == null) {
                        throw IllegalArgumentException("First TEXT_MESSAGE_CHUNK must provide messageId")
                    }

                    emit(
                        TextMessageStartEvent(
                            messageId = messageId,
                            role = event.role ?: Role.ASSISTANT,
                            name = event.name,
                            timestamp = event.timestamp,
                            rawEvent = event.rawEvent,
                            metadata = event.metadata,
                            subagentRunId = event.subagentRunId
                        )
                    )

                    mode = ChunkMode.TEXT
                    textState = TextState(messageId, event.role ?: Role.ASSISTANT, event.name, event.subagentRunId, fromChunk = true)
                }

                val activeMessageId = textState?.messageId ?: messageId
                    ?: throw IllegalArgumentException("Cannot emit TEXT_MESSAGE_CONTENT without messageId")

                if (!delta.isNullOrEmpty() || event.metadata != null) {
                    emit(
                        TextMessageContentEvent(
                            messageId = activeMessageId,
                            delta = delta.orEmpty(),
                            timestamp = event.timestamp,
                            rawEvent = event.rawEvent,
                            metadata = event.metadata,
                            subagentRunId = textState?.subagentRunId
                        )
                    )
                }
            }

            is ToolCallChunkEvent -> {
                val toolId = event.toolCallId
                val toolName = event.toolCallName
                val delta = event.delta

                val needsNewToolCall = mode != ChunkMode.TOOL ||
                    (toolId != null && toolId != toolState?.toolCallId)

                if (!needsNewToolCall && toolState?.fromChunk == false) {
                    throw IllegalArgumentException("Cannot continue an explicit tool call with a chunk")
                }
                if (!needsNewToolCall && toolName != null && toolName != toolState?.toolCallName) {
                    throw IllegalArgumentException("TOOL_CALL_CHUNK name disagrees with its opener")
                }
                if (!needsNewToolCall && event.parentMessageId != null && event.parentMessageId != toolState?.parentMessageId) {
                    throw IllegalArgumentException("TOOL_CALL_CHUNK parentMessageId disagrees with its opener")
                }
                if (!needsNewToolCall && event.subagentRunId != null && event.subagentRunId != toolState?.subagentRunId) {
                    throw IllegalArgumentException("TOOL_CALL_CHUNK subagentRunId disagrees with its opener")
                }

                if (needsNewToolCall) {
                    closePending(event.timestamp, event.rawEvent, this@flow::emit)

                    if (toolId == null || toolName == null) {
                        throw IllegalArgumentException("First TOOL_CALL_CHUNK must provide toolCallId and toolCallName")
                    }

                    emit(
                        ToolCallStartEvent(
                            toolCallId = toolId,
                            toolCallName = toolName,
                            parentMessageId = event.parentMessageId,
                            timestamp = event.timestamp,
                            rawEvent = event.rawEvent,
                            metadata = event.metadata,
                            subagentRunId = event.subagentRunId
                        )
                    )

                    mode = ChunkMode.TOOL
                    toolState = ToolState(toolId, toolName, event.parentMessageId, event.subagentRunId, fromChunk = true)
                }

                val activeToolCallId = toolState?.toolCallId ?: toolId
                    ?: throw IllegalArgumentException("Cannot emit TOOL_CALL_ARGS without toolCallId")

                if (!delta.isNullOrEmpty() || event.metadata != null) {
                    emit(
                        ToolCallArgsEvent(
                            toolCallId = activeToolCallId,
                            delta = delta.orEmpty(),
                            timestamp = event.timestamp,
                            rawEvent = event.rawEvent,
                            metadata = event.metadata,
                            subagentRunId = toolState?.subagentRunId
                        )
                    )
                }
            }

            is TextMessageStartEvent -> {
                if (textState?.fromChunk == true && textState?.messageId == event.messageId) {
                    throw IllegalArgumentException("Cannot explicitly start a text message opened by a chunk")
                }
                closePending(event.timestamp, event.rawEvent, this@flow::emit)
                mode = ChunkMode.TEXT
                textState = TextState(event.messageId, event.role, event.name, event.subagentRunId, fromChunk = false)
                emit(event)
            }

            is TextMessageContentEvent -> {
                val state = textState
                closePending(event.timestamp, event.rawEvent, this@flow::emit)
                mode = ChunkMode.TEXT
                textState = TextState(
                    event.messageId,
                    state?.role ?: Role.ASSISTANT,
                    state?.name,
                    if (state != null && state.messageId == event.messageId) state.subagentRunId else event.subagentRunId,
                    fromChunk = false
                )
                emit(event)
            }

            is TextMessageEndEvent -> {
                closePending(event.timestamp, event.rawEvent, this@flow::emit)
                textState = null
                if (mode == ChunkMode.TEXT || mode == ChunkMode.REASONING) {
                    mode = null
                }
                emit(event)
            }

            is ToolCallStartEvent -> {
                if (toolState?.fromChunk == true && toolState?.toolCallId == event.toolCallId) {
                    throw IllegalArgumentException("Cannot explicitly start a tool call opened by a chunk")
                }
                closePending(event.timestamp, event.rawEvent, this@flow::emit)
                mode = ChunkMode.TOOL
                toolState = ToolState(event.toolCallId, event.toolCallName, event.parentMessageId, event.subagentRunId, fromChunk = false)
                emit(event)
            }

            is ToolCallArgsEvent -> {
                val state = toolState
                closePending(event.timestamp, event.rawEvent, this@flow::emit)
                mode = ChunkMode.TOOL
                if (state != null && state.toolCallId == event.toolCallId) {
                    toolState = state.copy(fromChunk = false)
                } else {
                    toolState = ToolState(
                        event.toolCallId,
                        state?.toolCallName ?: "",
                        parentMessageId = null,
                        subagentRunId = event.subagentRunId,
                        fromChunk = false
                    )
                }
                emit(event)
            }

            is ToolCallEndEvent -> {
                closePending(event.timestamp, event.rawEvent, this@flow::emit)
                toolState = null
                if (mode == ChunkMode.TOOL) {
                    mode = null
                }
                emit(event)
            }

            is RawEvent, is SubagentStartedEvent -> {
                // RAW passthrough without closing chunk state
                emit(event)
            }

            else -> {
                closePending(event.timestamp, event.rawEvent, this@flow::emit)
                emit(event)
            }
        }
        lanes[owner] = Lane(mode, textState, toolState)
    }

    for (pending in lanes.values) {
        mode = pending.mode; textState = pending.text; toolState = pending.tool
        closePending(null, null, this@flow::emit)
    }
}
