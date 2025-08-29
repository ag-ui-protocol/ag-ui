package com.agui.example.chatapp.ui

import androidx.compose.ui.test.*
import com.agui.example.chatapp.ui.screens.chat.DisplayMessage
import com.agui.example.chatapp.ui.screens.chat.MessageRole
import com.agui.example.chatapp.ui.screens.chat.components.MessageBubble
import com.agui.example.chatapp.ui.theme.AgentChatTheme
import kotlin.test.Test

@OptIn(ExperimentalTestApi::class)
class MessageBubbleTest {

    @Test
    fun testUserMessageDisplay() = runComposeUiTest {
        val message = DisplayMessage(
            id = "1",
            role = MessageRole.USER,
            content = "Hello, AI!"
        )

        setContent {
            AgentChatTheme {
                MessageBubble(message = message)
            }
        }

        onNodeWithText("Hello, AI!").assertExists()
    }

    @Test
    fun testAssistantMessageDisplay() = runComposeUiTest {
        val message = DisplayMessage(
            id = "2",
            role = MessageRole.ASSISTANT,
            content = "Hello! How can I help you?"
        )

        setContent {
            AgentChatTheme {
                MessageBubble(message = message)
            }
        }

        onNodeWithText("Hello! How can I help you?").assertExists()
    }

    @Test
    fun testStreamingIndicator() = runComposeUiTest {
        val message = DisplayMessage(
            id = "3",
            role = MessageRole.ASSISTANT,
            content = "Thinking",
            isStreaming = true
        )

        setContent {
            AgentChatTheme {
                MessageBubble(message = message)
            }
        }

        onNodeWithText("Thinking").assertExists()
        // Note: Testing CircularProgressIndicator requires more complex UI testing
        // For now, we just verify the text content exists
    }
}