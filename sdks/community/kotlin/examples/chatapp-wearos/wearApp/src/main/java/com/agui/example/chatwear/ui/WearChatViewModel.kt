package com.agui.example.chatwear.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.agui.example.chatwear.BuildConfig
import com.agui.example.chatapp.chat.ChatController
import com.agui.example.chatapp.chat.ChatState
import com.agui.example.chatapp.data.model.AgentConfig
import com.agui.example.chatapp.data.model.AuthMethod
import com.agui.example.chatapp.data.repository.AgentRepository
import com.agui.example.chatapp.util.getPlatformSettings
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/**
 * Wear-specific wrapper around [ChatController] that exposes additional agent metadata.
 */
class WearChatViewModel(
    controllerFactory: (CoroutineScope) -> ChatController = { scope -> ChatController(scope) },
    repositoryProvider: () -> AgentRepository = { AgentRepository.getInstance(getPlatformSettings()) }
) : ViewModel() {

    private val controller = controllerFactory(viewModelScope)
    private val repository = repositoryProvider()

    val chatState: StateFlow<ChatState> = controller.state
    val agents: StateFlow<List<AgentConfig>> = repository.agents
    val activeAgent: StateFlow<AgentConfig?> = repository.activeAgent

    val quickPrompts: List<String> = BuildConfig.DEFAULT_QUICK_PROMPTS
        .split("|")
        .map { it.trim() }
        .filter { it.isNotEmpty() }

    init {
        viewModelScope.launch {
            ensureDefaultAgent()
        }
    }

    private suspend fun ensureDefaultAgent() {
        val existingAgents = repository.agents.first()
        val existingActive = repository.activeAgent.first()

        if (existingAgents.isEmpty()) {
            val url = BuildConfig.DEFAULT_AGENT_URL
            if (url.isNotBlank()) {
                val agent = AgentConfig(
                    id = AgentConfig.generateId(),
                    name = BuildConfig.DEFAULT_AGENT_NAME.ifBlank { "Wear Sample Agent" },
                    url = url,
                    description = BuildConfig.DEFAULT_AGENT_DESCRIPTION.ifBlank { "Configured via Gradle properties" },
                    authMethod = BuildConfig.DEFAULT_AGENT_API_KEY
                        .takeIf { it.isNotBlank() }
                        ?.let { apiKey ->
                            AuthMethod.ApiKey(
                                key = apiKey,
                                headerName = BuildConfig.DEFAULT_AGENT_API_KEY_HEADER.ifBlank { "X-API-Key" }
                            )
                        }
                        ?: AuthMethod.None()
                )
                repository.addAgent(agent)
                repository.setActiveAgent(agent)
                return
            }
        }

        if (existingActive == null) {
            existingAgents.firstOrNull()?.let { repository.setActiveAgent(it) }
        }
    }

    fun selectAgent(agent: AgentConfig) {
        viewModelScope.launch {
            repository.setActiveAgent(agent)
        }
    }

    fun sendMessage(content: String) {
        controller.sendMessage(content)
    }

    fun cancelCurrentOperation() {
        controller.cancelCurrentOperation()
    }

    fun clearError() {
        controller.clearError()
    }

    fun createAgent(
        name: String,
        url: String,
        description: String,
        apiKey: String,
        apiKeyHeader: String
    ) {
        if (name.isBlank() || url.isBlank()) return

        viewModelScope.launch {
            val auth = apiKey.takeIf { it.isNotBlank() }?.let {
                AuthMethod.ApiKey(
                    key = apiKey,
                    headerName = apiKeyHeader.ifBlank { "X-API-Key" }
                )
            } ?: AuthMethod.None()

            val agent = AgentConfig(
                id = AgentConfig.generateId(),
                name = name.trim(),
                url = url.trim(),
                description = description.takeIf { it.isNotBlank() }?.trim(),
                authMethod = auth
            )

            repository.addAgent(agent)
            repository.setActiveAgent(agent)
        }
    }

    fun updateAgent(
        agent: AgentConfig,
        name: String,
        url: String,
        description: String,
        apiKey: String,
        apiKeyHeader: String
    ) {
        if (name.isBlank() || url.isBlank()) return

        viewModelScope.launch {
            val auth = apiKey.takeIf { it.isNotBlank() }?.let {
                AuthMethod.ApiKey(
                    key = apiKey,
                    headerName = apiKeyHeader.ifBlank { "X-API-Key" }
                )
            } ?: AuthMethod.None()

            val updated = agent.copy(
                name = name.trim(),
                url = url.trim(),
                description = description.takeIf { it.isNotBlank() }?.trim(),
                authMethod = auth
            )
            repository.updateAgent(updated)
        }
    }

    fun deleteAgent(agent: AgentConfig) {
        viewModelScope.launch {
            repository.deleteAgent(agent.id)
        }
    }

    override fun onCleared() {
        controller.close()
    }
}
