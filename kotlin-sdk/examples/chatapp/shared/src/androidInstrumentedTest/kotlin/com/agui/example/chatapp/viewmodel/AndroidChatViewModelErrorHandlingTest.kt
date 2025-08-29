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
import com.agui.example.chatapp.ui.screens.chat.MessageRole
import kotlinx.coroutines.test.runTest
import org.junit.Before
import org.junit.After
import org.junit.Test
import org.junit.runner.RunWith
import kotlin.test.*

/**
 * Android integration tests for ChatViewModel error handling that require platform context.
 * These tests were moved from desktop tests because they need real Android platform initialization.
 */
@RunWith(AndroidJUnit4::class)
class AndroidChatViewModelErrorHandlingTest {

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
    fun testRunErrorEventHandling() = runTest {
        // Test basic run error event with Android platform context
        val errorEvent = RunErrorEvent(
            message = "Network connection timeout",
            code = "TIMEOUT_ERROR"
        )

        viewModel.handleAgentEvent(errorEvent)

        // Verify error message is displayed
        val state = viewModel.state.value
        val errorMessage = state.messages.find { 
            it.role == MessageRole.ERROR && it.content.contains("Network connection timeout")
        }
        
        assertNotNull(errorMessage, "Error message should be created")
        assertTrue(errorMessage.content.contains("Network connection timeout"), "Error message should contain the error message")
        // Note: ChatViewModel implementation only includes event.message, not event.code in the display
    }

    @Test
    fun testUnknownEventTypes() = runTest {
        // Test that edge case event types don't crash the system with Android context
        
        // Test with empty message IDs (valid non-empty content)
        viewModel.handleAgentEvent(TextMessageStartEvent(""))
        viewModel.handleAgentEvent(TextMessageContentEvent("", "Valid content"))
        viewModel.handleAgentEvent(TextMessageEndEvent(""))

        // Should handle gracefully without crashing
        val state = viewModel.state.value
        assertNotNull(state) // Verify state is still valid
    }

    @Test
    fun testNullAndEmptyContent() = runTest {
        // Test handling of minimal content in various events with Android context
        
        viewModel.handleAgentEvent(TextMessageStartEvent("test-msg"))
        viewModel.handleAgentEvent(TextMessageContentEvent("test-msg", " ")) // Single space is valid
        viewModel.handleAgentEvent(TextMessageEndEvent("test-msg"))

        viewModel.handleAgentEvent(ToolCallStartEvent("test-tool", ""))
        viewModel.handleAgentEvent(ToolCallArgsEvent("test-tool", " ")) // Single space for args
        viewModel.handleAgentEvent(ToolCallEndEvent("test-tool"))

        // Should handle all gracefully
        val state = viewModel.state.value
        assertNotNull(state)
    }

    @Test
    fun testAndroidSpecificErrorHandling() = runTest {
        // Test Android-specific error scenarios
        val androidErrorEvent = RunErrorEvent(
            message = "Android platform error",
            code = "ANDROID_ERROR"
        )

        viewModel.handleAgentEvent(androidErrorEvent)

        // Verify error is handled correctly on Android
        val state = viewModel.state.value
        val errorMessage = state.messages.find { 
            it.role == MessageRole.ERROR && it.content.contains("Android platform error")
        }
        
        assertNotNull(errorMessage)
    }

    @Test
    fun testErrorRecoveryOnAndroid() = runTest {
        // Test system recovery after errors on Android platform
        
        // Cause an error
        viewModel.handleAgentEvent(RunErrorEvent("Connection lost", "NETWORK_ERROR"))
        
        // System should continue working after error
        viewModel.handleAgentEvent(TextMessageStartEvent("recovery-msg"))
        viewModel.handleAgentEvent(TextMessageContentEvent("recovery-msg", "System recovered on Android"))
        viewModel.handleAgentEvent(TextMessageEndEvent("recovery-msg"))

        // Verify both error and recovery message exist
        val state = viewModel.state.value
        val errorMessage = state.messages.find { it.role == MessageRole.ERROR }
        val recoveryMessage = state.messages.find { it.id == "recovery-msg" }
        
        assertNotNull(errorMessage)
        assertNotNull(recoveryMessage)
        assertEquals("System recovered on Android", recoveryMessage.content)
    }

    @Test
    fun testStateConsistencyAfterErrorsOnAndroid() = runTest {
        // Test that state remains consistent after various errors on Android platform
        
        val initialMessageCount = viewModel.state.value.messages.size
        
        // Create various error conditions
        viewModel.handleAgentEvent(RunErrorEvent("Android Error 1", "E1"))
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
        viewModel.handleAgentEvent(TextMessageContentEvent("normal-msg", "Normal content on Android"))
        viewModel.handleAgentEvent(TextMessageEndEvent("normal-msg"))
        
        val finalState = viewModel.state.value
        val normalMessage = finalState.messages.find { it.id == "normal-msg" }
        assertNotNull(normalMessage)
        assertEquals("Normal content on Android", normalMessage.content)
    }

    @Test
    fun testConcurrentErrorHandlingOnAndroid() = runTest {
        // Test handling multiple errors concurrently on Android
        
        // Send multiple error events rapidly
        repeat(5) { i ->
            viewModel.handleAgentEvent(RunErrorEvent("Android concurrent error $i", "ERROR_$i"))
        }

        // All errors should be handled
        val state = viewModel.state.value
        val errorMessages = state.messages.filter { it.role == MessageRole.ERROR }
        assertEquals(5, errorMessages.size)
    }

    @Test
    fun testLongContentHandlingOnAndroid() = runTest {
        // Test handling of very long content on Android platform
        val longContent = "Android: " + "x".repeat(10000)
        
        viewModel.handleAgentEvent(TextMessageStartEvent("long-msg"))
        viewModel.handleAgentEvent(TextMessageContentEvent("long-msg", longContent))
        viewModel.handleAgentEvent(TextMessageEndEvent("long-msg"))

        // Verify content is handled properly on Android
        val state = viewModel.state.value
        val message = state.messages.find { it.id == "long-msg" }
        assertNotNull(message)
        assertEquals(longContent, message.content)
    }
}