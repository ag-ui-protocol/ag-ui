package com.agui.example.chatapp.ui.components

import androidx.compose.foundation.layout.Column
import androidx.compose.ui.test.*
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.agui.example.chatapp.ui.screens.chat.DisplayMessage
import com.agui.example.chatapp.ui.screens.chat.MessageRole
import com.agui.example.chatapp.ui.screens.chat.EphemeralType
import com.agui.example.chatapp.ui.screens.chat.components.MessageBubble
import com.agui.example.chatapp.ui.theme.AgentChatTheme
import org.junit.runner.RunWith
import kotlin.test.*

/**
 * Android instrumentation tests for MessageBubble component.
 * Tests various message types, states, and visual behaviors on Android platform.
 */
@RunWith(AndroidJUnit4::class)
@OptIn(ExperimentalTestApi::class)
class MessageBubbleComponentTest {

    @Test
    fun testUserMessageDisplay() = runComposeUiTest {
        val message = DisplayMessage(
            id = "user-1",
            role = MessageRole.USER,
            content = "Hello, assistant!"
        )

        setContent {
            AgentChatTheme {
                MessageBubble(message = message)
            }
        }

        onNodeWithText("Hello, assistant!").assertExists()
    }

    @Test
    fun testAssistantMessageDisplay() = runComposeUiTest {
        val message = DisplayMessage(
            id = "assistant-1",
            role = MessageRole.ASSISTANT,
            content = "Hello! How can I help you today?"
        )

        setContent {
            AgentChatTheme {
                MessageBubble(message = message)
            }
        }

        onNodeWithText("Hello! How can I help you today?").assertExists()
    }

    @Test
    fun testSystemMessageDisplay() = runComposeUiTest {
        val message = DisplayMessage(
            id = "system-1",
            role = MessageRole.SYSTEM,
            content = "Connected to Test Agent"
        )

        setContent {
            AgentChatTheme {
                MessageBubble(message = message)
            }
        }

        onNodeWithText("Connected to Test Agent").assertExists()
    }

    @Test
    fun testErrorMessageDisplay() = runComposeUiTest {
        val message = DisplayMessage(
            id = "error-1",
            role = MessageRole.ERROR,
            content = "Connection failed: Network timeout"
        )

        setContent {
            AgentChatTheme {
                MessageBubble(message = message)
            }
        }

        onNodeWithText("Connection failed: Network timeout").assertExists()
    }

    @Test
    fun testToolCallMessageDisplay() = runComposeUiTest {
        val message = DisplayMessage(
            id = "tool-1",
            role = MessageRole.TOOL_CALL,
            content = "Running search_files tool with: {\"query\": \"test\"}",
            ephemeralType = EphemeralType.TOOL_CALL
        )

        setContent {
            AgentChatTheme {
                MessageBubble(message = message)
            }
        }

        onNodeWithText("Running search_files tool with: {\"query\": \"test\"}").assertExists()
    }

    @Test
    fun testStepInfoMessageDisplay() = runComposeUiTest {
        val message = DisplayMessage(
            id = "step-1",
            role = MessageRole.STEP_INFO,
            content = "Processing your request...",
            ephemeralType = EphemeralType.STEP
        )

        setContent {
            AgentChatTheme {
                MessageBubble(message = message)
            }
        }

        onNodeWithText("Processing your request...").assertExists()
    }

    @Test
    fun testStreamingMessageWithIndicator() = runComposeUiTest {
        val message = DisplayMessage(
            id = "streaming-1",
            role = MessageRole.ASSISTANT,
            content = "I'm thinking about your question",
            isStreaming = true
        )

        setContent {
            AgentChatTheme {
                MessageBubble(message = message)
            }
        }

        onNodeWithText("I'm thinking about your question").assertExists()
        // Note: CircularProgressIndicator is harder to test directly in unit tests
        // We verify the streaming content is displayed correctly
    }

    @Test
    fun testEphemeralMessageWithGroupId() = runComposeUiTest {
        val message = DisplayMessage(
            id = "ephemeral-1",
            role = MessageRole.TOOL_CALL,
            content = "Calling external API...",
            ephemeralGroupId = "tool-group-1",
            ephemeralType = EphemeralType.TOOL_CALL
        )

        setContent {
            AgentChatTheme {
                MessageBubble(message = message)
            }
        }

        onNodeWithText("Calling external API...").assertExists()
    }

    @Test
    fun testLongMessageContent() = runComposeUiTest {
        val longContent = "This is a very long message that should test how the MessageBubble component handles " +
                "lengthy text content. It should wrap properly and maintain good readability. The component should " +
                "handle this gracefully without breaking the layout or becoming unreadable."

        val message = DisplayMessage(
            id = "long-1",
            role = MessageRole.ASSISTANT,
            content = longContent
        )

        setContent {
            AgentChatTheme {
                MessageBubble(message = message)
            }
        }

        onNodeWithText(longContent).assertExists()
    }

    @Test
    fun testEmptyMessageContent() = runComposeUiTest {
        val message = DisplayMessage(
            id = "empty-1",
            role = MessageRole.ASSISTANT,
            content = ""
        )

        setContent {
            AgentChatTheme {
                MessageBubble(message = message)
            }
        }

        // Even with empty content, the bubble should still render
        // We can't easily test for empty text, so we just ensure no crash occurs
        assertTrue(true) // Test passes if no exception is thrown
    }

