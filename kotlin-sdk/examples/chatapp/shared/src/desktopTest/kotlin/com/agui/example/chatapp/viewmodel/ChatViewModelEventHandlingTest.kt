package com.agui.example.chatapp.viewmodel

import com.agui.example.chatapp.data.model.AgentConfig
import com.agui.example.chatapp.data.model.AuthMethod
import com.agui.example.chatapp.data.repository.AgentRepository
import com.agui.example.chatapp.test.TestSettings
import com.agui.core.types.*
import com.agui.example.chatapp.ui.screens.chat.ChatViewModel
import com.agui.example.chatapp.ui.screens.chat.EphemeralType
import com.agui.example.chatapp.ui.screens.chat.MessageRole
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import kotlin.test.*

/**
 * Note: These tests use the real ChatViewModel which requires platform settings.
 * They are designed to run on Desktop/JVM where platform settings work without Android context.
 * For Android unit tests, use TestChatViewModel instead.
 */

/**
 * Comprehensive tests for ChatViewModel event handling.
 * Tests how the ChatViewModel processes different types of events from the agent.
 */
class ChatViewModelEventHandlingTest {

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
    fun testTextMessageStartEvent() = runTest {
        // Create a TextMessageStartEvent
        val event = TextMessageStartEvent(
            messageId = "msg-123"
        )

        // Simulate event handling
        viewModel.handleAgentEvent(event)

        // Verify that a new streaming message was added
        val state = viewModel.state.value
        val message = state.messages.find { it.id == "msg-123" }
        
        assertNotNull(message)
        assertEquals(MessageRole.ASSISTANT, message.role)
        assertEquals("", message.content) // Should start empty
        assertTrue(message.isStreaming)
    }

    @Test
    fun testTextMessageContentEvent() = runTest {
        // First, start a message
        val startEvent = TextMessageStartEvent(
            messageId = "msg-123"
        )
        viewModel.handleAgentEvent(startEvent)

        // Then send content deltas
        val contentEvent1 = TextMessageContentEvent(
            messageId = "msg-123",
            delta = "Hello"
        )
        viewModel.handleAgentEvent(contentEvent1)

        val contentEvent2 = TextMessageContentEvent(
            messageId = "msg-123",
            delta = " world!"
        )
        viewModel.handleAgentEvent(contentEvent2)

        // Verify content accumulation
        val state = viewModel.state.value
        val message = state.messages.find { it.id == "msg-123" }
        
        assertNotNull(message)
        assertEquals("Hello world!", message.content)
        assertTrue(message.isStreaming)
    }

    @Test
    fun testTextMessageEndEvent() = runTest {
        // Start and populate a message
        viewModel.handleAgentEvent(TextMessageStartEvent("msg-123"))
        viewModel.handleAgentEvent(TextMessageContentEvent("msg-123", "Complete message"))
        
        // End the message
        val endEvent = TextMessageEndEvent(messageId = "msg-123")
        viewModel.handleAgentEvent(endEvent)

        // Verify message is no longer streaming
        val state = viewModel.state.value
        val message = state.messages.find { it.id == "msg-123" }
        
        assertNotNull(message)
        assertEquals("Complete message", message.content)
        assertFalse(message.isStreaming)
    }

    @Test
    fun testToolCallStartEvent() = runTest {
        // Create a tool call start event
        val event = ToolCallStartEvent(
            toolCallId = "tool-123",
            toolCallName = "test_tool"
        )

        viewModel.handleAgentEvent(event)

        // Verify ephemeral message is created
        val state = viewModel.state.value
        val ephemeralMessage = state.messages.find { 
            it.role == MessageRole.TOOL_CALL && it.content.contains("test_tool")
        }
        
        assertNotNull(ephemeralMessage)
        assertEquals(EphemeralType.TOOL_CALL, ephemeralMessage.ephemeralType)
    }

