package com.agui.example.chatapp.viewmodel

import com.agui.example.chatapp.data.model.AgentConfig
import com.agui.example.chatapp.data.model.AuthMethod
import com.agui.example.chatapp.data.repository.AgentRepository
import com.agui.example.chatapp.test.TestSettings
import com.agui.core.types.*
import com.agui.example.chatapp.ui.screens.chat.ChatViewModel
import com.agui.example.chatapp.ui.screens.chat.MessageRole
import kotlinx.coroutines.test.runTest
import kotlin.test.*

/**
 * Tests for ChatViewModel error handling capabilities.
 * Tests various error scenarios and recovery mechanisms.
 */
class ChatViewModelErrorHandlingTest {

    private lateinit var testSettings: TestSettings
    private lateinit var agentRepository: AgentRepository
    private lateinit var viewModel: ChatViewModel

    @BeforeTest
    fun setup() {
        AgentRepository.resetInstance()
        testSettings = TestSettings()
        agentRepository = AgentRepository.getInstance(testSettings)
        viewModel = ChatViewModel()

        // Set up test agent
        val testAgent = AgentConfig(
            id = "test-agent",
            name = "Test Agent",
            url = "https://test.com/agent",
            authMethod = AuthMethod.None()
        )
    }

    @AfterTest
    fun tearDown() {
        AgentRepository.resetInstance()
    }


    @Test
    fun testRunErrorWithoutCode() = runTest {
        // Test error event without error code
        val errorEvent = RunErrorEvent(
            message = "Something went wrong",
            code = null
        )

        viewModel.handleAgentEvent(errorEvent)

        val state = viewModel.state.value
        val errorMessage = state.messages.find { 
            it.role == MessageRole.ERROR && it.content.contains("Something went wrong")
        }
        
        assertNotNull(errorMessage)
    }

    @Test
    fun testMultipleErrorEvents() = runTest {
        // Test handling multiple error events
        val errors = listOf(
            RunErrorEvent("First error", "ERROR_1"),
            RunErrorEvent("Second error", "ERROR_2"),
            RunErrorEvent("Third error", "ERROR_3")
        )

        errors.forEach { viewModel.handleAgentEvent(it) }

        // Verify all errors are displayed
        val state = viewModel.state.value
        val errorMessages = state.messages.filter { it.role == MessageRole.ERROR }
        
        assertEquals(3, errorMessages.size)
        assertTrue(errorMessages.any { it.content.contains("First error") })
        assertTrue(errorMessages.any { it.content.contains("Second error") })
        assertTrue(errorMessages.any { it.content.contains("Third error") })
    }

    @Test
    fun testInvalidJsonInToolArgs() = runTest {
        // Test handling of invalid JSON in tool arguments
        viewModel.handleAgentEvent(ToolCallStartEvent("tool-123", "test_tool"))
        
        // Send invalid JSON
        val invalidJson = """{"action": "test", invalid json structure}"""
        viewModel.handleAgentEvent(ToolCallArgsEvent("tool-123", invalidJson))
        viewModel.handleAgentEvent(ToolCallEndEvent("tool-123"))

        // Verify no confirmation dialog is created for invalid JSON
        val state = viewModel.state.value
        assertNull(state.pendingConfirmation)
        
        // Tool call ephemeral message should still exist
        val toolMessage = state.messages.find { it.role == MessageRole.TOOL_CALL }
        assertNotNull(toolMessage)
    }

    @Test
    fun testInvalidJsonInConfirmationTool() = runTest {
        // Test invalid JSON specifically in confirmation tool
        viewModel.handleAgentEvent(ToolCallStartEvent("confirm-123", "user_confirmation"))
        
        // Send malformed confirmation JSON
        val malformedJson = """{"action": "Test action", "impact": unclosed string"""
        viewModel.handleAgentEvent(ToolCallArgsEvent("confirm-123", malformedJson))
        viewModel.handleAgentEvent(ToolCallEndEvent("confirm-123"))

        // Verify no confirmation dialog is created
        val state = viewModel.state.value
        assertNull(state.pendingConfirmation)
    }

    @Test
    fun testMissingRequiredConfirmationFields() = runTest {
        // Test confirmation with missing required fields
        viewModel.handleAgentEvent(ToolCallStartEvent("confirm-123", "user_confirmation"))
        
        // JSON missing required 'action' field
        val incompleteJson = """{"impact": "high", "details": {}}"""
        viewModel.handleAgentEvent(ToolCallArgsEvent("confirm-123", incompleteJson))
        viewModel.handleAgentEvent(ToolCallEndEvent("confirm-123"))

        // Should handle gracefully - either create with defaults or reject
        val state = viewModel.state.value
        // This depends on implementation - could be null or have default values
    }


