package com.agui.example.tools

import com.agui.core.types.Tool
import com.agui.core.types.ToolCall
import com.agui.tools.AbstractToolExecutor
import com.agui.tools.ToolExecutionContext
import com.agui.tools.ToolExecutionResult
import com.agui.tools.ToolValidationResult
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject

/**
 * Built-in tool executor for user confirmation.
 * 
 * This tool allows agents to request user confirmation for actions with different
 * importance levels. The actual confirmation UI is provided by the client application.
 */
class ConfirmationToolExecutor(
    private val confirmationHandler: ConfirmationHandler
) : AbstractToolExecutor(
    tool = Tool(
        name = "user_confirmation",
        description = "Request user confirmation for an action with specified importance level",
        parameters = buildJsonObject {
            put("type", "object")
            putJsonObject("properties") {
                putJsonObject("message") {
                    put("type", "string")
                    put("description", "The confirmation message to display to the user")
                }
                putJsonObject("importance") {
                    put("type", "string")
                    put("enum", buildJsonArray {
                        add("critical")
                        add("high") 
                        add("medium")
                        add("low")
                    })
                    put("description", "The importance level of the confirmation")
                    put("default", "medium")
                }
                putJsonObject("details") {
                    put("type", "string")
                    put("description", "Optional additional details about the action requiring confirmation")
                }
            }
            putJsonArray("required") {
                add("message")
            }
        }
    )
) {
    
    override suspend fun executeInternal(context: ToolExecutionContext): ToolExecutionResult {
        // Parse the tool call arguments
        val args = try {
            Json.parseToJsonElement(context.toolCall.function.arguments).jsonObject
        } catch (e: Exception) {
            return ToolExecutionResult.failure("Invalid JSON arguments: ${e.message}")
        }
        
        // Extract parameters
        val message = args["message"]?.jsonPrimitive?.content
            ?: return ToolExecutionResult.failure("Missing required parameter: message")
        
        val importance = args["importance"]?.jsonPrimitive?.content ?: "medium"
        val details = args["details"]?.jsonPrimitive?.content
        
        // Validate importance level
        val validImportance = when (importance) {
            "critical", "high", "medium", "low" -> importance
            else -> return ToolExecutionResult.failure("Invalid importance level: $importance. Must be critical, high, medium, or low")
        }
        
        // Create confirmation request
        val request = ConfirmationRequest(
            message = message,
            importance = validImportance,
            details = details,
            toolCallId = context.toolCall.id,
            threadId = context.threadId,
            runId = context.runId
        )
        
        // Execute confirmation through handler
        return try {
            val confirmed = confirmationHandler.requestConfirmation(request)
            
            val resultJson = buildJsonObject {
                put("confirmed", confirmed)
                put("message", message)
                put("importance", validImportance)
                if (details != null) {
                    put("details", details)
                }
            }
            
            ToolExecutionResult.success(
                result = resultJson,
                message = if (confirmed) "User confirmed the action" else "User rejected the action"
            )
        } catch (e: Exception) {
            ToolExecutionResult.failure("Confirmation failed: ${e.message}")
        }
    }
    
    override fun validate(toolCall: ToolCall): ToolValidationResult {
        val args = try {
            Json.parseToJsonElement(toolCall.function.arguments).jsonObject
        } catch (e: Exception) {
            return ToolValidationResult.failure("Invalid JSON arguments: ${e.message}")
        }
        
        val errors = mutableListOf<String>()
        
        // Check required fields
        if (!args.containsKey("message") || args["message"]?.jsonPrimitive?.content.isNullOrBlank()) {
            errors.add("Missing or empty required parameter: message")
        }
        
        // Validate importance if provided
        args["importance"]?.jsonPrimitive?.content?.let { importance ->
            if (importance !in listOf("critical", "high", "medium", "low")) {
                errors.add("Invalid importance level: $importance. Must be critical, high, medium, or low")
            }
        }
        
        return if (errors.isEmpty()) {
            ToolValidationResult.success()
        } else {
            ToolValidationResult.failure(errors)
        }
    }
    
    override fun getMaxExecutionTimeMs(): Long? {
        // User confirmations can take a while, so allow up to 5 minutes
        return 300_000L
    }
}

/**
 * Request for user confirmation.
 */
data class ConfirmationRequest(
    val message: String,
    val importance: String,
    val details: String? = null,
    val toolCallId: String,
    val threadId: String? = null,
    val runId: String? = null
)

/**
 * Interface for handling user confirmation requests.
 * 
 * Implementations should provide the actual UI/UX for getting user confirmation.
 * This might be a dialog, console prompt, web form, etc.
 */
interface ConfirmationHandler {
    /**
     * Request confirmation from the user.
     * 
     * @param request The confirmation request details
     * @return True if the user confirmed, false if they rejected
     * @throws Exception if confirmation fails or times out
     */
    suspend fun requestConfirmation(request: ConfirmationRequest): Boolean
}

/**
 * Simple console-based confirmation handler for testing/debugging.
 */
class ConsoleConfirmationHandler : ConfirmationHandler {
    override suspend fun requestConfirmation(request: ConfirmationRequest): Boolean {
        println("\n=== USER CONFIRMATION REQUIRED ===")
        println("Importance: ${request.importance.uppercase()}")
        println("Message: ${request.message}")
        if (request.details != null) {
            println("Details: ${request.details}")
        }
        println("===================================")
        
        print("Confirm this action? (y/N): ")
        val input = readlnOrNull()?.trim()?.lowercase()
        return input in listOf("y", "yes", "true", "1")
    }
}

/**
 * No-op confirmation handler that always confirms.
 * Useful for testing or when confirmation is handled elsewhere.
 */
class AutoConfirmHandler(private val autoConfirm: Boolean = true) : ConfirmationHandler {
    override suspend fun requestConfirmation(request: ConfirmationRequest): Boolean {
        return autoConfirm
    }
}