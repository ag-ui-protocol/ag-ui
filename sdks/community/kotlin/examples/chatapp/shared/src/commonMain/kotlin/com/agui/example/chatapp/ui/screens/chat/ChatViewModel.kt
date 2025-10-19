package com.agui.example.chatapp.ui.screens.chat

import cafe.adriel.voyager.core.model.ScreenModel
import cafe.adriel.voyager.core.model.screenModelScope
import com.agui.example.chatapp.chat.ChatController
import com.agui.example.chatapp.chat.ChatState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.StateFlow

/**
 * Compose-facing wrapper that adapts [ChatController] to Voyager's [ScreenModel] API.
 */
class ChatViewModel(
    controllerFactory: (CoroutineScope) -> ChatController = { scope -> ChatController(scope) }
) : ScreenModel {

    private val controller = controllerFactory(screenModelScope)

    val state: StateFlow<ChatState> = controller.state

    fun sendMessage(content: String) = controller.sendMessage(content)

    fun cancelCurrentOperation() = controller.cancelCurrentOperation()

    fun clearError() = controller.clearError()

    override fun onDispose() {
        controller.close()
    }
}
