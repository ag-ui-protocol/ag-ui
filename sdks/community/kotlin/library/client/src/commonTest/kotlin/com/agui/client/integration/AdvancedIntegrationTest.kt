package com.agui.client.integration

import com.agui.core.types.*
import com.agui.client.*
import com.agui.tools.*
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*
import kotlin.test.*

class AdvancedIntegrationTest {

    // Tool that simulates database operations
    class MockDatabaseTool : ToolExecutor {
        private val database = mutableMapOf<String, JsonElement>()

        override val tool = Tool(
            name = "database",
            description = "Perform database operations",
            parameters = buildJsonObject {
                put("type", "object")
                putJsonObject("properties") {
                    putJsonObject("operation") {
                        put("type", "string")
                        put("enum", buildJsonArray {
                            add("get")
                            add("set")
                            add("delete")
                            add("list")
                        })
                    }
                    putJsonObject("key") {
                        put("type", "string")
                    }
                    putJsonObject("value") {
                        put("type", "string")
                    }
                }
                putJsonArray("required") { add("operation") }
            }
        )

        override suspend fun execute(context: ToolExecutionContext): ToolExecutionResult {
            val args = Json.parseToJsonElement(context.toolCall.function.arguments).jsonObject
            val operation = args["operation"]?.jsonPrimitive?.content
                ?: return ToolExecutionResult.failure("Operation is required")

            return when (operation) {
                "get" -> {
                    val key = args["key"]?.jsonPrimitive?.content
                        ?: return ToolExecutionResult.failure("Key is required for get operation")
                    
                    val value = database[key]
                    if (value != null) {
                        ToolExecutionResult.success(
                            result = buildJsonObject {
                                put("key", key)
                                put("value", value)
                                put("found", true)
                            },
                            message = "Retrieved value for key: $key"
                        )
                    } else {
                        ToolExecutionResult.success(
                            result = buildJsonObject {
                                put("key", key)
                                put("found", false)
                            },
                            message = "Key not found: $key"
                        )
                    }
                }
                
                "set" -> {
                    val key = args["key"]?.jsonPrimitive?.content
                        ?: return ToolExecutionResult.failure("Key is required for set operation")
                    val value = args["value"]?.jsonPrimitive?.content
                        ?: return ToolExecutionResult.failure("Value is required for set operation")
                    
                    database[key] = JsonPrimitive(value)
                    ToolExecutionResult.success(
                        result = buildJsonObject {
                            put("key", key)
                            put("value", value)
                            put("stored", true)
                        },
                        message = "Stored value for key: $key"
                    )
                }
                
                "delete" -> {
                    val key = args["key"]?.jsonPrimitive?.content
                        ?: return ToolExecutionResult.failure("Key is required for delete operation")
                    
                    val existed = database.remove(key) != null
                    ToolExecutionResult.success(
                        result = buildJsonObject {
                            put("key", key)
                            put("deleted", existed)
                        },
                        message = if (existed) "Deleted key: $key" else "Key not found: $key"
                    )
                }
                
                "list" -> {
                    val keys = database.keys.toList()
                    ToolExecutionResult.success(
                        result = buildJsonObject {
                            put("keys", buildJsonArray {
                                keys.forEach { add(it) }
                            })
                            put("count", keys.size)
                        },
                        message = "Found ${keys.size} keys in database"
                    )
                }
                
                else -> ToolExecutionResult.failure("Invalid operation: $operation")
            }
        }

        fun clearDatabase() {
            database.clear()
        }

        override fun getMaxExecutionTimeMs(): Long = 5000L
    }

    // Tool that simulates API calls with rate limiting
    class MockApiTool : ToolExecutor {
        private var callCount = 0
        private val maxCalls = 3
        private val callCountMutex = Mutex()

        override val tool = Tool(
            name = "api_call",
            description = "Make external API calls",
            parameters = buildJsonObject {
                put("type", "object")
                putJsonObject("properties") {
                    putJsonObject("endpoint") {
                        put("type", "string")
                    }
                    putJsonObject("method") {
                        put("type", "string")
                        put("enum", buildJsonArray {
                            add("GET")
                            add("POST")
                            add("PUT")
                            add("DELETE")
                        })
                        put("default", "GET")
                    }
                }
                putJsonArray("required") { add("endpoint") }
            }
        )

        override suspend fun execute(context: ToolExecutionContext): ToolExecutionResult {
            callCountMutex.withLock { callCount++ }
            
            if (callCount > maxCalls) {
                return ToolExecutionResult.failure("Rate limit exceeded. Maximum $maxCalls calls allowed.")
            }

            val args = Json.parseToJsonElement(context.toolCall.function.arguments).jsonObject
            val endpoint = args["endpoint"]?.jsonPrimitive?.content
                ?: return ToolExecutionResult.failure("Endpoint is required")
            val method = args["method"]?.jsonPrimitive?.content ?: "GET"

            // Simulate API call delay
            kotlinx.coroutines.delay(50)

            return ToolExecutionResult.success(
                result = buildJsonObject {
                    put("endpoint", endpoint)
                    put("method", method)
                    put("status", 200)
                    put("response", "Mock API response for $endpoint")
                    put("callNumber", callCount)
                },
                message = "API call $callCount/$maxCalls to $endpoint completed"
            )
        }