    @Test
    fun testToolCallArgsEvent() = runTest {
        // Start a tool call
        viewModel.handleAgentEvent(ToolCallStartEvent("tool-123", "test_tool"))
        
        // Send args in chunks
        val argsEvent1 = ToolCallArgsEvent(
            toolCallId = "tool-123",
            delta = """{"param": """
        )
        viewModel.handleAgentEvent(argsEvent1)

        val argsEvent2 = ToolCallArgsEvent(
            toolCallId = "tool-123",
            delta = """"value"}"""
        )
        viewModel.handleAgentEvent(argsEvent2)

        // Verify ephemeral message is updated with args preview
        val state = viewModel.state.value
        val ephemeralMessage = state.messages.find { 
            it.role == MessageRole.TOOL_CALL
        }
        
        assertNotNull(ephemeralMessage)
        assertTrue(ephemeralMessage.content.contains("tool with:"))
        assertTrue(ephemeralMessage.content.contains("""{"param": "value"}"""))
    }

    @Test
    fun testToolCallEndEvent() = runTest {
        // Start a tool call
        viewModel.handleAgentEvent(ToolCallStartEvent("tool-123", "test_tool"))
        viewModel.handleAgentEvent(ToolCallArgsEvent("tool-123", """{"test": "args"}"""))
        
        // End the tool call
        val endEvent = ToolCallEndEvent(toolCallId = "tool-123")
        viewModel.handleAgentEvent(endEvent)

        // For non-confirmation tools, ephemeral message should be cleared after delay
        // We can't easily test the delay here, but we can verify the event was processed
        val state = viewModel.state.value
        // The ephemeral message might still be there since delay hasn't executed
        // This test mainly ensures no exceptions are thrown
        assertNotNull(state)
    }

    @Test
    fun testUserConfirmationToolFlow() = runTest {
        // NOTE: With new architecture, confirmation dialogs are handled by tool executor
        // Start a user_confirmation tool call
        viewModel.handleAgentEvent(ToolCallStartEvent("confirm-123", "user_confirmation"))
        
        // Send confirmation args
        val confirmationArgs = """
            {
                "action": "Delete file",
                "impact": "high",
                "details": {"file": "important.txt"},
                "timeout_seconds": 30
            }
        """.trimIndent()
        
        viewModel.handleAgentEvent(ToolCallArgsEvent("confirm-123", confirmationArgs))
        viewModel.handleAgentEvent(ToolCallEndEvent("confirm-123"))

        // With new architecture, confirmation dialog won't be shown from events
        val state = viewModel.state.value
        assertNull(state.pendingConfirmation, "Confirmations are now handled by tool executor")
    }

    @Test
    fun testStepStartedEvent() = runTest {
        val event = StepStartedEvent(stepName = "Processing data")
        viewModel.handleAgentEvent(event)

        // Verify step ephemeral message is created
        val state = viewModel.state.value
        val stepMessage = state.messages.find { 
            it.role == MessageRole.STEP_INFO && it.content.contains("Processing data")
        }
        
        assertNotNull(stepMessage)
        assertEquals(EphemeralType.STEP, stepMessage.ephemeralType)
    }

    @Test
    fun testStepFinishedEvent() = runTest {
        // Start a step
        viewModel.handleAgentEvent(StepStartedEvent("Processing data"))
        
        // Finish the step
        val finishEvent = StepFinishedEvent(stepName = "Processing data")
        viewModel.handleAgentEvent(finishEvent)

        // Step message should be cleared after delay (can't test delay directly)
        val state = viewModel.state.value
        assertNotNull(state) // Just verify no exceptions
    }

    @Test
    fun testRunErrorEvent() = runTest {
        val errorEvent = RunErrorEvent(
            message = "Connection failed",
            code = "NETWORK_ERROR"
        )
        
        viewModel.handleAgentEvent(errorEvent)

        // Verify error message is added
        val state = viewModel.state.value
        val errorMessage = state.messages.find { 
            it.role == MessageRole.ERROR && it.content.contains("Connection failed")
        }
        
        assertNotNull(errorMessage)
    }

