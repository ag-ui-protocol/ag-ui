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
import kotlin.test.Ignore

/**
 * Tests for tool confirmation flow in ChatViewModel.
 * 
 * NOTE: With the new AgentClient architecture, confirmation dialogs are shown
 * by the ConfirmationToolExecutor when tools are executed on the agent side.
 * These tests are limited because they don't have a real agent connection.
 * Full integration testing would require a mock agent or integration tests.
 */
class ChatViewModelToolConfirmationTest {

    private lateinit var testSettings: TestSettings
    private lateinit var agentRepository: AgentRepository
    private lateinit var viewModel: ChatViewModel

    @BeforeTest
    fun setup() {
        // Reset singleton instances
        AgentRepository.resetInstance()

        testSettings = TestSettings()
        agentRepository = AgentRepository.getInstance(testSettings)
        viewModel = ChatViewModel()

        // Set up a test agent
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
    fun testUserConfirmationToolDetection() = runTest {
        // Start a user_confirmation tool call
        val toolStartEvent = ToolCallStartEvent(
            toolCallId = "confirm-123",
            toolCallName = "user_confirmation"
        )

        viewModel.handleAgentEvent(toolStartEvent)

        // Verify that no ephemeral message is created for confirmation tools
        val state = viewModel.state.value
        val toolMessages = state.messages.filter { it.role == MessageRole.TOOL_CALL }
        assertTrue(toolMessages.isEmpty(), "Confirmation tools should not show ephemeral messages")
    }



    @Test
    fun testConfirmationWithInvalidJson() = runTest {
        // Test error handling for malformed JSON
        viewModel.handleAgentEvent(ToolCallStartEvent("confirm-123", "user_confirmation"))
        
        // Use truly malformed JSON
        val invalidArgs = """{"action": "Test", "invalid": json, missing quotes}"""
        
        viewModel.handleAgentEvent(ToolCallArgsEvent("confirm-123", invalidArgs))
        viewModel.handleAgentEvent(ToolCallEndEvent("confirm-123"))

        // Verify no confirmation dialog is shown (the exception should be caught)
        val state = viewModel.state.value
        assertNull(state.pendingConfirmation, "Invalid JSON should not create confirmation dialog")
    }







    @Test
    fun testNonConfirmationToolsIgnored() = runTest {
        // Test that regular tools don't trigger confirmation dialog
        viewModel.handleAgentEvent(ToolCallStartEvent("tool-123", "file_read"))
        
        val regularArgs = """{"path": "/some/file.txt"}"""
        
        viewModel.handleAgentEvent(ToolCallArgsEvent("tool-123", regularArgs))
        viewModel.handleAgentEvent(ToolCallEndEvent("tool-123"))

        // Verify no confirmation dialog is shown
        val state = viewModel.state.value
        assertNull(state.pendingConfirmation, "Regular tools should not show confirmation dialog")
    }



}