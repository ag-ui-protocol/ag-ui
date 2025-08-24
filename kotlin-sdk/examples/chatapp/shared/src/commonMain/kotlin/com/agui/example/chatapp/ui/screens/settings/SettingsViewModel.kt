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