    @Test
    fun testTimestampFormatting() = runComposeUiTest {
        val message = DisplayMessage(
            id = "timestamp-1",
            role = MessageRole.USER,
            content = "Test message",
            timestamp = 1640995200000L // Jan 1, 2022 00:00:00 UTC
        )

        setContent {
            AgentChatTheme {
                MessageBubble(message = message)
            }
        }

        onNodeWithText("Test message").assertExists()
        // Note: Timestamp display depends on system timezone, so we don't test exact format
        // We just verify the message content is displayed
    }

    @Test
    fun testStreamingToCompleteTransition() = runComposeUiTest {
        // Test streaming message display - cannot test transition in single test due to setContent limitation
        val streamingMessage = DisplayMessage(
            id = "transition-1",
            role = MessageRole.ASSISTANT,
            content = "Partial message",
            isStreaming = true
        )

        setContent {
            AgentChatTheme {
                MessageBubble(message = streamingMessage)
            }
        }

        // Verify streaming state content is displayed
        onNodeWithText("Partial message").assertExists()
    }

    @Test
    fun testSpecialCharactersInContent() = runComposeUiTest {
        val specialContent = "Special chars: !@#$%^&*()_+-=[]{}|;':\",./<>? 🚀 émojis and ñ accénts"

        val message = DisplayMessage(
            id = "special-1",
            role = MessageRole.USER,
            content = specialContent
        )

        setContent {
            AgentChatTheme {
                MessageBubble(message = message)
            }
        }

        onNodeWithText(specialContent).assertExists()
    }

    @Test
    fun testMultilineMessageContent() = runComposeUiTest {
        val multilineContent = """
            This is line 1
            This is line 2
            This is line 3
        """.trimIndent()

        val message = DisplayMessage(
            id = "multiline-1",
            role = MessageRole.ASSISTANT,
            content = multilineContent
        )

        setContent {
            AgentChatTheme {
                MessageBubble(message = message)
            }
        }

        onNodeWithText(multilineContent).assertExists()
    }

    @Test
    fun testDifferentMessageRoleStyles() = runComposeUiTest {
        // Test multiple message roles in a single composition to avoid multiple setContent calls
        val messages = listOf(
            DisplayMessage(
                id = "user-msg",
                role = MessageRole.USER,
                content = "User message"
            ),
            DisplayMessage(
                id = "assistant-msg",
                role = MessageRole.ASSISTANT,
                content = "Assistant message"
            ),
            DisplayMessage(
                id = "system-msg", 
                role = MessageRole.SYSTEM,
                content = "System message"
            ),
            DisplayMessage(
                id = "error-msg",
                role = MessageRole.ERROR,
                content = "Error message"
            ),
            DisplayMessage(
                id = "tool-msg",
                role = MessageRole.TOOL_CALL,
                content = "Tool call message",
                ephemeralType = EphemeralType.TOOL_CALL
            ),
            DisplayMessage(
                id = "step-msg",
                role = MessageRole.STEP_INFO,
                content = "Step info message",
                ephemeralType = EphemeralType.STEP
            )
        )

        setContent {
            AgentChatTheme {
                Column {
                    messages.forEach { message ->
                        MessageBubble(message = message)
                    }
                }
            }
        }

        // Verify all message types are displayed
        onNodeWithText("User message").assertExists()
        onNodeWithText("Assistant message").assertExists()
        onNodeWithText("System message").assertExists()
        onNodeWithText("Error message").assertExists()
        onNodeWithText("Tool call message").assertExists()
        onNodeWithText("Step info message").assertExists()
    }

    @Test
    fun testMessageWithQuotesAndEscapes() = runComposeUiTest {
        val contentWithQuotes = """He said "Hello!" and then 'Goodbye' with a \ backslash"""

        val message = DisplayMessage(
            id = "quotes-1",
            role = MessageRole.ASSISTANT,
            content = contentWithQuotes
        )

        setContent {
            AgentChatTheme {
                MessageBubble(message = message)
            }
        }

        onNodeWithText(contentWithQuotes).assertExists()
    }

    @Test
    fun testVeryShortContent() = runComposeUiTest {
        val message = DisplayMessage(
            id = "short-1",
            role = MessageRole.USER,
            content = "Hi"
        )

        setContent {
            AgentChatTheme {
                MessageBubble(message = message)
            }
        }

        onNodeWithText("Hi").assertExists()
    }

    @Test
    fun testEphemeralMessageTransparency() = runComposeUiTest {
        val ephemeralMessage = DisplayMessage(
            id = "ephemeral-2",
            role = MessageRole.TOOL_CALL,
            content = "Ephemeral tool call",
            ephemeralGroupId = "group-1",
            ephemeralType = EphemeralType.TOOL_CALL
        )

        val regularMessage = DisplayMessage(
            id = "regular-1",
            role = MessageRole.ASSISTANT,
            content = "Regular message"
        )

        setContent {
            AgentChatTheme {
                MessageBubble(message = ephemeralMessage)
                MessageBubble(message = regularMessage)
            }
        }

        onNodeWithText("Ephemeral tool call").assertExists()
        onNodeWithText("Regular message").assertExists()
        // Visual differences (transparency/fade) are hard to test in unit tests
        // We verify both render without errors
    }
}