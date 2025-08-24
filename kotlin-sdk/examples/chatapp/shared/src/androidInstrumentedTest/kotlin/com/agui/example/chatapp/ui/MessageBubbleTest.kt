/*
 * MIT License
 *
 * Copyright (c) 2025 Mark Fogle
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
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