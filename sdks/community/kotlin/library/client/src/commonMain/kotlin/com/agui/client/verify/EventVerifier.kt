@file:Suppress("DEPRECATION")

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
    // State tracking - using Maps to support concurrent messages/tool calls like TypeScript SDK
    val activeMessages = mutableMapOf<String, Boolean>()
    val messageRoles = mutableMapOf<String, Role>()
    val activeToolCalls = mutableMapOf<String, Boolean>()
    val activeReasoningSpans = mutableSetOf<String>()
    val activeReasoningMessages = mutableSetOf<String>()
    var runFinished = false
    var runError = false
    var firstEventReceived = false
    val activeSteps = mutableMapOf<Pair<String?, String>, Boolean>()
    val messageOwners = mutableMapOf<String, String?>()
    val toolOwners = mutableMapOf<String, String?>()
    val reasoningOwners = mutableMapOf<String, String?>()
    val spanOwners = mutableMapOf<String, String?>()
    val pendingTools = mutableSetOf<String>()
    val subagents = mutableMapOf<String, SubagentStartedEvent>()
    val closedSubagents = mutableSetOf<String>()
    val attributedOwners = mutableSetOf<String>()

    fun checkOwner(owners: Map<String, String?>, id: String, owner: String?) {
        if (owner != null && id in owners && owners[id] != owner) {
            throw AGUIError("Entity '$id' attribution disagrees with its opener")
        }
    }
    fun closeSubagent(id: String, failed: Boolean) {
        if (id !in subagents || id in closedSubagents) throw AGUIError("Subagent '$id' is not active")
        if (!failed && (activeMessages.keys.any { messageOwners[it] == id } ||
            activeToolCalls.keys.any { toolOwners[it] == id } ||
            activeReasoningMessages.any { reasoningOwners[it] == id } ||
            activeReasoningSpans.any { spanOwners[it] == id } ||
            activeSteps.keys.any { it.first == id } ||
            subagents.values.any { it.parentSubagentRunId == id && it.subagentRunId !in closedSubagents })) {
            throw AGUIError("Subagent '$id' has active entities")
        }
        if (failed) {
            activeMessages.keys.removeAll { messageOwners[it] == id }
            activeToolCalls.keys.removeAll { toolOwners[it] == id }
            activeReasoningMessages.removeAll { reasoningOwners[it] == id }
            activeReasoningSpans.removeAll { spanOwners[it] == id }
            activeSteps.keys.removeAll { it.first == id }
        }
        closedSubagents.add(id)
    }
    var activeThinkingStep = false
    var activeThinkingStepMessage = false
    var runStarted = false
    var currentThreadId: String? = null
    var currentRunId: String? = null
    
    return transform { event ->
        val eventType = event.eventType
        
        if (debug) {
            logger.d { "[VERIFY]: $event" }
        }
        
        // Check if run has errored
        if (runError && eventType != EventType.RUN_STARTED) {
            throw AGUIError(
                "Cannot send event type '$eventType': The run has already errored with 'RUN_ERROR'. No further events can be sent."
            )
        }
        
        // Check if run has already finished (but allow RUN_STARTED for new run)
        if (runFinished && eventType != EventType.RUN_ERROR && eventType != EventType.RUN_STARTED) {
            throw AGUIError(
                "Cannot send event type '$eventType': The run has already finished with 'RUN_FINISHED'. Start a new run with 'RUN_STARTED'."
            )
        }

        // First event validation and RUN_STARTED handling (matching TypeScript SDK)
        if (!firstEventReceived) {
            firstEventReceived = true
            if (eventType != EventType.RUN_STARTED && eventType != EventType.RUN_ERROR) {
                throw AGUIError("First event must be 'RUN_STARTED'")
            }
        } else if (eventType == EventType.RUN_STARTED) {
            // Allow RUN_STARTED after RUN_FINISHED (new run), but not during an active run
            if (runStarted && !runFinished && !runError) {
                throw AGUIError(
                    "Cannot send 'RUN_STARTED' while a run is still active. The previous run must be finished with 'RUN_FINISHED' before starting a new run."
                )
            }
            // Reset state for new run
            if (runFinished || runError) {
                messageOwners.clear()
                toolOwners.clear()
                reasoningOwners.clear()
                spanOwners.clear()
                pendingTools.clear()
                subagents.clear()
                closedSubagents.clear()
                attributedOwners.clear()
                activeMessages.clear()
                activeToolCalls.clear()
                activeReasoningSpans.clear()
                activeReasoningMessages.clear()
                messageRoles.clear()
                activeSteps.clear()
                activeThinkingStep = false
                activeThinkingStepMessage = false
                runFinished = false
                runError = false
            }
            runStarted = true
        }
        
        when (event) {
            is TextMessageContentEvent -> checkOwner(messageOwners, event.messageId, event.subagentRunId)
            is TextMessageEndEvent -> checkOwner(messageOwners, event.messageId, event.subagentRunId)
            is ToolCallArgsEvent -> checkOwner(toolOwners, event.toolCallId, event.subagentRunId)
            is ToolCallEndEvent -> checkOwner(toolOwners, event.toolCallId, event.subagentRunId)
            is ToolCallResultEvent -> checkOwner(toolOwners, event.toolCallId, event.subagentRunId)
            is ReasoningMessageContentEvent -> checkOwner(reasoningOwners, event.messageId, event.subagentRunId)
            is ReasoningMessageEndEvent -> checkOwner(reasoningOwners, event.messageId, event.subagentRunId)
            is ReasoningEndEvent -> checkOwner(spanOwners, event.messageId, event.subagentRunId)
            else -> Unit
        }
        // Event-specific validation (matching TypeScript SDK - supports concurrent messages/tool calls)
        when (event) {
            is TextMessageStartEvent -> {
                val messageId = event.messageId
                if (activeMessages.containsKey(messageId)) {
                    throw AGUIError(
                        "Cannot send 'TEXT_MESSAGE_START' event: A text message with ID '$messageId' is already in progress. Complete it with 'TEXT_MESSAGE_END' first."
                    )
                }
                val priorRole = messageRoles[messageId]
                if (priorRole != null && priorRole != event.role) {
                    throw AGUIError("Cannot reopen text message '$messageId' with a different role")
                }
                checkOwner(messageOwners, messageId, event.subagentRunId)
                if (messageId !in messageOwners) messageOwners[messageId] = event.subagentRunId
                messageRoles[messageId] = event.role
                activeMessages[messageId] = true
            }

            is TextMessageContentEvent -> {
                val messageId = event.messageId
                if (!activeMessages.containsKey(messageId)) {
                    throw AGUIError(
                        "Cannot send 'TEXT_MESSAGE_CONTENT' event: No active text message found with ID '$messageId'. Start a text message with 'TEXT_MESSAGE_START' first."
                    )
                }
            }

            is TextMessageEndEvent -> {
                val messageId = event.messageId
                if (!activeMessages.containsKey(messageId)) {
                    throw AGUIError(
                        "Cannot send 'TEXT_MESSAGE_END' event: No active text message found with ID '$messageId'. A 'TEXT_MESSAGE_START' event must be sent first."
                    )
                }
                activeMessages.remove(messageId)
            }

            is ToolCallStartEvent -> {
                val toolCallId = event.toolCallId
                if (activeToolCalls.containsKey(toolCallId)) {
                    throw AGUIError(
                        "Cannot send 'TOOL_CALL_START' event: A tool call with ID '$toolCallId' is already in progress. Complete it with 'TOOL_CALL_END' first."
                    )
                }
                val parent = event.parentMessageId
                if (parent != null && parent in messageOwners && event.subagentRunId != null && messageOwners[parent] != event.subagentRunId) {
                    throw AGUIError("Tool call owner must agree with its parent message")
                }
                checkOwner(toolOwners, toolCallId, event.subagentRunId)
                val owner = event.subagentRunId ?: if (parent in messageOwners) messageOwners[parent] else toolOwners[toolCallId]
                if (toolCallId in toolOwners && toolOwners[toolCallId] != owner) {
                    throw AGUIError("Reopened tool call disagrees with its parent message owner")
                }
                toolOwners[toolCallId] = owner
                pendingTools.add(toolCallId)
                activeToolCalls[toolCallId] = true
            }

            is ToolCallArgsEvent -> {
                val toolCallId = event.toolCallId
                if (!activeToolCalls.containsKey(toolCallId)) {
                    throw AGUIError(
                        "Cannot send 'TOOL_CALL_ARGS' event: No active tool call found with ID '$toolCallId'. Start a tool call with 'TOOL_CALL_START' first."
                    )
                }
            }

            is ToolCallEndEvent -> {
                val toolCallId = event.toolCallId
                if (!activeToolCalls.containsKey(toolCallId)) {
                    throw AGUIError(
                        "Cannot send 'TOOL_CALL_END' event: No active tool call found with ID '$toolCallId'. A 'TOOL_CALL_START' event must be sent first."
                    )
                }
                activeToolCalls.remove(toolCallId)
            }
            
            is StepStartedEvent -> {
                val stepName = event.subagentRunId to event.stepName
                if (activeSteps.containsKey(stepName)) {
                    throw AGUIError("Step \"${event.stepName}\" is already active for 'STEP_STARTED'")
                }
                activeSteps[stepName] = true
            }
            
            is StepFinishedEvent -> {
                val stepName = event.subagentRunId to event.stepName
                if (!activeSteps.containsKey(stepName)) {
                    throw AGUIError(
                        "Cannot send 'STEP_FINISHED' for step \"${event.stepName}\" that was not started"
                    )
                }
                activeSteps.remove(stepName)
            }
            
            is ToolCallResultEvent -> pendingTools.remove(event.toolCallId)

            is SubagentStartedEvent -> {
                val id = event.subagentRunId
                if (id in attributedOwners) throw AGUIError("Subagent must be announced before its attributed events")
                if (id in subagents) throw AGUIError("Subagent '$id' was already announced")
                if (event.parentSubagentRunId == id) throw AGUIError("A subagent cannot parent itself")
                event.parentSubagentRunId?.let {
                    if (it !in subagents || it in closedSubagents) throw AGUIError("Parent subagent '$it' is closed")
                }
                event.parentMessageId?.let { parent ->
                    if (parent in messageOwners && messageOwners[parent] != event.parentSubagentRunId) {
                        throw AGUIError("Subagent parent message owner disagrees")
                    }
                }
                event.parentToolCallId?.let { parent ->
                    if (parent in toolOwners && toolOwners[parent] != event.parentSubagentRunId) {
                        throw AGUIError("Subagent parent tool owner disagrees")
                    }
                }
                subagents[id] = event
            }
            is SubagentFinishedEvent -> closeSubagent(event.subagentRunId, failed = false)
            is SubagentErrorEvent -> closeSubagent(event.subagentRunId, failed = true)

            is RunFinishedEvent -> {
                if (subagents.keys.any { it !in closedSubagents }) throw AGUIError("Run has active subagents")
                (event.outcome as? RunFinishedSuccessOutcome)?.pendingToolCallIds?.let { ids ->
                    if (ids.size != ids.toSet().size || ids.any { it !in pendingTools }) {
                        throw AGUIError("Pending tool declaration must name unique unanswered calls")
                    }
                }
                if (event.threadId != currentThreadId || event.runId != currentRunId) {
                    throw AGUIError("RUN_FINISHED identifiers must match RUN_STARTED")
                }
                // Check that all steps are finished before run ends
                if (activeSteps.isNotEmpty()) {
                    val unfinishedSteps = activeSteps.keys.joinToString(", ") { (owner, name) ->
                        if (owner == null) name else "$name (owner=$owner)"
                    }
                    throw AGUIError(
                        "Cannot send 'RUN_FINISHED' while steps are still active: $unfinishedSteps"
                    )
                }
                // Check that all messages are finished before run ends
                if (activeMessages.isNotEmpty()) {
                    val unfinishedMessages = activeMessages.keys.joinToString(", ")
                    throw AGUIError(
                        "Cannot send 'RUN_FINISHED' while text messages are still active: $unfinishedMessages"
                    )
                }
                // Check that all tool calls are finished before run ends
                if (activeToolCalls.isNotEmpty()) {
                    val unfinishedToolCalls = activeToolCalls.keys.joinToString(", ")
                    throw AGUIError(
                        "Cannot send 'RUN_FINISHED' while tool calls are still active: $unfinishedToolCalls"
                    )
                }
                if (activeReasoningSpans.isNotEmpty() || activeReasoningMessages.isNotEmpty()) {
                    throw AGUIError("Cannot send RUN_FINISHED while reasoning is still active")
                }
                val interruptIds = (event.outcome as? RunFinishedInterruptOutcome)
                    ?.interrupts?.map { it.id }.orEmpty()
                if (interruptIds.size != interruptIds.toSet().size) {
                    throw AGUIError("Interrupt identifiers must be unique")
                }
                runFinished = true
            }
            
            is RunStartedEvent -> {
                runStarted = true
                currentThreadId = event.threadId
                currentRunId = event.runId
            }

            is RunErrorEvent -> {
                runError = true
            }

            is ReasoningStartEvent -> {
                checkOwner(spanOwners, event.messageId, event.subagentRunId)
                if (event.messageId !in spanOwners) spanOwners[event.messageId] = event.subagentRunId
                if (!activeReasoningSpans.add(event.messageId)) {
                    throw AGUIError("Reasoning span '${event.messageId}' is already active")
                }
            }

            is ReasoningEndEvent -> {
                if (!activeReasoningSpans.remove(event.messageId)) {
                    throw AGUIError("Reasoning span '${event.messageId}' was not started")
                }
            }

            is ReasoningMessageStartEvent -> {
                checkOwner(reasoningOwners, event.messageId, event.subagentRunId)
                if (event.messageId !in reasoningOwners) reasoningOwners[event.messageId] = event.subagentRunId
                if (!activeReasoningMessages.add(event.messageId)) {
                    throw AGUIError("Reasoning message '${event.messageId}' is already active")
                }
            }

            is ReasoningMessageContentEvent -> {
                if (event.messageId !in activeReasoningMessages) {
                    throw AGUIError("Reasoning message '${event.messageId}' was not started")
                }
            }

            is ReasoningMessageEndEvent -> {
                if (!activeReasoningMessages.remove(event.messageId)) {
                    throw AGUIError("Reasoning message '${event.messageId}' was not started")
                }
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
        
        if (event !is SubagentStartedEvent && event !is SubagentFinishedEvent && event !is SubagentErrorEvent) {
            event.subagentRunId?.let { attributedOwners.add(it) }
        }
        emit(event)
    }.onCompletion { cause ->
        if (cause == null && !runFinished && !runError) {
            throw AGUIError("Event stream ended before RUN_FINISHED or RUN_ERROR")
        }
    }
}
