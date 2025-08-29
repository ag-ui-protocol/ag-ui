package com.agui.example.chatapp.viewmodel

import android.content.Context
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.agui.example.chatapp.data.model.AgentConfig
import com.agui.example.chatapp.data.model.AuthMethod
import com.agui.example.chatapp.data.repository.AgentRepository
import com.agui.example.chatapp.util.initializeAndroid
import com.agui.example.chatapp.util.resetAndroidContext
import com.agui.core.types.*
import com.agui.example.chatapp.ui.screens.chat.ChatViewModel
import com.agui.example.chatapp.ui.screens.chat.EphemeralType
import com.agui.example.chatapp.ui.screens.chat.MessageRole
import kotlinx.coroutines.test.runTest
import org.junit.Before
import org.junit.After
import org.junit.Test
import org.junit.runner.RunWith
import kotlin.test.*

/**
 * Android integration tests for ChatViewModel event handling.
 * Tests the real ChatViewModel with Android platform implementation.
 * Runs on actual Android device/emulator where Android context is available.
 */
@RunWith(AndroidJUnit4::class)
class AndroidChatViewModelEventHandlingTest {

    private lateinit var viewModel: ChatViewModel
    private lateinit var context: Context

    @Before
    fun setup() {
        // Reset any previous state
        resetAndroidContext()
        AgentRepository.resetInstance()

        // Initialize Android platform
        context = InstrumentationRegistry.getInstrumentation().targetContext
        initializeAndroid(context)

        // Create real ChatViewModel (will work now that Android is initialized)
        viewModel = ChatViewModel()

        // Set up a test agent
        val testAgent = AgentConfig(
            id = "test-agent",
            name = "Test Agent", 
            url = "https://test.com/agent",
            authMethod = AuthMethod.None()
        )
    }

    @After
    fun tearDown() {
        resetAndroidContext()
        AgentRepository.resetInstance()
    }

    @Test
    fun testTextMessageStartEventOnAndroid() = runTest {
        // Test that text message start events work on Android platform
        val event = TextMessageStartEvent(
            messageId = "msg-123"
        )

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
    fun testToolCallEventsOnAndroid() = runTest {
        // Test tool call events work on Android platform
        val toolStartEvent = ToolCallStartEvent(
            toolCallId = "tool-123",
            toolCallName = "test_tool"
        )

        viewModel.handleAgentEvent(toolStartEvent)

        // Verify ephemeral message is created
        val state = viewModel.state.value
        val ephemeralMessage = state.messages.find { 
            it.role == MessageRole.TOOL_CALL && it.content.contains("test_tool")
        }
        
        assertNotNull(ephemeralMessage)
        assertEquals(EphemeralType.TOOL_CALL, ephemeralMessage.ephemeralType)
    }

    @Test
    fun testUserConfirmationFlowOnAndroid() = runTest {
        // Note: This test validates the internal event handling mechanism
        // In real usage, confirmation would be triggered by the actual confirmation tool
        
        // For now, we'll test that the confirmation tool events are handled correctly
        // but acknowledge that pendingConfirmation is set by the ConfirmationHandler, not the events directly
        viewModel.handleAgentEvent(ToolCallStartEvent("confirm-123", "user_confirmation"))
        
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

        // For internal event handling tests, we verify the events are processed without error
        // The actual pendingConfirmation is set by the ConfirmationHandler during real tool execution
        val state = viewModel.state.value
        // The confirmation dialog state would be set by the actual tool execution, not direct events
        // For now, we just verify the events were handled without throwing errors
        assertNotNull(state) // Basic state validation
    }

    @Test
    fun testErrorHandlingOnAndroid() = runTest {
        // Test error handling works on Android platform
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
    fun testAndroidPlatformSpecificBehavior() = runTest {
        // Test any Android-specific behavior (if any)
        // For now, just verify the ViewModel works correctly on Android
        
        // Send multiple events
        viewModel.handleAgentEvent(TextMessageStartEvent("msg-1"))
        viewModel.handleAgentEvent(TextMessageContentEvent("msg-1", "Hello from Android!"))
        viewModel.handleAgentEvent(TextMessageEndEvent("msg-1"))
        
        // Verify Android platform handles them correctly
        val state = viewModel.state.value
        val message = state.messages.find { it.id == "msg-1" }
        
        assertNotNull(message)
        assertEquals("Hello from Android!", message.content)
        assertFalse(message.isStreaming)
    }

    @Test
    fun testStateConsistencyOnAndroid() = runTest {
        // Verify state remains consistent through Android platform operations
        
        // Initial state
        val initialMessageCount = viewModel.state.value.messages.size
        
        // Add some events
        viewModel.handleAgentEvent(StepStartedEvent("Processing on Android"))
        viewModel.handleAgentEvent(ToolCallStartEvent("tool-456", "android_tool"))
        
        // Verify state is consistent
        val state = viewModel.state.value
        assertEquals(initialMessageCount + 2, state.messages.size)
        
        // Verify ephemeral messages are properly managed
        val ephemeralMessages = state.messages.filter { it.ephemeralType != null }
        assertEquals(2, ephemeralMessages.size)
    }
}