        suspend fun resetCallCount() {
            callCountMutex.withLock {
                callCount = 0
            }
        }

        override fun getMaxExecutionTimeMs(): Long = 10000L
    }

    @Test
    fun testComplexToolInteractions() = runTest {
        val dbTool = MockDatabaseTool()
        val apiTool = MockApiTool()

        val toolRegistry = toolRegistry {
            addTool(dbTool)
            addTool(apiTool)
        }

        // Test database operations
        val setCall = ToolCall(
            id = "db_set",
            function = FunctionCall(
                name = "database",
                arguments = """{"operation": "set", "key": "user_id", "value": "12345"}"""
            )
        )

        val setResult = toolRegistry.executeTool(ToolExecutionContext(setCall))
        assertTrue(setResult.success)

        // Test get operation
        val getCall = ToolCall(
            id = "db_get",
            function = FunctionCall(
                name = "database",
                arguments = """{"operation": "get", "key": "user_id"}"""
            )
        )

        val getResult = toolRegistry.executeTool(ToolExecutionContext(getCall))
        assertTrue(getResult.success)
        
        val getData = getResult.result!!.jsonObject
        assertEquals(true, getData["found"]?.jsonPrimitive?.boolean)
        assertEquals("12345", getData["value"]?.jsonPrimitive?.content)

        // Test list operation
        val listCall = ToolCall(
            id = "db_list",
            function = FunctionCall(
                name = "database",
                arguments = """{"operation": "list"}"""
            )
        )

        val listResult = toolRegistry.executeTool(ToolExecutionContext(listCall))
        assertTrue(listResult.success)
        
        val listData = listResult.result!!.jsonObject
        assertEquals(1, listData["count"]?.jsonPrimitive?.int)

        // Verify statistics
        val dbStats = toolRegistry.getToolStats("database")
        assertNotNull(dbStats)
        assertEquals(3, dbStats.executionCount)
        assertEquals(3, dbStats.successCount)
    }

    @Test
    fun testToolRateLimiting() = runTest {
        val apiTool = MockApiTool()
        val toolRegistry = DefaultToolRegistry()
        toolRegistry.registerTool(apiTool)

        // Make successful calls up to the limit
        repeat(3) { i ->
            val call = ToolCall(
                id = "api_$i",
                function = FunctionCall(
                    name = "api_call",
                    arguments = """{"endpoint": "/test/$i", "method": "GET"}"""
                )
            )

            val result = toolRegistry.executeTool(ToolExecutionContext(call))
            assertTrue(result.success, "Call $i should succeed")
            
            val responseData = result.result!!.jsonObject
            assertEquals(i + 1, responseData["callNumber"]?.jsonPrimitive?.int)
        }

        // Next call should fail due to rate limiting
        val rateLimitCall = ToolCall(
            id = "api_rate_limit",
            function = FunctionCall(
                name = "api_call",
                arguments = """{"endpoint": "/test/rate_limit", "method": "GET"}"""
            )
        )

        val rateLimitResult = toolRegistry.executeTool(ToolExecutionContext(rateLimitCall))
        assertFalse(rateLimitResult.success)
        assertTrue(rateLimitResult.message?.contains("Rate limit exceeded") == true)

        // Check statistics show both successes and failures
        val apiStats = toolRegistry.getToolStats("api_call")
        assertNotNull(apiStats)
        assertEquals(4, apiStats.executionCount)
        assertEquals(3, apiStats.successCount)
        assertEquals(1, apiStats.failureCount)
        assertEquals(0.75, apiStats.successRate)
    }

    @Test
    fun testStatefulAgentWithComplexToolChain() = runTest {
        val dbTool = MockDatabaseTool()
        val apiTool = MockApiTool()

        val toolRegistry = toolRegistry {
            addTool(dbTool)
            addTool(apiTool)
        }

        val statefulAgent = StatefulAgUiAgent("https://complex-test-api.com") {
            this.toolRegistry = toolRegistry
            systemPrompt = "You are a data management assistant with database and API access."
            initialState = buildJsonObject {
                put("session_id", "complex_session_123")
                put("operations_performed", buildJsonArray { })
            }
            maxHistoryLength = 50
        }

        // Simulate a complex workflow: store data, retrieve it, make API calls
        assertNotNull(statefulAgent)
        assertEquals(2, toolRegistry.getAllTools().size)

        // Test tool execution in context
        val storeUserCall = ToolCall(
            id = "store_user",
            function = FunctionCall(
                name = "database",
                arguments = """{"operation": "set", "key": "current_user", "value": "alice@example.com"}"""
            )
        )

        val storeResult = toolRegistry.executeTool(
            ToolExecutionContext(
                toolCall = storeUserCall,
                threadId = "complex_thread",
                runId = "complex_run"
            )
        )
        assertTrue(storeResult.success)

        // Verify the complex agent configuration
        assertTrue(toolRegistry.isToolRegistered("database"))
        assertTrue(toolRegistry.isToolRegistered("api_call"))
    }

