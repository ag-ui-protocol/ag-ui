package com.agui.client.verify

import com.agui.core.types.*
import kotlinx.coroutines.flow.*
import co.touchlab.kermit.Logger

private val logger = Logger.withTag("EventVerifier")

/**
 * Custom error class for AG-UI protocol violations.
 * Thrown when events don't follow the proper AG-UI protocol state machine rules.
 * 
 * @param message Descriptive error message explaining the protocol violation
 */
class AGUIError(message: String) : Exception(message)

/**
 * Verifies that events follow the AG-UI protocol rules.
 * Implements a state machine to track valid event sequences.
 * Ensures proper event ordering, validates message and tool call lifecycles,
 * thinking step lifecycles, and prevents protocol violations like 
 * multiple RUN_STARTED events or thinking events outside thinking steps.
 * 
 * @param debug Whether to enable debug logging for event verification
 * @return Flow<BaseEvent> the same event flow after validation
 * @throws AGUIError when events violate the AG-UI protocol state machine
 */
fun Flow<BaseEvent>.verifyEvents(debug: Boolean = false): Flow<BaseEvent> {
    // State tracking
    var activeMessageId: String? = null
    var activeToolCallId: String? = null
    var runFinished = false
    var runError = false
    var firstEventReceived = false
    val activeSteps = mutableMapOf<String, Boolean>()
    var activeThinkingStep = false
    var activeThinkingStepMessage = false
    
    return transform { event ->
        val eventType = event.eventType
        
        if (debug) {
            logger.d { "[VERIFY]: $event" }
        }
        
        // Check if run has errored
        if (runError) {
            throw AGUIError(
                "Cannot send event type '$eventType': The run has already errored with 'RUN_ERROR'. No further events can be sent."
            )
        }
        
        // Check if run has already finished
        if (runFinished && eventType != EventType.RUN_ERROR) {
            throw AGUIError(
                "Cannot send event type '$eventType': The run has already finished with 'RUN_FINISHED'."
            )
        }
        
        // Validate events inside text messages
        if (activeMessageId != null) {
            val allowedInMessage = setOf(
                EventType.TEXT_MESSAGE_CONTENT,
                EventType.TEXT_MESSAGE_END,
                EventType.RAW
            )
            
            if (eventType !in allowedInMessage) {
                throw AGUIError(
                    "Cannot send event type '$eventType' after 'TEXT_MESSAGE_START': Send 'TEXT_MESSAGE_END' first."
                )
            }
        }
        
        // Validate events inside thinking text messages
        if (activeThinkingStepMessage) {
            val allowedInThinkingMessage = setOf(
                EventType.THINKING_TEXT_MESSAGE_CONTENT,
                EventType.THINKING_TEXT_MESSAGE_END,
                EventType.RAW
            )
            
            if (eventType !in allowedInThinkingMessage) {
                throw AGUIError(
                    "Cannot send event type '$eventType' after 'THINKING_TEXT_MESSAGE_START': Send 'THINKING_TEXT_MESSAGE_END' first."
                )
            }
        }
        
        // Validate events inside tool calls
        if (activeToolCallId != null) {
            val allowedInToolCall = setOf(
                EventType.TOOL_CALL_ARGS,
                EventType.TOOL_CALL_END,
                EventType.RAW
            )
            
            if (eventType !in allowedInToolCall) {
                if (eventType == EventType.TOOL_CALL_START) {
                    throw AGUIError(
                        "Cannot send 'TOOL_CALL_START' event: A tool call is already in progress. Complete it with 'TOOL_CALL_END' first."
                    )
                }
                throw AGUIError(
                    "Cannot send event type '$eventType' after 'TOOL_CALL_START': Send 'TOOL_CALL_END' first."
                )
            }
        }
        
        // First event validation
        if (!firstEventReceived) {
            firstEventReceived = true
            if (eventType != EventType.RUN_STARTED && eventType != EventType.RUN_ERROR) {
                throw AGUIError("First event must be 'RUN_STARTED'")
            }
        } else if (eventType == EventType.RUN_STARTED) {
            throw AGUIError("Cannot send multiple 'RUN_STARTED' events")
        }
        
        // Event-specific validation
        when (event) {
            is TextMessageStartEvent -> {
                if (activeMessageId != null) {
                    throw AGUIError(
                        "Cannot send 'TEXT_MESSAGE_START' event: A text message is already in progress. Complete it with 'TEXT_MESSAGE_END' first."
                    )
                }
                activeMessageId = event.messageId
            }
            
            is TextMessageContentEvent -> {
                if (activeMessageId == null) {
                    throw AGUIError(
                        "Cannot send 'TEXT_MESSAGE_CONTENT' event: No active text message found. Start a text message with 'TEXT_MESSAGE_START' first."
                    )
                }
                if (event.messageId != activeMessageId) {
                    throw AGUIError(
                        "Cannot send 'TEXT_MESSAGE_CONTENT' event: Message ID mismatch. The ID '${event.messageId}' doesn't match the active message ID '$activeMessageId'."
                    )
                }
            }
            
            is TextMessageEndEvent -> {
                if (activeMessageId == null) {
                    throw AGUIError(
                        "Cannot send 'TEXT_MESSAGE_END' event: No active text message found. A 'TEXT_MESSAGE_START' event must be sent first."
                    )
                }
                if (event.messageId != activeMessageId) {
                    throw AGUIError(
                        "Cannot send 'TEXT_MESSAGE_END' event: Message ID mismatch. The ID '${event.messageId}' doesn't match the active message ID '$activeMessageId'."
                    )
                }
                activeMessageId = null
            }
            
            is ToolCallStartEvent -> {
                if (activeToolCallId != null) {
                    throw AGUIError(
                        "Cannot send 'TOOL_CALL_START' event: A tool call is already in progress. Complete it with 'TOOL_CALL_END' first."
                    )
                }
                activeToolCallId = event.toolCallId
            }
            
            is ToolCallArgsEvent -> {
                if (activeToolCallId == null) {
                    throw AGUIError(
                        "Cannot send 'TOOL_CALL_ARGS' event: No active tool call found. Start a tool call with 'TOOL_CALL_START' first."
                    )
                }
                if (event.toolCallId != activeToolCallId) {
                    throw AGUIError(
                        "Cannot send 'TOOL_CALL_ARGS' event: Tool call ID mismatch. The ID '${event.toolCallId}' doesn't match the active tool call ID '$activeToolCallId'."
                    )
                }
            }
            
            is ToolCallEndEvent -> {
                if (activeToolCallId == null) {
                    throw AGUIError(
                        "Cannot send 'TOOL_CALL_END' event: No active tool call found. A 'TOOL_CALL_START' event must be sent first."
                    )
                }
                if (event.toolCallId != activeToolCallId) {
                    throw AGUIError(
                        "Cannot send 'TOOL_CALL_END' event: Tool call ID mismatch. The ID '${event.toolCallId}' doesn't match the active tool call ID '$activeToolCallId'."
                    )
                }
                activeToolCallId = null
            }
            
            is StepStartedEvent -> {
                val stepName = event.stepName
                if (activeSteps.containsKey(stepName)) {
                    throw AGUIError("Step \"$stepName\" is already active for 'STEP_STARTED'")
                }
                activeSteps[stepName] = true
            }
            
            is StepFinishedEvent -> {
                val stepName = event.stepName
                if (!activeSteps.containsKey(stepName)) {
                    throw AGUIError(
                        "Cannot send 'STEP_FINISHED' for step \"$stepName\" that was not started"
                    )
                }
                activeSteps.remove(stepName)
            }
            
            is RunFinishedEvent -> {
                if (activeSteps.isNotEmpty()) {
                    val unfinishedSteps = activeSteps.keys.joinToString(", ")
                    throw AGUIError(
                        "Cannot send 'RUN_FINISHED' while steps are still active: $unfinishedSteps"
                    )
                }
                runFinished = true
            }
            
            is RunErrorEvent -> {
                runError = true
            }
            
            // Thinking Events Validation
            is ThinkingStartEvent -> {
                if (activeThinkingStep) {
                    throw AGUIError(
                        "Cannot send 'THINKING_START' event: A thinking step is already in progress. Complete it with 'THINKING_END' first."
                    )
                }
                activeThinkingStep = true
            }
            
            is ThinkingEndEvent -> {
                if (!activeThinkingStep) {
                    throw AGUIError(
                        "Cannot send 'THINKING_END' event: No active thinking step found. A 'THINKING_START' event must be sent first."
                    )
                }
                activeThinkingStep = false
            }
            
            is ThinkingTextMessageStartEvent -> {
                if (!activeThinkingStep) {
                    throw AGUIError(
                        "Cannot send 'THINKING_TEXT_MESSAGE_START' event: No active thinking step found. A 'THINKING_START' event must be sent first."
                    )
                }
                if (activeThinkingStepMessage) {
                    throw AGUIError(
                        "Cannot send 'THINKING_TEXT_MESSAGE_START' event: A thinking text message is already in progress. Complete it with 'THINKING_TEXT_MESSAGE_END' first."
                    )
                }
                activeThinkingStepMessage = true
            }
            
            is ThinkingTextMessageContentEvent -> {
                if (!activeThinkingStepMessage) {
                    throw AGUIError(
                        "Cannot send 'THINKING_TEXT_MESSAGE_CONTENT' event: No active thinking text message found. Start a thinking text message with 'THINKING_TEXT_MESSAGE_START' first."
                    )
                }
            }
            
            is ThinkingTextMessageEndEvent -> {
                if (!activeThinkingStepMessage) {
                    throw AGUIError(
                        "Cannot send 'THINKING_TEXT_MESSAGE_END' event: No active thinking text message found. A 'THINKING_TEXT_MESSAGE_START' event must be sent first."
                    )
                }
                activeThinkingStepMessage = false
            }
            
            else -> {
                // Other events are allowed
            }
        }
        
        emit(event)
    }
}