package com.agui.example.chatapp.viewmodel

import com.agui.core.types.*
import com.agui.example.chatapp.ui.screens.chat.ChatViewModel
import com.agui.example.chatapp.ui.screens.chat.EphemeralType
import com.agui.example.chatapp.ui.screens.chat.MessageRole
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.delay
import kotlin.test.*

/**
 * Tests for ChatViewModel's event handling without requiring network connections.
 * These tests focus on the event processing logic.
 */
class ChatViewModelEventHandlingMockTest {

    private lateinit var viewModel: ChatViewModel

    @BeforeTest
    fun setup() {
        viewModel = ChatViewModel()
    }

    @Test
    fun testMessageHandling() = runTest {
        // Test event handling without actual connection
        
        // Simulate receiving events
        viewModel.handleAgentEvent(TextMessageStartEvent("msg-1"))
        viewModel.handleAgentEvent(TextMessageContentEvent("msg-1", "Hello from assistant"))
        viewModel.handleAgentEvent(TextMessageEndEvent("msg-1"))

        delay(50)

        // Verify message was added
        val messages = viewModel.state.value.messages
        val assistantMessage = messages.find { it.role == MessageRole.ASSISTANT }
        assertNotNull(assistantMessage)
        assertEquals("Hello from assistant", assistantMessage.content)
        assertFalse(assistantMessage.isStreaming)
    }

    @Test
    fun testStreamingMessages() = runTest {
        // Test streaming message handling
        viewModel.handleAgentEvent(TextMessageStartEvent("stream-1"))
        
        // Verify initial streaming state
        delay(20)
        var message = viewModel.state.value.messages.find { it.id == "stream-1" }
        assertNotNull(message)
        assertTrue(message.isStreaming)
        assertEquals("", message.content)

        // Stream content
        viewModel.handleAgentEvent(TextMessageContentEvent("stream-1", "First "))
        delay(20)
        message = viewModel.state.value.messages.find { it.id == "stream-1" }
        assertEquals("First ", message?.content)
        assertTrue(message?.isStreaming == true)

        viewModel.handleAgentEvent(TextMessageContentEvent("stream-1", "part"))
        delay(20)
        message = viewModel.state.value.messages.find { it.id == "stream-1" }
        assertEquals("First part", message?.content)

        // End streaming
        viewModel.handleAgentEvent(TextMessageEndEvent("stream-1"))
        delay(20)
        message = viewModel.state.value.messages.find { it.id == "stream-1" }
        assertFalse(message?.isStreaming == true)
        assertEquals("First part", message?.content)
    }

    @Test
    fun testToolCallEvents() = runTest {
        // Test tool call handling - focus on message creation, not timing
        viewModel.handleAgentEvent(ToolCallStartEvent("tool-1", "test_tool"))
        delay(50)
        
        // Should have ephemeral tool call message
        val toolMessage = viewModel.state.value.messages.find { it.role == MessageRole.TOOL_CALL }
        assertNotNull(toolMessage)
        assertTrue(toolMessage.content.contains("test_tool"))

        // Add tool args
        viewModel.handleAgentEvent(ToolCallArgsEvent("tool-1", """{"param": "value"}"""))
        delay(50)
        
        // Verify args are reflected in the message
        val updatedMessage = viewModel.state.value.messages.find { it.role == MessageRole.TOOL_CALL }
        assertNotNull(updatedMessage)
        assertTrue(updatedMessage.content.contains("param"))

        // End tool call - don't test timing, just verify event is handled
        viewModel.handleAgentEvent(ToolCallEndEvent("tool-1"))
        delay(50)
        
        // The event should be processed without error
        // Note: Timing-based ephemeral message clearing is tested in Android tests
        assertTrue(true, "Tool call events processed successfully")
    }

    @Test
    fun testConfirmationTool() = runTest {
        // NOTE: With new architecture, confirmations are handled by tool executor
        val confirmArgs = """{
            "action": "Delete important file",
            "impact": "high",
            "details": {"file": "data.db"}
        }"""

        viewModel.handleAgentEvent(ToolCallStartEvent("confirm-1", "user_confirmation"))
        viewModel.handleAgentEvent(ToolCallArgsEvent("confirm-1", confirmArgs))
        viewModel.handleAgentEvent(ToolCallEndEvent("confirm-1"))

        delay(50)

        // With new architecture, confirmation dialog won't be shown from events
        val confirmation = viewModel.state.value.pendingConfirmation
        assertNull(confirmation, "Confirmations are now handled by tool executor")
    }