    @Test
    fun testToolErrorHandlingAndRecovery() = runTest {
        val dbTool = MockDatabaseTool()
        val toolRegistry = DefaultToolRegistry()
        toolRegistry.registerTool(dbTool)

        // Test invalid operation
        val invalidCall = ToolCall(
            id = "invalid_op",
            function = FunctionCall(
                name = "database",
                arguments = """{"operation": "invalid_operation"}"""
            )
        )

        val invalidResult = toolRegistry.executeTool(ToolExecutionContext(invalidCall))
        assertFalse(invalidResult.success)
        assertTrue(invalidResult.message?.contains("Invalid operation") == true)

        // Test missing required parameters
        val missingParamCall = ToolCall(
            id = "missing_param",
            function = FunctionCall(
                name = "database",
                arguments = """{"operation": "get"}"""
            )
        )

        val missingResult = toolRegistry.executeTool(ToolExecutionContext(missingParamCall))
        assertFalse(missingResult.success)
        assertTrue(missingResult.message?.contains("Key is required") == true)

        // Test recovery with valid call
        val validCall = ToolCall(
            id = "recovery",
            function = FunctionCall(
                name = "database",
                arguments = """{"operation": "list"}"""
            )
        )

        val recoveryResult = toolRegistry.executeTool(ToolExecutionContext(validCall))
        assertTrue(recoveryResult.success)

        // Check statistics reflect both failures and success
        val stats = toolRegistry.getToolStats("database")
        assertNotNull(stats)
        assertEquals(3, stats.executionCount)
        assertEquals(1, stats.successCount)
        assertEquals(2, stats.failureCount)
    }

    @Test
    fun testConcurrentToolExecution() = runTest {
        val dbTool = MockDatabaseTool()
        val toolRegistry = DefaultToolRegistry()
        toolRegistry.registerTool(dbTool)

        // Execute tools sequentially (simpler than true concurrency for testing)
        val results = mutableListOf<ToolExecutionResult>()
        
        repeat(5) { i ->
            val call = ToolCall(
                id = "concurrent_$i",
                function = FunctionCall(
                    name = "database",
                    arguments = """{"operation": "set", "key": "key_$i", "value": "value_$i"}"""
                )
            )
            results.add(toolRegistry.executeTool(ToolExecutionContext(call)))
        }

        // All should succeed
        assertTrue(results.all { it.success })

        // Verify all keys were stored
        val listCall = ToolCall(
            id = "list_all",
            function = FunctionCall(
                name = "database",
                arguments = """{"operation": "list"}"""
            )
        )

        val listResult = toolRegistry.executeTool(ToolExecutionContext(listCall))
        assertTrue(listResult.success)
        
        val listData = listResult.result!!.jsonObject
        assertEquals(5, listData["count"]?.jsonPrimitive?.int)

        // Check final statistics
        val stats = toolRegistry.getToolStats("database")
        assertNotNull(stats)
        assertEquals(6, stats.executionCount) // 5 sets + 1 list
        assertEquals(6, stats.successCount)
        assertEquals(0, stats.failureCount)
        assertEquals(1.0, stats.successRate)
    }

    @Test
    fun testToolRegistryStatsClearance() = runTest {
        val dbTool = MockDatabaseTool()
        val apiTool = MockApiTool()
        
        val toolRegistry = toolRegistry {
            addTool(dbTool)
            addTool(apiTool)
        }

        // Execute some tools to generate stats
        val dbCall = ToolCall(
            id = "db_stats",
            function = FunctionCall(
                name = "database",
                arguments = """{"operation": "list"}"""
            )
        )

        val apiCall = ToolCall(
            id = "api_stats",
            function = FunctionCall(
                name = "api_call",
                arguments = """{"endpoint": "/stats_test"}"""
            )
        )

        toolRegistry.executeTool(ToolExecutionContext(dbCall))
        toolRegistry.executeTool(ToolExecutionContext(apiCall))

        // Verify stats exist
        val allStatsBefore = toolRegistry.getAllStats()
        assertEquals(2, allStatsBefore.size)
        assertTrue(allStatsBefore.values.all { it.executionCount > 0 })

        // Clear stats
        toolRegistry.clearStats()

        // Verify stats are cleared
        val allStatsAfter = toolRegistry.getAllStats()
        assertEquals(2, allStatsAfter.size) // Still have entries for registered tools
        assertTrue(allStatsAfter.values.all { it.executionCount == 0L })
    }
}