    @Test
    fun testToolCallWithoutStart() = runTest {
        // Test tool call events without proper start event
        
        // Send args without starting tool call
        viewModel.handleAgentEvent(ToolCallArgsEvent("orphan-tool", """{"test": "args"}"""))
        viewModel.handleAgentEvent(ToolCallEndEvent("orphan-tool"))

        // Should handle gracefully
        val state = viewModel.state.value
        assertNotNull(state)
    }

    @Test
    fun testMessageContentWithoutStart() = runTest {
        // Test message content events without start event
        
        viewModel.handleAgentEvent(TextMessageContentEvent("orphan-msg", "Content without start"))
        viewModel.handleAgentEvent(TextMessageEndEvent("orphan-msg"))

        // Should handle gracefully
        val state = viewModel.state.value
        assertNotNull(state)
    }

    @Test
    fun testExtremelyLongContent() = runTest {
        // Test handling of very long content
        val longContent = "x".repeat(10000)
        
        viewModel.handleAgentEvent(TextMessageStartEvent("long-msg"))
        viewModel.handleAgentEvent(TextMessageContentEvent("long-msg", longContent))
        viewModel.handleAgentEvent(TextMessageEndEvent("long-msg"))

        // Verify content is handled properly
        val state = viewModel.state.value
        val message = state.messages.find { it.id == "long-msg" }
        assertNotNull(message)
        assertEquals(longContent, message.content)
    }


    @Test
    fun testErrorRecovery() = runTest {
        // Test system recovery after errors
        
        // Cause an error
        viewModel.handleAgentEvent(RunErrorEvent("Connection lost", "NETWORK_ERROR"))
        
        // System should continue working after error
        viewModel.handleAgentEvent(TextMessageStartEvent("recovery-msg"))
        viewModel.handleAgentEvent(TextMessageContentEvent("recovery-msg", "System recovered"))
        viewModel.handleAgentEvent(TextMessageEndEvent("recovery-msg"))

        // Verify both error and recovery message exist
        val state = viewModel.state.value
        val errorMessage = state.messages.find { it.role == MessageRole.ERROR }
        val recoveryMessage = state.messages.find { it.id == "recovery-msg" }
        
        assertNotNull(errorMessage)
        assertNotNull(recoveryMessage)
        assertEquals("System recovered", recoveryMessage.content)
    }

    @Test
    fun testConcurrentErrorHandling() = runTest {
        // Test handling multiple errors concurrently
        
        // Send multiple error events rapidly
        repeat(5) { i ->
            viewModel.handleAgentEvent(RunErrorEvent("Concurrent error $i", "ERROR_$i"))
        }

        // All errors should be handled
        val state = viewModel.state.value
        val errorMessages = state.messages.filter { it.role == MessageRole.ERROR }
        assertEquals(5, errorMessages.size)
    }

    @Test
    fun testStateConsistencyAfterErrors() = runTest {
        // Test that state remains consistent after various errors
        
        val initialMessageCount = viewModel.state.value.messages.size
        
        // Create various error conditions
        viewModel.handleAgentEvent(RunErrorEvent("Error 1", "E1"))
        viewModel.handleAgentEvent(ToolCallStartEvent("bad-tool", "nonexistent_tool"))
        viewModel.handleAgentEvent(ToolCallArgsEvent("bad-tool", "invalid json"))
        viewModel.handleAgentEvent(TextMessageContentEvent("missing-msg", "orphaned content"))
        
        // Verify state is still consistent
        val state = viewModel.state.value
        assertNotNull(state)
        assertNotNull(state.messages)
        assertTrue(state.messages.size >= initialMessageCount)
        
        // Verify we can still process normal events
        viewModel.handleAgentEvent(TextMessageStartEvent("normal-msg"))
        viewModel.handleAgentEvent(TextMessageContentEvent("normal-msg", "Normal content"))
        viewModel.handleAgentEvent(TextMessageEndEvent("normal-msg"))
        
        val finalState = viewModel.state.value
        val normalMessage = finalState.messages.find { it.id == "normal-msg" }
        assertNotNull(normalMessage)
        assertEquals("Normal content", normalMessage.content)
    }
}