package com.agui.client.chunks

import com.agui.core.types.*
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.flow
import kotlinx.serialization.json.JsonElement
import co.touchlab.kermit.Logger

private val logger = Logger.withTag("ChunkTransform")

private enum class ChunkMode { TEXT, TOOL }

private data class TextState(
    val messageId: String,
    var fromChunk: Boolean
)

private data class ToolState(
    val toolCallId: String,
    var fromChunk: Boolean
)

/**
 * Converts chunk events (`TEXT_MESSAGE_CHUNK`, `TOOL_CALL_CHUNK`) into structured
 * protocol sequences. Behaviour matches the TypeScript SDK so downstream processing
 * can assume standard start/content/end triads regardless of the upstream stream shape.
 */
fun Flow<BaseEvent>.transformChunks(debug: Boolean = false): Flow<BaseEvent> {
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
                val event = TextMessageEndEvent(
                    messageId = state.messageId,
                    timestamp = timestamp,
                    rawEvent = rawEvent
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
        if (mode == ChunkMode.TEXT) {
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
                    rawEvent = rawEvent
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
            ChunkMode.TEXT -> closeText(timestamp, rawEvent, emit)
            ChunkMode.TOOL -> closeTool(timestamp, rawEvent, emit)
            null -> Unit
        }
    }

    return flow {
        collect { event ->
            if (debug) {
                logger.d { "[CHUNK_TRANSFORM]: Processing ${event.eventType}" }
            }

            when (event) {
                is TextMessageChunkEvent -> {
                    val messageId = event.messageId
                    val delta = event.delta

                    val needsNewMessage = mode != ChunkMode.TEXT ||
                        (messageId != null && messageId != textState?.messageId)

                    if (needsNewMessage) {
                        closePending(event.timestamp, event.rawEvent, this@flow::emit)

                        if (messageId == null) {
                            throw IllegalArgumentException("First TEXT_MESSAGE_CHUNK must provide messageId")
                        }

                        emit(
                            TextMessageStartEvent(
                                messageId = messageId,
                                role = event.role ?: Role.ASSISTANT,
                                timestamp = event.timestamp,
                                rawEvent = event.rawEvent
                            )
                        )

                        mode = ChunkMode.TEXT
                        textState = TextState(messageId, fromChunk = true)
                    }

                    val activeMessageId = textState?.messageId ?: messageId
                        ?: throw IllegalArgumentException("Cannot emit TEXT_MESSAGE_CONTENT without messageId")

                    if (!delta.isNullOrEmpty()) {
                        emit(
                            TextMessageContentEvent(
                                messageId = activeMessageId,
                                delta = delta,
                                timestamp = event.timestamp,
                                rawEvent = event.rawEvent
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
                                rawEvent = event.rawEvent
                            )
                        )

                        mode = ChunkMode.TOOL
                        toolState = ToolState(toolId, fromChunk = true)
                    }

                    val activeToolCallId = toolState?.toolCallId ?: toolId
                        ?: throw IllegalArgumentException("Cannot emit TOOL_CALL_ARGS without toolCallId")

                    if (!delta.isNullOrEmpty()) {
                        emit(
                            ToolCallArgsEvent(
                                toolCallId = activeToolCallId,
                                delta = delta,
                                timestamp = event.timestamp,
                                rawEvent = event.rawEvent
                            )
                        )
                    }
                }

                is TextMessageStartEvent -> {
                    closePending(event.timestamp, event.rawEvent, this@flow::emit)
                    mode = ChunkMode.TEXT
                    textState = TextState(event.messageId, fromChunk = false)
                    emit(event)
                }

                is TextMessageContentEvent -> {
                    mode = ChunkMode.TEXT
                    textState = TextState(event.messageId, fromChunk = false)
                    emit(event)
                }

                is TextMessageEndEvent -> {
                    textState = null
                    if (mode == ChunkMode.TEXT) {
                        mode = null
                    }
                    emit(event)
                }

                is ToolCallStartEvent -> {
                    closePending(event.timestamp, event.rawEvent, this@flow::emit)
                    mode = ChunkMode.TOOL
                    toolState = ToolState(event.toolCallId, fromChunk = false)
                    emit(event)
                }

                is ToolCallArgsEvent -> {
                    mode = ChunkMode.TOOL
                    if (toolState?.toolCallId == event.toolCallId) {
                        toolState?.fromChunk = false
                    } else {
                        toolState = ToolState(event.toolCallId, fromChunk = false)
                    }
                    emit(event)
                }

                is ToolCallEndEvent -> {
                    toolState = null
                    if (mode == ChunkMode.TOOL) {
                        mode = null
                    }
                    emit(event)
                }

                is RawEvent -> {
                    // RAW passthrough without closing chunk state
                    emit(event)
                }

                else -> {
                    closePending(event.timestamp, event.rawEvent, this@flow::emit)
                    emit(event)
                }
            }
        }

        closePending(null, null, this@flow::emit)
    }
}
