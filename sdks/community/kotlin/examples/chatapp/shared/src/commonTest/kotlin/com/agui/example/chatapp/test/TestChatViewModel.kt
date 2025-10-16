package com.agui.example.chatapp.test

import cafe.adriel.voyager.core.model.ScreenModel
import com.agui.example.chatapp.ui.screens.chat.ChatState
import com.agui.example.chatapp.ui.screens.chat.DisplayMessage
import com.agui.example.chatapp.ui.screens.chat.MessageRole
import com.agui.example.chatapp.data.model.AgentConfig
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.datetime.Clock

/**
 * A testable version of ChatViewModel that doesn't depend on platform settings.
 */
class TestChatViewModel : ScreenModel {
    private val _state = MutableStateFlow(ChatState())
    val state: StateFlow<ChatState> = _state.asStateFlow()

    private val messages = mutableListOf<DisplayMessage>()

    fun setActiveAgent(agent: AgentConfig?) {
        _state.value = _state.value.copy(
            activeAgent = agent,
            isConnected = agent != null
        )
    }

    fun sendMessage(content: String) {
        if (content.isBlank()) return

        // Add user message
        val userMessage = DisplayMessage(
            id = generateMessageId(),
            role = MessageRole.USER,
            content = content.trim()
        )

        messages.add(userMessage)
        updateMessages()

        // Simulate agent response
        simulateAgentResponse()
    }

    private fun simulateAgentResponse() {
        _state.value = _state.value.copy(isLoading = true)

        // Add assistant message
        val assistantMessage = DisplayMessage(
            id = generateMessageId(),
            role = MessageRole.ASSISTANT,
            content = "This is a test response from the agent"
        )

        messages.add(assistantMessage)

        _state.value = _state.value.copy(isLoading = false)
        updateMessages()
    }

    private fun updateMessages() {
        _state.value = _state.value.copy(messages = messages.toList())
    }

    private fun generateMessageId(): String {
        return "msg_${Clock.System.now().toEpochMilliseconds()}"
    }

    fun clearMessages() {
        messages.clear()
        updateMessages()
    }

    fun setLoading(loading: Boolean) {
        _state.value = _state.value.copy(isLoading = loading)
    }

    fun setError(error: String?) {
        _state.value = _state.value.copy(error = error)
    }
}