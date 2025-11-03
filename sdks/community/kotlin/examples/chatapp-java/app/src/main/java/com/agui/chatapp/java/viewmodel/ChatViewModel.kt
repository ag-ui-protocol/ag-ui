package com.agui.chatapp.java.viewmodel

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.LiveData
import androidx.lifecycle.MutableLiveData
import androidx.lifecycle.viewModelScope
import com.agui.chatapp.java.model.ChatMessage
import com.agui.chatapp.java.repository.MultiAgentRepository
import com.agui.example.chatapp.chat.ChatController
import com.agui.example.chatapp.data.model.AgentConfig
import com.agui.example.tools.BackgroundStyle
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

class ChatViewModel(application: Application) : AndroidViewModel(application) {

    private val repository = MultiAgentRepository.getInstance(application)
    private val controller = ChatController(viewModelScope)

    private val _messages = MutableLiveData<List<ChatMessage>>(emptyList())
    private val _isConnecting = MutableLiveData(false)
    private val _errorMessage = MutableLiveData<String?>()
    private val _hasAgentConfig = MutableLiveData(false)
    private val _backgroundStyle = MutableLiveData(BackgroundStyle.Default)

    private val activeAgentLiveData: LiveData<AgentConfig?> = repository.getActiveAgent()

    fun getMessages(): LiveData<List<ChatMessage>> = _messages

    fun getIsConnecting(): LiveData<Boolean> = _isConnecting

    fun getErrorMessage(): LiveData<String?> = _errorMessage

    fun getHasAgentConfig(): LiveData<Boolean> = _hasAgentConfig

    fun getBackgroundStyle(): LiveData<BackgroundStyle> = _backgroundStyle

    fun getActiveAgent(): LiveData<AgentConfig?> = activeAgentLiveData

    init {
        viewModelScope.launch {
            controller.state.collectLatest { state ->
                _messages.postValue(state.messages.map(::ChatMessage))
                _isConnecting.postValue(state.isLoading)
                _errorMessage.postValue(state.error)
                _hasAgentConfig.postValue(state.activeAgent != null)
                _backgroundStyle.postValue(state.background)
            }
        }
    }

    fun setActiveAgent(agent: AgentConfig?) {
        val current = activeAgentLiveData.value
        val currentId = current?.id
        val targetId = agent?.id
        if (currentId == targetId) return

        repository.setActiveAgent(agent)
            .whenComplete { _, throwable ->
                if (throwable != null) {
                    _errorMessage.postValue("Failed to activate agent: ${throwable.message}")
                }
            }
    }

    fun sendMessage(message: String) {
        controller.sendMessage(message)
    }

    fun cancelOperations() {
        controller.cancelCurrentOperation()
    }

    fun clearError() {
        controller.clearError()
    }

    fun clearHistory() {
        _messages.value = emptyList()
        controller.cancelCurrentOperation()
    }

    override fun onCleared() {
        super.onCleared()
        controller.close()
    }
}
