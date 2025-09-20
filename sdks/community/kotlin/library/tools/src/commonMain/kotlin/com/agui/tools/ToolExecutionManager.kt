package com.agui.tools

import com.agui.core.types.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.datetime.Clock
import co.touchlab.kermit.Logger

private val logger = Logger.withTag("ToolExecutionManager")

/**
 * Manages the complete lifecycle of tool execution.
 * 
 * This class handles:
 * - Automatic tool call detection from event streams
 * - Tool execution coordination with the registry
 * - Response generation and sending back to agents
 * - Error handling and recovery
 * - Concurrent tool execution management
 */
class ToolExecutionManager(
    private val toolRegistry: ToolRegistry,
    private val responseHandler: ToolResponseHandler
) {
    
    private val activeExecutions = mutableMapOf<String, Job>()
    private val _executionEvents = MutableSharedFlow<ToolExecutionEvent>()
    
    /**
     * Flow of tool execution events for monitoring and debugging.
     */
    val executionEvents: SharedFlow<ToolExecutionEvent> = _executionEvents.asSharedFlow()
    
    /**
     * Processes a stream of events and automatically handles tool calls.
     * 
     * @param events The event stream to process
     * @param threadId The thread ID for context
     * @param runId The run ID for context
     * @return The processed event stream with tool responses injected
     */
    fun processEventStream(
        events: Flow<BaseEvent>,
        threadId: String?,
        runId: String?
    ): Flow<BaseEvent> = flow {
        coroutineScope {
            val toolCallBuffer = mutableMapOf<String, ToolCallBuilder>()
            
            events.collect { event ->
                // Emit the original event
                emit(event)
                
                // Process tool-related events
                when (event) {
                    is ToolCallStartEvent -> {
                        logger.i { "Tool call started: ${event.toolCallName} (${event.toolCallId})" }
                        
                        val builder = ToolCallBuilder(
                            id = event.toolCallId,
                            name = event.toolCallName
                        )
                        toolCallBuffer[event.toolCallId] = builder
                        
                        _executionEvents.emit(ToolExecutionEvent.Started(event.toolCallId, event.toolCallName))
                    }
                    
                    is ToolCallArgsEvent -> {
                        toolCallBuffer[event.toolCallId]?.appendArguments(event.delta)
                    }
                    
                    is ToolCallEndEvent -> {
                        val builder = toolCallBuffer.remove(event.toolCallId)
                        if (builder != null) {
                            logger.i { "Tool call ended: ${builder.name} (${event.toolCallId})" }
                            
                            // Execute the tool call in this coroutine scope
                            // This ensures it's tied to the flow's lifecycle
                            val job = launch {
                                executeToolCall(builder.build(), threadId, runId)
                            }
                            activeExecutions[event.toolCallId] = job
                        }
                    }
                    
                    is RunFinishedEvent, is RunErrorEvent -> {
                        // Wait for all active tool executions to complete
                        activeExecutions.values.forEach { it.join() }
                        activeExecutions.clear()
                    }
                    
                    else -> {
                        // Ignore other events (run lifecycle, messages, steps, state, etc.)
                    }
                }
            }
        }
    }
    
    /**
     * Executes a single tool call.
     */
    private suspend fun executeToolCall(
        toolCall: ToolCall,
        threadId: String?,
        runId: String?
    ) {
        val toolCallId = toolCall.id
        val toolName = toolCall.function.name
        
        try {
            logger.i { "Executing tool: $toolName (ID: $toolCallId)" }
            
            _executionEvents.emit(ToolExecutionEvent.Executing(toolCallId, toolName))
            
            // Create execution context
            val context = ToolExecutionContext(
                toolCall = toolCall,
                threadId = threadId,
                runId = runId,
                metadata = mapOf(
                    "startTime" to kotlinx.datetime.Clock.System.now().toEpochMilliseconds()
                )
            )
            
            // Execute the tool
            val result = toolRegistry.executeTool(context)
            
            logger.i { 
                "Tool execution ${if (result.success) "succeeded" else "failed"}: $toolName (ID: $toolCallId)" 
            }
            
            // Create tool message response
            val toolMessage = ToolMessage(
                id = generateMessageId(),
                content = formatToolResponse(result, toolName),
                toolCallId = toolCallId
            )
            
            // Send response back to agent
            responseHandler.sendToolResponse(toolMessage, threadId, runId)
            
            _executionEvents.emit(
                if (result.success) {
                    ToolExecutionEvent.Succeeded(toolCallId, toolName, result)
                } else {
                    ToolExecutionEvent.Failed(toolCallId, toolName, result.message ?: "Unknown error")
                }
            )
            
        } catch (e: ToolNotFoundException) {
            logger.w { "Tool not found: $toolName (ID: $toolCallId)" }
            
            val errorMessage = ToolMessage(
                id = generateMessageId(),
                content = "Error: Tool '$toolName' is not available",
                toolCallId = toolCallId
            )
            
            responseHandler.sendToolResponse(errorMessage, threadId, runId)
            _executionEvents.emit(ToolExecutionEvent.Failed(toolCallId, toolName, "Tool not found"))
            
        } catch (e: Exception) {
            logger.e(e) { "Tool execution failed: $toolName (ID: $toolCallId)" }
            
            val errorMessage = ToolMessage(
                id = generateMessageId(),
                content = "Error: Tool execution failed - ${e.message}",
                toolCallId = toolCallId
            )
            
            responseHandler.sendToolResponse(errorMessage, threadId, runId)
            _executionEvents.emit(ToolExecutionEvent.Failed(toolCallId, toolName, e.message ?: "Unknown error"))
            
        } finally {
            activeExecutions.remove(toolCallId)
        }
    }
    
    /**
     * Formats a tool execution result into a response message.
     */
    private fun formatToolResponse(result: ToolExecutionResult, toolName: String): String {
        return if (result.success) {
            // Format successful response
            buildString {
                append("Tool '$toolName' executed successfully")
                if (result.message != null) {
                    append(": ${result.message}")
                }
                if (result.result != null) {
                    append("\nResult: ${result.result}")
                }
            }
        } else {
            // Format error response
            buildString {
                append("Tool '$toolName' execution failed")
                if (result.message != null) {
                    append(": ${result.message}")
                }
                if (result.result != null) {
                    append("\nDetails: ${result.result}")
                }
            }
        }
    }
    
    /**
     * Cancels all active tool executions.
     */
    fun cancelAllExecutions() {
        logger.i { "Cancelling ${activeExecutions.size} active tool executions" }
        activeExecutions.values.forEach { it.cancel() }
        activeExecutions.clear()
    }
    
    /**
     * Gets the number of currently active tool executions.
     */
    fun getActiveExecutionCount(): Int = activeExecutions.size
    
    /**
     * Checks if a specific tool call is still executing.
     */
    fun isExecuting(toolCallId: String): Boolean = activeExecutions.containsKey(toolCallId)
    
    private fun generateMessageId(): String = "msg_${Clock.System.now().toEpochMilliseconds()}"
}

