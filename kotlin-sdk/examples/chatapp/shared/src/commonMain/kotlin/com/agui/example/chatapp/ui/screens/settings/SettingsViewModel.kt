package com.agui.example.chatapp.ui.screens.settings

import cafe.adriel.voyager.core.model.ScreenModel
import cafe.adriel.voyager.core.model.screenModelScope
import com.agui.example.chatapp.data.model.AgentConfig
import com.agui.example.chatapp.data.repository.AgentRepository
import com.agui.example.chatapp.util.getPlatformSettings
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch

data class SettingsState(
    val agents: List<AgentConfig> = emptyList(),
    val activeAgent: AgentConfig? = null,
    val editingAgent: AgentConfig? = null
)

class SettingsViewModel : ScreenModel {
    private val settings = getPlatformSettings()
    private val agentRepository = AgentRepository.getInstance(settings)

    private val _state = MutableStateFlow(SettingsState())
    val state: StateFlow<SettingsState> = _state.asStateFlow()

    init {
        screenModelScope.launch {
            // Combine agent flows
            combine(
                agentRepository.agents,
                agentRepository.activeAgent
            ) { agents, activeAgent ->
                SettingsState(
                    agents = agents,
                    activeAgent = activeAgent
                )
            }.collect { newState ->
                _state.value = newState
            }
        }
    }

    fun addAgent(config: AgentConfig) {
        screenModelScope.launch {
            agentRepository.addAgent(config)
        }
    }

    fun updateAgent(config: AgentConfig) {
        screenModelScope.launch {
            agentRepository.updateAgent(config)
            _state.update { it.copy(editingAgent = null) }
        }
    }

    fun deleteAgent(agentId: String) {
        screenModelScope.launch {
            agentRepository.deleteAgent(agentId)
        }
    }

    fun setActiveAgent(agent: AgentConfig) {
        screenModelScope.launch {
            agentRepository.setActiveAgent(agent)
        }
    }

    fun editAgent(agent: AgentConfig) {
        _state.update { it.copy(editingAgent = agent) }
    }

    fun cancelEdit() {
        _state.update { it.copy(editingAgent = null) }
    }
}