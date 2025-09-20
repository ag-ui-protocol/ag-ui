package com.agui.tools

import com.agui.core.types.FunctionCall
import com.agui.core.types.Tool
import com.agui.core.types.ToolCall
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

/**
 * Tests for the Tools Module.
 */
class ToolsModuleTest {
    
    @Test
    fun testToolRegistry() = runTest {
        val registry = DefaultToolRegistry()
        
        // Test registration
        val echoTool = EchoToolExecutor()
        registry.registerTool(echoTool)
        
        assertTrue(registry.isToolRegistered("echo"))
        assertNotNull(registry.getToolExecutor("echo"))
        
        // Test tool execution
        val toolCall = ToolCall(
            id = "test-1",
            function = FunctionCall(
                name = "echo",
                arguments = """{"message": "Hello, World!"}"""
            )
        )
        
        val context = ToolExecutionContext(toolCall)
        val result = registry.executeTool(context)
        
        assertTrue(result.success)
        assertNotNull(result.result)
    }
    
    @Test
    fun testEchoTool() = runTest {
        val executor = EchoToolExecutor()
        
        // Test valid execution
        val toolCall = ToolCall(
            id = "test-1",
            function = FunctionCall(
                name = "echo",
                arguments = """{"message": "test message"}"""
            )
        )
        
        val context = ToolExecutionContext(toolCall)
        val result = executor.execute(context)
        
        assertTrue(result.success)
        assertEquals("Message echoed successfully", result.message)
    }
    
    @Test
    fun testCalculatorTool() = runTest {
        val executor = CalculatorToolExecutor()
        
        // Test addition
        val addCall = ToolCall(
            id = "test-1",
            function = FunctionCall(
                name = "calculator",
                arguments = """{"operation": "add", "a": 5, "b": 3}"""
            )
        )
        
        val context = ToolExecutionContext(addCall)
        val result = executor.execute(context)
        
        assertTrue(result.success)
        assertNotNull(result.result)
        
        // Test division by zero
        val divideByZeroCall = ToolCall(
            id = "test-2",
            function = FunctionCall(
                name = "calculator",
                arguments = """{"operation": "divide", "a": 5, "b": 0}"""
            )
        )
        
        val divideContext = ToolExecutionContext(divideByZeroCall)
        val divideResult = executor.execute(divideContext)
        
        assertFalse(divideResult.success)
        assertTrue(divideResult.message?.contains("Cannot divide by zero") == true)
    }
}

/**
 * Simple echo tool for testing.
 */
class EchoToolExecutor : AbstractToolExecutor(
    tool = Tool(
        name = "echo",
        description = "Echoes back the provided message",
        parameters = buildJsonObject {
            put("type", "object")
            putJsonObject("properties") {
                putJsonObject("message") {
                    put("type", "string")
                    put("description", "The message to echo")
                }
            }
            putJsonArray("required") {
                add("message")
            }
        }
    )
) {
    override suspend fun executeInternal(context: ToolExecutionContext): ToolExecutionResult {
        val args = Json.parseToJsonElement(context.toolCall.function.arguments).jsonObject
        val message = args["message"]?.jsonPrimitive?.content
            ?: return ToolExecutionResult.failure("Missing message parameter")
        
        val result = buildJsonObject {
            put("echo", message)
            put("timestamp", kotlinx.datetime.Clock.System.now().toString())
        }
        
        return ToolExecutionResult.success(result, "Message echoed successfully")
    }
    
    override fun validate(toolCall: ToolCall): ToolValidationResult {
        val args = try {
            Json.parseToJsonElement(toolCall.function.arguments).jsonObject
        } catch (e: Exception) {
            return ToolValidationResult.failure("Invalid JSON arguments")
        }
        
        val message = args["message"]?.jsonPrimitive?.content
        if (message.isNullOrBlank()) {
            return ToolValidationResult.failure("Message parameter is required and cannot be empty")
        }
        
        return ToolValidationResult.success()
    }
}

/**
 * Simple calculator tool for testing.
 */
class CalculatorToolExecutor : AbstractToolExecutor(
    tool = Tool(
        name = "calculator",
        description = "Performs basic arithmetic operations",
        parameters = buildJsonObject {
            put("type", "object")
            putJsonObject("properties") {
                putJsonObject("operation") {
                    put("type", "string")
                    put("enum", buildJsonArray {
                        add("add")
                        add("subtract")
                        add("multiply")
                        add("divide")
                    })
                }
                putJsonObject("a") {
                    put("type", "number")
                    put("description", "First number")
                }
                putJsonObject("b") {
                    put("type", "number")
                    put("description", "Second number")
                }
            }
            putJsonArray("required") {
                add("operation")
                add("a")
                add("b")
            }
        }
    )
) {
    override suspend fun executeInternal(context: ToolExecutionContext): ToolExecutionResult {
        val args = Json.parseToJsonElement(context.toolCall.function.arguments).jsonObject
        
        val operation = args["operation"]?.jsonPrimitive?.content
            ?: return ToolExecutionResult.failure("Missing operation parameter")
        
        val a = args["a"]?.jsonPrimitive?.doubleOrNull
            ?: return ToolExecutionResult.failure("Missing or invalid parameter 'a'")
        
        val b = args["b"]?.jsonPrimitive?.doubleOrNull
            ?: return ToolExecutionResult.failure("Missing or invalid parameter 'b'")
        
        val result = when (operation) {
            "add" -> a + b
            "subtract" -> a - b
            "multiply" -> a * b
            "divide" -> {
                if (b == 0.0) {
                    return ToolExecutionResult.failure("Cannot divide by zero")
                }
                a / b
            }
            else -> return ToolExecutionResult.failure("Invalid operation: $operation")
        }
        
        val resultJson = buildJsonObject {
            put("operation", operation)
            put("a", a)
            put("b", b)
            put("result", result)
        }
        
        return ToolExecutionResult.success(resultJson, "Calculation completed successfully")
    }
}