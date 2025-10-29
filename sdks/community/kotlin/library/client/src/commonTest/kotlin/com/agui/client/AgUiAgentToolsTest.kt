package com.agui.client

import com.agui.core.types.*
import com.agui.tools.*
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import kotlin.test.*

class AgUiAgentToolsTest {
    
    @Test
    fun testToolsSentOnEveryMessagePerThread() = runTest {
        // Create a mock agent that captures the tools sent in each request
        val mockAgent = MockAgentWithToolsTracking()
        
        val thread1 = "thread_1"
        val thread2 = "thread_2"
        
        // Messages on thread1 - each should include tools
        mockAgent.sendMessage("First message", thread1).toList()
        assertTrue(mockAgent.lastRequestHadTools, "First message on thread1 should include tools")
        assertEquals(2, mockAgent.lastToolsCount, "Should have 2 tools")

        mockAgent.sendMessage("Second message", thread1).toList()
        assertTrue(mockAgent.lastRequestHadTools, "Second message on thread1 should include tools")
        assertEquals(2, mockAgent.lastToolsCount, "Should have 2 tools")

        mockAgent.sendMessage("Third message", thread1).toList()
        assertTrue(mockAgent.lastRequestHadTools, "Third message on thread1 should include tools")
        assertEquals(2, mockAgent.lastToolsCount, "Should have 2 tools")

        // Messages on thread2 should also include tools every time
        mockAgent.sendMessage("First message on thread2", thread2).toList()
        assertTrue(mockAgent.lastRequestHadTools, "First message on thread2 should include tools")
        assertEquals(2, mockAgent.lastToolsCount, "Should have 2 tools")

        mockAgent.sendMessage("Second message on thread2", thread2).toList()
        assertTrue(mockAgent.lastRequestHadTools, "Second message on thread2 should include tools")
        assertEquals(2, mockAgent.lastToolsCount, "Should have 2 tools")
    }
    
    @Test
    fun testNoToolsWhenRegistryIsNull() = runTest {
        // Create agent without tool registry
        val mockAgent = MockAgentWithoutTools()
        
        // Should not have tools regardless of thread state
        mockAgent.sendMessage("Message 1", "thread1").toList()
        assertFalse(mockAgent.lastRequestHadTools, "Should not have tools when registry is null")
        
        mockAgent.sendMessage("Message 2", "thread1").toList() 
        assertFalse(mockAgent.lastRequestHadTools, "Should still not have tools when registry is null")
    }
    
    /**
     * Mock agent that extends AgUiAgent and tracks tools in requests
     */
    private class MockAgentWithToolsTracking : AgUiAgent("http://mock-url", {
        // Set up a tool registry with some test tools
        this.toolRegistry = DefaultToolRegistry().apply {
            registerTool(TestTool1())
            registerTool(TestTool2())
        }
    }) {
        var lastRequestHadTools: Boolean = false
        var lastToolsCount: Int = 0
        
        override fun run(input: RunAgentInput): Flow<BaseEvent> {
            // Capture tools info from the input
            lastRequestHadTools = input.tools.isNotEmpty()
            lastToolsCount = input.tools.size
            
            // Return a simple mock response
            return flow {
                emit(RunStartedEvent(threadId = input.threadId, runId = input.runId))
                emit(RunFinishedEvent(threadId = input.threadId, runId = input.runId))
            }
        }
    }
    
    /**
     * Mock agent without tools for testing null registry behavior
     */
    private class MockAgentWithoutTools : AgUiAgent("http://mock-url", {
        // No tool registry set
    }) {
        var lastRequestHadTools: Boolean = false
        
        override fun run(input: RunAgentInput): Flow<BaseEvent> {
            lastRequestHadTools = input.tools.isNotEmpty()
            
            return flow {
                emit(RunStartedEvent(threadId = input.threadId, runId = input.runId))
                emit(RunFinishedEvent(threadId = input.threadId, runId = input.runId))
            }
        }
    }
    
    /**
     * Test tool implementations
     */
    private class TestTool1 : ToolExecutor {
        override val tool = Tool(
            name = "test_tool_1",
            description = "Test tool 1",
            parameters = JsonObject(emptyMap())
        )
        
        override suspend fun execute(context: ToolExecutionContext): ToolExecutionResult {
            return ToolExecutionResult.success(JsonPrimitive("Test 1"))
        }
    }
    
    private class TestTool2 : ToolExecutor {
        override val tool = Tool(
            name = "test_tool_2", 
            description = "Test tool 2",
            parameters = JsonObject(emptyMap())
        )
        
        override suspend fun execute(context: ToolExecutionContext): ToolExecutionResult {
            return ToolExecutionResult.success(JsonPrimitive("Test 2"))
        }
    }
}
