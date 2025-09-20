package com.agui.client.integration

import com.agui.core.types.*
import com.agui.client.AgUiAgent
import com.agui.client.StatefulAgUiAgent
import com.agui.tools.*
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import kotlin.test.*

class SimpleAgentToolIntegrationTest {

    // Simple calculator tool for testing
    class CalculatorTool : ToolExecutor {
        override val tool = Tool(
            name = "calculator",
            description = "Performs basic mathematical calculations",
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
                    }
                    putJsonObject("b") {
                        put("type", "number")
                    }
                }
                putJsonArray("required") {
                    add("operation")
                    add("a")
                    add("b")
                }
            }
        )

        override suspend fun execute(context: ToolExecutionContext): ToolExecutionResult {
            val args = try {
                Json.parseToJsonElement(context.toolCall.function.arguments).jsonObject
            } catch (e: Exception) {
                return ToolExecutionResult.failure("Invalid JSON arguments: ${e.message}")
            }
            
            val operation = args["operation"]?.jsonPrimitive?.content
            val a = args["a"]?.jsonPrimitive?.double
            val b = args["b"]?.jsonPrimitive?.double

            if (operation == null || a == null || b == null) {
                return ToolExecutionResult.failure("Missing required parameters")
            }

            val result = when (operation) {
                "add" -> a + b
                "subtract" -> a - b
                "multiply" -> a * b
                "divide" -> {
                    if (b == 0.0) {
                        return ToolExecutionResult.failure("Division by zero")
                    }
                    a / b
                }
                else -> return ToolExecutionResult.failure("Invalid operation: $operation")
            }

            return ToolExecutionResult.success(
                result = JsonPrimitive(result),
                message = "$a $operation $b = $result"
            )
        }

        override fun getMaxExecutionTimeMs(): Long = 5000L
    }

    // Simple mock tool that always succeeds
    class MockSuccessTool : ToolExecutor {
        override val tool = Tool(
            name = "mock_success",
            description = "A tool that always succeeds",
            parameters = buildJsonObject {
                put("type", "object")
                putJsonObject("properties") {
                    putJsonObject("message") {
                        put("type", "string")
                    }
                }
            }
        )

        override suspend fun execute(context: ToolExecutionContext): ToolExecutionResult {
            val args = Json.parseToJsonElement(context.toolCall.function.arguments).jsonObject
            val message = args["message"]?.jsonPrimitive?.content ?: "default message"
            
            return ToolExecutionResult.success(
                result = buildJsonObject {
                    put("received", message)
                    put("timestamp", kotlinx.datetime.Clock.System.now().toEpochMilliseconds())
                },
                message = "Successfully processed: $message"
            )
        }
    }

    @Test
    fun testToolRegistryWithMultipleTools() = runTest {
        val calculator = CalculatorTool()
        val mockTool = MockSuccessTool()

        val registry = toolRegistry {
            addTool(calculator)
            addTool(mockTool)
        }

        // Verify tools are registered
        assertEquals(2, registry.getAllTools().size)
        assertTrue(registry.isToolRegistered("calculator"))
        assertTrue(registry.isToolRegistered("mock_success"))

        val toolNames = registry.getAllTools().map { it.name }
        assertTrue(toolNames.contains("calculator"))
        assertTrue(toolNames.contains("mock_success"))
    }

    @Test
    fun testCalculatorToolExecution() = runTest {
        val calculator = CalculatorTool()
        val registry = DefaultToolRegistry()
        registry.registerTool(calculator)

        // Test addition
        val addCall = ToolCall(
            id = "add_test",
            function = FunctionCall(
                name = "calculator",
                arguments = """{"operation": "add", "a": 10.5, "b": 5.5}"""
            )
        )

        val context = ToolExecutionContext(addCall, "test_thread", "test_run")
        val result = registry.executeTool(context)

        assertTrue(result.success)
        assertEquals(16.0, result.result?.jsonPrimitive?.double)
        assertEquals("10.5 add 5.5 = 16.0", result.message)

        // Check statistics
        val stats = registry.getToolStats("calculator")
        assertNotNull(stats)
        assertEquals(1, stats.executionCount)
        assertEquals(1, stats.successCount)
        assertEquals(0, stats.failureCount)
        assertEquals(1.0, stats.successRate)
    }

    @Test
    fun testCalculatorDivisionByZero() = runTest {
        val calculator = CalculatorTool()
        val registry = DefaultToolRegistry()
        registry.registerTool(calculator)

        val divideByZeroCall = ToolCall(
            id = "div_zero",
            function = FunctionCall(
                name = "calculator",
                arguments = """{"operation": "divide", "a": 10, "b": 0}"""
            )
        )

        val result = registry.executeTool(ToolExecutionContext(divideByZeroCall))

        assertFalse(result.success)
        assertEquals("Division by zero", result.message)

        // Check failure statistics
        val stats = registry.getToolStats("calculator")
        assertNotNull(stats)
        assertEquals(1, stats.executionCount)
        assertEquals(0, stats.successCount)
        assertEquals(1, stats.failureCount)
        assertEquals(0.0, stats.successRate)
    }

    @Test
    fun testAgentWithToolRegistry() = runTest {
        val toolRegistry = toolRegistry {
            addTool(CalculatorTool())
            addTool(MockSuccessTool())
        }

        // Create agent with tools
        val agent = AgUiAgent("https://test-api.example.com") {
            this.toolRegistry = toolRegistry
            systemPrompt = "You are a helpful assistant with calculator and mock tools."
            bearerToken = "test-token"
            debug = true
        }

        // Verify tools are available in agent
        val tools = toolRegistry.getAllTools()
        assertEquals(2, tools.size)
        
        val toolNames = tools.map { it.name }.toSet()
        assertTrue(toolNames.contains("calculator"))
        assertTrue(toolNames.contains("mock_success"))
    }

    @Test
    fun testStatefulAgentWithTools() = runTest {
        val toolRegistry = toolRegistry {
            addTool(CalculatorTool())
            addTool(MockSuccessTool())
        }

        val statefulAgent = StatefulAgUiAgent("https://stateful-test.example.com") {
            this.toolRegistry = toolRegistry
            systemPrompt = "You are a stateful assistant."
            initialState = buildJsonObject {
                put("calculation_count", 0)
                put("last_operation", JsonNull)
            }
            maxHistoryLength = 100
        }

        // Verify configuration
        assertNotNull(statefulAgent)
        assertEquals(2, toolRegistry.getAllTools().size)
    }

    @Test
    fun testMockToolExecution() = runTest {
        val mockTool = MockSuccessTool()
        val registry = DefaultToolRegistry()
        registry.registerTool(mockTool)

        val mockCall = ToolCall(
            id = "mock_test",
            function = FunctionCall(
                name = "mock_success",
                arguments = """{"message": "Hello, world!"}"""
            )
        )

        val result = registry.executeTool(ToolExecutionContext(mockCall))

        assertTrue(result.success)
        assertEquals("Successfully processed: Hello, world!", result.message)
        
        val resultData = result.result!!.jsonObject
        assertEquals("Hello, world!", resultData["received"]?.jsonPrimitive?.content)
        assertNotNull(resultData["timestamp"]?.jsonPrimitive?.long)
    }

    @Test
    fun testToolExecutionTimeout() = runTest {
        // Create a tool with very short timeout
        val slowTool = object : ToolExecutor {
            override val tool = Tool(
                name = "slow_tool",
                description = "A tool that takes too long",
                parameters = buildJsonObject { put("type", "object") }
            )

            override suspend fun execute(context: ToolExecutionContext): ToolExecutionResult {
                kotlinx.coroutines.delay(100) // Longer than timeout
                return ToolExecutionResult.success(message = "Should not reach here")
            }

            override fun getMaxExecutionTimeMs(): Long = 10L // Very short timeout
        }

        val registry = DefaultToolRegistry()
        registry.registerTool(slowTool)

        val slowCall = ToolCall(
            id = "slow_test",
            function = FunctionCall(name = "slow_tool", arguments = "{}")
        )

        assertFailsWith<ToolExecutionException> {
            registry.executeTool(ToolExecutionContext(slowCall))
        }
    }

    @Test
    fun testToolRegistryStatistics() = runTest {
        val calculator = CalculatorTool()
        val mockTool = MockSuccessTool()
        
        val registry = toolRegistry {
            addTool(calculator)
            addTool(mockTool)
        }

        // Execute some tools
        val calcCall = ToolCall(
            id = "calc_stats",
            function = FunctionCall(
                name = "calculator",
                arguments = """{"operation": "multiply", "a": 6, "b": 7}"""
            )
        )

        val mockCall = ToolCall(
            id = "mock_stats",
            function = FunctionCall(
                name = "mock_success",
                arguments = """{"message": "test stats"}"""
            )
        )

        registry.executeTool(ToolExecutionContext(calcCall))
        registry.executeTool(ToolExecutionContext(mockCall))

        // Check all statistics
        val allStats = registry.getAllStats()
        assertEquals(2, allStats.size)
        
        val calcStats = allStats["calculator"]
        val mockStats = allStats["mock_success"]
        
        assertNotNull(calcStats)
        assertNotNull(mockStats)
        
        assertEquals(1, calcStats.executionCount)
        assertEquals(1, calcStats.successCount)
        assertEquals(1, mockStats.executionCount)
        assertEquals(1, mockStats.successCount)

        // Clear stats and verify
        registry.clearStats()
        val clearedStats = registry.getAllStats()
        assertTrue(clearedStats.values.all { it.executionCount == 0L })
    }

    @Test
    fun testToolUnregistration() = runTest {
        val registry = DefaultToolRegistry()
        val calculator = CalculatorTool()
        
        registry.registerTool(calculator)
        assertTrue(registry.isToolRegistered("calculator"))

        val wasUnregistered = registry.unregisterTool("calculator")
        assertTrue(wasUnregistered)
        assertFalse(registry.isToolRegistered("calculator"))

        // Try to unregister again
        val secondUnregister = registry.unregisterTool("calculator")
        assertFalse(secondUnregister)
    }

    @Test
    fun testInvalidToolCall() = runTest {
        val calculator = CalculatorTool()
        val registry = DefaultToolRegistry()
        registry.registerTool(calculator)

        // Test invalid JSON
        val invalidJsonCall = ToolCall(
            id = "invalid_json",
            function = FunctionCall(
                name = "calculator",
                arguments = "invalid json string"
            )
        )

        val result = registry.executeTool(ToolExecutionContext(invalidJsonCall))
        assertFalse(result.success)
        assertTrue(result.message?.contains("Invalid JSON arguments") == true)

        // Test missing tool
        val missingToolCall = ToolCall(
            id = "missing_tool",
            function = FunctionCall(
                name = "nonexistent_tool",
                arguments = "{}"
            )
        )

        assertFailsWith<ToolNotFoundException> {
            registry.executeTool(ToolExecutionContext(missingToolCall))
        }
    }
}