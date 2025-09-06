package com.agui.tools

import com.agui.core.types.Tool
import com.agui.core.types.ToolCall
import kotlinx.serialization.json.JsonElement

/**
 * Result of a tool execution.
 * 
 * @param success Whether the tool execution was successful
 * @param result The result data (if successful) or error information (if failed)
 * @param message Optional human-readable message about the result
 */
data class ToolExecutionResult(
    val success: Boolean,
    val result: JsonElement? = null,
    val message: String? = null
) {
    companion object {
        fun success(result: JsonElement? = null, message: String? = null): ToolExecutionResult {
            return ToolExecutionResult(success = true, result = result, message = message)
        }
        
        fun failure(message: String, result: JsonElement? = null): ToolExecutionResult {
            return ToolExecutionResult(success = false, result = result, message = message)
        }
    }
}

/**
 * Context provided to tool executors during execution.
 * 
 * @param toolCall The tool call being executed
 * @param threadId The thread ID (if available)
 * @param runId The run ID (if available)
 * @param metadata Additional execution metadata
 */
data class ToolExecutionContext(
    val toolCall: ToolCall,
    val threadId: String? = null,
    val runId: String? = null,
    val metadata: Map<String, Any> = emptyMap()
)

/**
 * Interface for executing tools.
 * 
 * Tool executors are responsible for:
 * - Validating tool call arguments
 * - Performing the actual tool execution
 * - Handling errors and timeouts
 * - Returning structured results
 * 
 * Implementations should be:
 * - Thread-safe (multiple concurrent executions)
 * - Idempotent where possible
 * - Defensive (validate all inputs)
 * - Fast (avoid blocking operations when possible)
 */
interface ToolExecutor {
    
    /**
     * The tool definition this executor handles.
     * This defines the tool's name, description, and parameter schema.
     */
    val tool: Tool
    
    /**
     * Executes a tool call.
     * 
     * @param context The execution context including the tool call and metadata
     * @return The execution result
     * @throws ToolExecutionException if execution fails in an unrecoverable way
     */
    suspend fun execute(context: ToolExecutionContext): ToolExecutionResult
    
    /**
     * Validates a tool call before execution.
     * 
     * @param toolCall The tool call to validate
     * @return Validation result with success/failure and error messages
     */
    fun validate(toolCall: ToolCall): ToolValidationResult {
        return ToolValidationResult.success()
    }
    
    /**
     * Checks if this executor can handle the given tool call.
     * Default implementation matches by tool name.
     * 
     * @param toolCall The tool call to check
     * @return True if this executor can handle the tool call
     */
    fun canExecute(toolCall: ToolCall): Boolean {
        return toolCall.function.name == tool.name
    }
    
    /**
     * Gets the maximum execution time for this tool in milliseconds.
     * Used by tool registries to implement timeouts.
     * 
     * @return Maximum execution time in milliseconds, or null for no timeout
     */
    fun getMaxExecutionTimeMs(): Long? = null
}

/**
 * Result of tool call validation.
 */
data class ToolValidationResult(
    val isValid: Boolean,
    val errors: List<String> = emptyList()
) {
    companion object {
        fun success(): ToolValidationResult = ToolValidationResult(isValid = true)
        
        fun failure(vararg errors: String): ToolValidationResult {
            return ToolValidationResult(isValid = false, errors = errors.toList())
        }
        
        fun failure(errors: List<String>): ToolValidationResult {
            return ToolValidationResult(isValid = false, errors = errors)
        }
    }
}

/**
 * Exception thrown when tool execution fails in an unrecoverable way.
 * 
 * For recoverable errors (validation failures, expected errors), use
 * ToolExecutionResult.failure() instead.
 */
class ToolExecutionException(
    message: String,
    cause: Throwable? = null,
    val toolName: String? = null,
    val toolCallId: String? = null
) : Exception(message, cause)

/**
 * Abstract base class for tool executors.
 * Provides common validation and error handling patterns.
 */
abstract class AbstractToolExecutor(
    override val tool: Tool
) : ToolExecutor {
    
    /**
     * Template method for tool execution with common error handling.
     */
    override suspend fun execute(context: ToolExecutionContext): ToolExecutionResult {
        return try {
            // Validate the tool call
            val validation = validate(context.toolCall)
            if (!validation.isValid) {
                return ToolExecutionResult.failure(
                    message = "Validation failed: ${validation.errors.joinToString(", ")}"
                )
            }
            
            // Execute the tool
            executeInternal(context)
        } catch (e: ToolExecutionException) {
            // Re-throw tool execution exceptions
            throw e
        } catch (e: Exception) {
            // Wrap other exceptions
            ToolExecutionResult.failure(
                message = "Tool execution failed: ${e.message ?: e::class.simpleName}"
            )
        }
    }
    
    /**
     * Internal execution method to be implemented by subclasses.
     * Validation has already been performed at this point.
     */
    protected abstract suspend fun executeInternal(context: ToolExecutionContext): ToolExecutionResult
}