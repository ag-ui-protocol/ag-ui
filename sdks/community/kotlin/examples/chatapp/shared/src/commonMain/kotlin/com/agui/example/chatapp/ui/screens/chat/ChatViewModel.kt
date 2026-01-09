package com.agui.example.chatapp.ui.screens.chat

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import com.contextable.a2ui4k.model.UiEvent
import com.agui.example.chatapp.chat.ChatController
import com.agui.example.chatapp.chat.ChatState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.StateFlow

/**
 * Compose-facing wrapper around [ChatController].
 */
class ChatViewModel(
    scopeFactory: () -> CoroutineScope = { MainScope() },
    controllerFactory: (CoroutineScope) -> ChatController = { scope -> ChatController(scope) }
) {

    private val scope = scopeFactory()
    private val controller = controllerFactory(scope)

    val state: StateFlow<ChatState> = controller.state

    fun sendMessage(content: String) = controller.sendMessage(content)

    fun sendA2UiAction(event: UiEvent) = controller.sendA2UiAction(event)

    fun cancelCurrentOperation() = controller.cancelCurrentOperation()

    fun clearError() = controller.clearError()

    fun dispose() {
        controller.close()
        scope.cancel()
    }
}

@Composable
fun rememberChatViewModel(): ChatViewModel {
    val viewModel = remember { ChatViewModel() }
    DisposableEffect(Unit) {
        onDispose { viewModel.dispose() }
    }
    return viewModel
}