    @Test
    fun testRunFinishedEvent() = runTest {
        // Add some ephemeral messages first
        viewModel.handleAgentEvent(ToolCallStartEvent("tool-123", "test_tool"))
        viewModel.handleAgentEvent(StepStartedEvent("test step"))
        
        val runFinishedEvent = RunFinishedEvent(
            threadId = "thread-123",
            runId = "run-123"
        )
        
        viewModel.handleAgentEvent(runFinishedEvent)

        // Verify ephemeral messages are cleared
        // Note: The actual clearing happens asynchronously, but we can verify the event was processed
        val state = viewModel.state.value
        assertNotNull(state)
    }

    @Test
    fun testEphemeralMessageManagement() = runTest {
        // Test that ephemeral messages replace each other by type
        
        // Add first tool call
        viewModel.handleAgentEvent(ToolCallStartEvent("tool-1", "first_tool"))
        val state1 = viewModel.state.value
        val toolMessages1 = state1.messages.filter { it.role == MessageRole.TOOL_CALL }
        assertEquals(1, toolMessages1.size)
        
        // Add second tool call (should replace first)
        viewModel.handleAgentEvent(ToolCallStartEvent("tool-2", "second_tool"))
        val state2 = viewModel.state.value
        val toolMessages2 = state2.messages.filter { it.role == MessageRole.TOOL_CALL }
        assertEquals(1, toolMessages2.size) // Still only one
        assertTrue(toolMessages2.first().content.contains("second_tool"))
        
        // Add step (should coexist with tool message)
        viewModel.handleAgentEvent(StepStartedEvent("test step"))
        val state3 = viewModel.state.value
        val stepMessages = state3.messages.filter { it.role == MessageRole.STEP_INFO }
        assertEquals(1, stepMessages.size)
        assertEquals(2, state3.messages.filter { it.ephemeralType != null }.size)
    }

    @Test
    fun testStateSnapshotAndDeltaEventsIgnored() = runTest {
        // These events should be processed but not create UI messages
        val snapshotEvent = StateSnapshotEvent(
            snapshot = buildJsonObject { 
                put("key", "value") 
            }
        )
        val deltaEvent = StateDeltaEvent(
            delta = buildJsonArray { 
                addJsonObject {
                    put("op", "replace")
                    put("path", "/key")
                    put("value", "new_value")
                }
            }
        )
        
        val initialMessageCount = viewModel.state.value.messages.size
        
        viewModel.handleAgentEvent(snapshotEvent)
        viewModel.handleAgentEvent(deltaEvent)
        
        // Message count should remain the same
        val finalMessageCount = viewModel.state.value.messages.size
        assertEquals(initialMessageCount, finalMessageCount)
    }

    @Test
    fun testMultipleMessageStreaming() = runTest {
        // Test handling multiple concurrent streaming messages
        
        // Start first message
        viewModel.handleAgentEvent(TextMessageStartEvent("msg-1"))
        viewModel.handleAgentEvent(TextMessageContentEvent("msg-1", "First "))
        
        // Start second message
        viewModel.handleAgentEvent(TextMessageStartEvent("msg-2"))
        viewModel.handleAgentEvent(TextMessageContentEvent("msg-2", "Second "))
        
        // Continue both messages
        viewModel.handleAgentEvent(TextMessageContentEvent("msg-1", "message"))
        viewModel.handleAgentEvent(TextMessageContentEvent("msg-2", "message"))
        
        // End both messages
        viewModel.handleAgentEvent(TextMessageEndEvent("msg-1"))
        viewModel.handleAgentEvent(TextMessageEndEvent("msg-2"))
        
        // Verify both messages exist with correct content
        val state = viewModel.state.value
        val msg1 = state.messages.find { it.id == "msg-1" }
        val msg2 = state.messages.find { it.id == "msg-2" }
        
        assertNotNull(msg1)
        assertNotNull(msg2)
        assertEquals("First message", msg1.content)
        assertEquals("Second message", msg2.content)
        assertFalse(msg1.isStreaming)
        assertFalse(msg2.isStreaming)
    }
}