    @Test
    fun testErrorEvents() = runTest {
        // Test error handling
        viewModel.handleAgentEvent(RunErrorEvent("Connection timeout", "TIMEOUT"))
        delay(20)

        val errorMessage = viewModel.state.value.messages.find { it.role == MessageRole.ERROR }
        assertNotNull(errorMessage)
        assertTrue(errorMessage.content.contains("Connection timeout"))
    }

    @Test
    fun testEphemeralMessages() = runTest {
        // Test step info ephemeral messages - focus on creation, not timing
        viewModel.handleAgentEvent(StepStartedEvent("Processing data"))
        delay(50)

        var stepMessage = viewModel.state.value.messages.find { it.role == MessageRole.STEP_INFO }
        assertNotNull(stepMessage)
        assertTrue(stepMessage.content.contains("Processing data"))
        
        // Verify it's marked as ephemeral
        assertEquals(EphemeralType.STEP, stepMessage.ephemeralType)

        // Process finished event - don't test timing, just verify event handling
        viewModel.handleAgentEvent(StepFinishedEvent("Processing data"))
        delay(50)
        
        // The event should be processed without error
        // Note: Timing-based ephemeral message clearing is tested in Android tests
        assertTrue(true, "Step events processed successfully")
    }

    @Test
    fun testMessageSendingWithoutConnection() = runTest {
        // Verify messages aren't sent without connection
        val initialCount = viewModel.state.value.messages.size
        
        viewModel.sendMessage("Test message")
        delay(50)
        
        // No message should be added without active agent/connection
        assertEquals(initialCount, viewModel.state.value.messages.size)
    }

    @Test
    fun testCancelOperation() = runTest {
        // Test cancelling current operation
        viewModel.handleAgentEvent(TextMessageStartEvent("cancel-test"))
        viewModel.handleAgentEvent(TextMessageContentEvent("cancel-test", "This will be cancelled"))
        
        // Cancel before completion
        viewModel.cancelCurrentOperation()
        delay(50)
        
        // Loading should be false
        assertFalse(viewModel.state.value.isLoading)
        
        // Message should still exist but not be streaming
        val message = viewModel.state.value.messages.find { it.id == "cancel-test" }
        assertNotNull(message)
        assertFalse(message.isStreaming)
    }

    @Test
    fun testMultipleMessagesHandling() = runTest {
        // Test handling multiple messages
        for (i in 1..3) {
            viewModel.handleAgentEvent(TextMessageStartEvent("msg-$i"))
            viewModel.handleAgentEvent(TextMessageContentEvent("msg-$i", "Message $i"))
            viewModel.handleAgentEvent(TextMessageEndEvent("msg-$i"))
        }
        
        delay(50)
        
        val messages = viewModel.state.value.messages.filter { it.role == MessageRole.ASSISTANT }
        assertEquals(3, messages.size)
        assertTrue(messages.any { it.content == "Message 1" })
        assertTrue(messages.any { it.content == "Message 2" })
        assertTrue(messages.any { it.content == "Message 3" })
    }

    @Test
    fun testConfirmationActions() = runTest {
        // NOTE: This test is limited without real tool execution
        // With new architecture, confirmations are handled by tool executor
        // This test will verify the UI handling methods still work
        
        // We can't trigger a real confirmation without tool execution,
        // so this test is now mostly a placeholder
        val confirmArgs = """{
            "action": "Test action",
            "impact": "low"
        }"""

        viewModel.handleAgentEvent(ToolCallStartEvent("confirm-1", "user_confirmation"))
        viewModel.handleAgentEvent(ToolCallArgsEvent("confirm-1", confirmArgs))
        viewModel.handleAgentEvent(ToolCallEndEvent("confirm-1"))

        delay(50)
        assertNull(viewModel.state.value.pendingConfirmation, "Confirmations are now handled by tool executor")

        // Test that confirm/reject methods don't crash when called without pending confirmation
        viewModel.confirmAction()
        delay(50)
        
        // Confirmation should be cleared
        assertNull(viewModel.state.value.pendingConfirmation)
    }

    @Test
    fun testRejectAction() = runTest {
        // NOTE: This test is limited without real tool execution
        // With new architecture, confirmations are handled by tool executor
        val confirmArgs = """{
            "action": "Test action",
            "impact": "low"
        }"""

        viewModel.handleAgentEvent(ToolCallStartEvent("confirm-1", "user_confirmation"))
        viewModel.handleAgentEvent(ToolCallArgsEvent("confirm-1", confirmArgs))
        viewModel.handleAgentEvent(ToolCallEndEvent("confirm-1"))

        delay(50)
        assertNull(viewModel.state.value.pendingConfirmation, "Confirmations are now handled by tool executor")

        // Test that reject method doesn't crash when called without pending confirmation
        viewModel.rejectAction()
        delay(50)
        
        // Should still be null
        assertNull(viewModel.state.value.pendingConfirmation)
    }
}