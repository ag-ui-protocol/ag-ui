package com.agui.client.chunks

import com.agui.core.types.*
import kotlinx.coroutines.flow.*
import co.touchlab.kermit.Logger

private val logger = Logger.withTag("ChunkTransform")

/**
 * Transforms chunk events (TEXT_MESSAGE_CHUNK, TOOL_CALL_CHUNK) into structured event sequences.
 * 
 * This transform handles automatic start/end sequences for chunk events:
 * - TEXT_MESSAGE_CHUNK events are converted into TEXT_MESSAGE_START/CONTENT/END sequences
 * - TOOL_CALL_CHUNK events are converted into TOOL_CALL_START/ARGS/END sequences
 * 
 * The transform maintains state to track active sequences and only starts new sequences
 * when no active sequence exists or when IDs change. This allows chunk events to
 * integrate seamlessly with existing message/tool call flows.
 * 
 * @param debug Whether to enable debug logging
 * @return Flow<BaseEvent> with chunk events transformed into structured sequences
 */
fun Flow<BaseEvent>.transformChunks(debug: Boolean = false): Flow<BaseEvent> {
    // State tracking for active sequences
    var mode: String? = null  // "text" or "tool"
    var textMessageId: String? = null
    var toolCallId: String? = null
    var toolCallName: String? = null
    var parentMessageId: String? = null
    
    return transform { event ->
        if (debug) {
            logger.d { "[CHUNK_TRANSFORM]: Processing ${event.eventType}" }
        }
        
        when (event) {
            is TextMessageChunkEvent -> {
                val messageId = event.messageId
                val delta = event.delta
                
                // Determine if we need to start a new text message
                val needsNewTextMessage = mode != "text" || 
                    (messageId != null && messageId != textMessageId)
                
                if (needsNewTextMessage) {
                    if (debug) {
                        logger.d { "[CHUNK_TRANSFORM]: Starting new text message (id: $messageId)" }
                    }
                    
                    // Close any existing tool call sequence first
                    if (mode == "tool" && toolCallId != null) {
                        emit(ToolCallEndEvent(
                            toolCallId = toolCallId!!,
                            timestamp = event.timestamp,
                            rawEvent = event.rawEvent
                        ))
                    }
                    
                    // Require messageId for the first chunk of a new message
                    if (messageId == null) {
                        throw IllegalArgumentException("messageId is required for TEXT_MESSAGE_CHUNK when starting a new text message")
                    }
                    
                    // Start new text message
                    emit(TextMessageStartEvent(
                        messageId = messageId,
                        timestamp = event.timestamp,
                        rawEvent = event.rawEvent
                    ))
                    
                    mode = "text"
                    textMessageId = messageId
                }
                
                // Generate content event if delta is present
                if (delta != null) {
                    val currentMessageId = textMessageId ?: messageId
                    if (currentMessageId == null) {
                        throw IllegalArgumentException("Cannot generate TEXT_MESSAGE_CONTENT without a messageId")
                    }
                    
                    emit(TextMessageContentEvent(
                        messageId = currentMessageId,
                        delta = delta,
                        timestamp = event.timestamp,
                        rawEvent = event.rawEvent
                    ))
                }
            }
            
            is ToolCallChunkEvent -> {
                val toolId = event.toolCallId
                val toolName = event.toolCallName
                val delta = event.delta
                val parentMsgId = event.parentMessageId
                
                // Determine if we need to start a new tool call
                val needsNewToolCall = mode != "tool" || 
                    (toolId != null && toolId != toolCallId)
                
                if (needsNewToolCall) {
                    if (debug) {
                        logger.d { "[CHUNK_TRANSFORM]: Starting new tool call (id: $toolId, name: $toolName)" }
                    }
                    
                    // Close any existing text message sequence first
                    if (mode == "text" && textMessageId != null) {
                        emit(TextMessageEndEvent(
                            messageId = textMessageId!!,
                            timestamp = event.timestamp,
                            rawEvent = event.rawEvent
                        ))
                    }
                    
                    // Require toolCallId and toolCallName for the first chunk of a new tool call
                    if (toolId == null || toolName == null) {
                        throw IllegalArgumentException("toolCallId and toolCallName are required for TOOL_CALL_CHUNK when starting a new tool call")
                    }
                    
                    // Start new tool call
                    emit(ToolCallStartEvent(
                        toolCallId = toolId,
                        toolCallName = toolName,
                        parentMessageId = parentMsgId,
                        timestamp = event.timestamp,
                        rawEvent = event.rawEvent
                    ))
                    
                    mode = "tool"
                    toolCallId = toolId
                    toolCallName = toolName
                    parentMessageId = parentMsgId
                }
                
                // Generate args event if delta is present
                if (delta != null) {
                    val currentToolCallId = toolCallId ?: toolId
                    if (currentToolCallId == null) {
                        throw IllegalArgumentException("Cannot generate TOOL_CALL_ARGS without a toolCallId")
                    }
                    
                    emit(ToolCallArgsEvent(
                        toolCallId = currentToolCallId,
                        delta = delta,
                        timestamp = event.timestamp,
                        rawEvent = event.rawEvent
                    ))
                }
            }
            
            // Track state changes from regular events to maintain consistency
            is TextMessageStartEvent -> {
                mode = "text"
                textMessageId = event.messageId
                emit(event)
            }
            
            is TextMessageEndEvent -> {
                if (mode == "text" && textMessageId == event.messageId) {
                    mode = null
                    textMessageId = null
                }
                emit(event)
            }
            
            is ToolCallStartEvent -> {
                mode = "tool"
                toolCallId = event.toolCallId
                toolCallName = event.toolCallName
                parentMessageId = event.parentMessageId
                emit(event)
            }
            
            is ToolCallEndEvent -> {
                if (mode == "tool" && toolCallId == event.toolCallId) {
                    mode = null
                    toolCallId = null
                    toolCallName = null
                    parentMessageId = null
                }
                emit(event)
            }
            
            else -> {
                // Pass through all other events unchanged
                emit(event)
            }
        }
    }
}