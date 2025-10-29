package com.agui.chatapp.java.repository

import android.content.Context
import androidx.lifecycle.LiveData
import androidx.lifecycle.MutableLiveData
import com.agui.example.chatapp.data.model.AgentConfig
import com.agui.example.chatapp.data.model.ChatSession
import com.agui.example.chatapp.data.repository.AgentRepository
import com.agui.example.chatapp.util.getPlatformSettings
import com.agui.example.chatapp.util.initializeAndroid
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import java.util.concurrent.CompletableFuture

/**
 * Android-friendly wrapper around the shared [AgentRepository].
 * Exposes LiveData and `CompletableFuture` APIs for the existing Java UI.
 */
class MultiAgentRepository private constructor(context: Context) {

    private val applicationContext = context.applicationContext
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val repository: AgentRepository

    private val _agentsLiveData = MutableLiveData<List<AgentConfig>>()
    private val _activeAgentLiveData = MutableLiveData<AgentConfig?>()
    private val _currentSessionLiveData = MutableLiveData<ChatSession?>()

    init {
        initializeAndroid(applicationContext)
        repository = AgentRepository.getInstance(getPlatformSettings())

        scope.launch {
            repository.agents.collectLatest { agents ->
                _agentsLiveData.postValue(agents)
            }
        }
        scope.launch {
            repository.activeAgent.collectLatest { active ->
                _activeAgentLiveData.postValue(active)
            }
        }
        scope.launch {
            repository.currentSession.collectLatest { session ->
                _currentSessionLiveData.postValue(session)
            }
        }
    }

    fun getAgents(): LiveData<List<AgentConfig>> = _agentsLiveData

    fun getActiveAgent(): LiveData<AgentConfig?> = _activeAgentLiveData

    fun getCurrentSession(): LiveData<ChatSession?> = _currentSessionLiveData

    fun addAgent(agent: AgentConfig): CompletableFuture<Void> = launchVoid {
        repository.addAgent(agent)
    }

    fun updateAgent(agent: AgentConfig): CompletableFuture<Void> = launchVoid {
        repository.updateAgent(agent)
    }

    fun deleteAgent(agentId: String): CompletableFuture<Void> = launchVoid {
        repository.deleteAgent(agentId)
    }

    fun setActiveAgent(agent: AgentConfig?): CompletableFuture<Void> = launchVoid {
        repository.setActiveAgent(agent)
    }

    fun getAgent(agentId: String): CompletableFuture<AgentConfig?> = launchFuture {
        repository.getAgent(agentId)
    }

    fun clear(): CompletableFuture<Void> = launchVoid {
        repository.setActiveAgent(null)
        AgentRepository.resetInstance()
    }

    private fun launchVoid(block: suspend () -> Unit): CompletableFuture<Void> {
        val future = CompletableFuture<Void>()
        scope.launch {
            runCatching { block() }
                .onSuccess { future.complete(null) }
                .onFailure { throwable -> future.completeExceptionally(throwable) }
        }
        return future
    }

    private fun <T> launchFuture(block: suspend () -> T): CompletableFuture<T> {
        val future = CompletableFuture<T>()
        scope.launch {
            runCatching { block() }
                .onSuccess { result -> future.complete(result) }
                .onFailure { throwable -> future.completeExceptionally(throwable) }
        }
        return future
    }

    companion object {
        @Volatile
        private var INSTANCE: MultiAgentRepository? = null

        @JvmStatic
        fun getInstance(context: Context): MultiAgentRepository {
            return INSTANCE ?: synchronized(this) {
                INSTANCE ?: MultiAgentRepository(context).also { INSTANCE = it }
            }
        }
    }
}