/**
 * Interface for sending tool responses back to agents.
 */
interface ToolResponseHandler {
    /**
     * Sends a tool response message back to the agent.
     * 
     * @param toolMessage The tool response message
     * @param threadId The thread ID
     * @param runId The run ID
     */
    suspend fun sendToolResponse(toolMessage: ToolMessage, threadId: String?, runId: String?)
}

/**
 * Events emitted during tool execution lifecycle.
 */
sealed class ToolExecutionEvent {
    abstract val toolCallId: String
    abstract val toolName: String
    
    data class Started(
        override val toolCallId: String,
        override val toolName: String
    ) : ToolExecutionEvent()
    
    data class Executing(
        override val toolCallId: String,
        override val toolName: String
    ) : ToolExecutionEvent()
    
    data class Succeeded(
        override val toolCallId: String,
        override val toolName: String,
        val result: ToolExecutionResult
    ) : ToolExecutionEvent()
    
    data class Failed(
        override val toolCallId: String,
        override val toolName: String,
        val error: String
    ) : ToolExecutionEvent()
}

/**
 * Helper class for building tool calls from streaming events.
 */
private class ToolCallBuilder(
    val id: String,
    val name: String
) {
    private val argumentsBuilder = StringBuilder()
    
    fun appendArguments(args: String) {
        argumentsBuilder.append(args)
    }
    
    fun build(): ToolCall {
        return ToolCall(
            id = id,
            function = FunctionCall(
                name = name,
                arguments = argumentsBuilder.toString()
            )
        )
    }
}

/**
 * Default tool response handler that logs responses.
 * Applications should provide their own implementation to send responses back to agents.
 */
class LoggingToolResponseHandler : ToolResponseHandler {
    override suspend fun sendToolResponse(toolMessage: ToolMessage, threadId: String?, runId: String?) {
        logger.i { 
            "Tool response (thread: $threadId, run: $runId): ${toolMessage.content}" 
        }
    }
}