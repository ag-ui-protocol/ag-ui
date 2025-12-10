package com.agui.example.chatapp.ui.screens.settings

import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.remember
import com.agui.example.chatapp.data.model.AgentConfig
import com.agui.example.chatapp.data.repository.AgentRepository
import com.agui.example.chatapp.util.getPlatformSettings
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

data class SettingsState(
    val agents: List<AgentConfig> = emptyList(),
    val activeAgent: AgentConfig? = null,
    val editingAgent: AgentConfig? = null
)

class SettingsViewModel(
    scopeFactory: () -> CoroutineScope = { MainScope() }
) {
    private val settings = getPlatformSettings()
    private val agentRepository = AgentRepository.getInstance(settings)
    private val scope = scopeFactory()

    private val _state = MutableStateFlow(SettingsState())
    val state: StateFlow<SettingsState> = _state.asStateFlow()

    init {
        scope.launch {
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
        scope.launch {
            agentRepository.addAgent(config)
        }
    }

    fun updateAgent(config: AgentConfig) {
        scope.launch {
            agentRepository.updateAgent(config)
            _state.update { it.copy(editingAgent = null) }
        }
    }

    fun deleteAgent(agentId: String) {
        scope.launch {
            agentRepository.deleteAgent(agentId)
        }
    }

    fun setActiveAgent(agent: AgentConfig) {
        scope.launch {
            agentRepository.setActiveAgent(agent)
        }
    }

    fun editAgent(agent: AgentConfig) {
        _state.update { it.copy(editingAgent = agent) }
    }

    fun cancelEdit() {
        _state.update { it.copy(editingAgent = null) }
    }

    fun dispose() {
        scope.cancel()
    }
}

@Composable
fun rememberSettingsViewModel(): SettingsViewModel {
    val viewModel = remember { SettingsViewModel() }
    DisposableEffect(Unit) {
        onDispose { viewModel.dispose() }
    }
    return viewModel
}
