package com.agui.example.chatapp.bridge

import com.agui.example.chatapp.data.model.AgentConfig
import com.agui.example.chatapp.data.model.AuthMethod
import com.agui.example.chatapp.data.repository.AgentRepository
import com.agui.example.chatapp.ui.screens.chat.ChatState
import com.agui.example.chatapp.ui.screens.chat.ChatViewModel
import com.agui.example.chatapp.ui.screens.chat.DisplayMessage
import com.agui.example.chatapp.ui.screens.chat.EphemeralType
import com.agui.example.chatapp.ui.screens.chat.MessageRole
import com.agui.example.chatapp.ui.screens.chat.UserConfirmationRequest
import com.agui.example.chatapp.util.getPlatformSettings
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.datetime.Instant

/**
 * Simple key/value tuple used for bridging dictionaries into Swift.
 */
data class HeaderEntry(
    val key: String,
    val value: String
)

/**
 * Snapshot of an [AgentConfig] that is friendlier to consume from Swift.
 */
data class AgentSnapshot(
    val id: String,
    val name: String,
    val url: String,
    val description: String?,
    val authMethod: AuthMethod,
    val isActive: Boolean,
    val createdAtMillis: Long,
    val lastUsedAtMillis: Long?,
    val customHeaders: List<HeaderEntry>,
    val systemPrompt: String?
)

/**
 * Snapshot of a [DisplayMessage] that can be rendered directly in SwiftUI.
 */
data class DisplayMessageSnapshot(
    val id: String,
    val role: MessageRole,
    val content: String,
    val timestamp: Long,
    val isStreaming: Boolean,
    val ephemeralGroupId: String?,
    val ephemeralType: EphemeralType?
)

/**
 * Snapshot for user confirmation requests coming from tool calls.
 */
data class UserConfirmationSnapshot(
    val toolCallId: String,
    val action: String,
    val impact: String,
    val details: List<HeaderEntry>,
    val timeout: Int
)

/**
 * Complete snapshot of [ChatState] designed for Swift consumption.
 */
data class ChatStateSnapshot(
    val activeAgent: AgentSnapshot?,
    val messages: List<DisplayMessageSnapshot>,
    val ephemeralMessage: DisplayMessageSnapshot?,
    val isLoading: Boolean,
    val isConnected: Boolean,
    val error: String?,
    val pendingConfirmation: UserConfirmationSnapshot?
)

/**
 * Handle returned to Swift for cancelling coroutine backed observers.
 */
class FlowSubscription internal constructor(private val job: Job) {
    fun cancel() {
        job.cancel()
    }
}

private fun AgentConfig.toSnapshot(): AgentSnapshot = AgentSnapshot(
    id = id,
    name = name,
    url = url,
    description = description,
    authMethod = authMethod,
    isActive = isActive,
    createdAtMillis = createdAt.toEpochMilliseconds(),
    lastUsedAtMillis = lastUsedAt?.toEpochMilliseconds(),
    customHeaders = customHeaders.map { HeaderEntry(it.key, it.value) },
    systemPrompt = systemPrompt
)

private fun DisplayMessage.toSnapshot(): DisplayMessageSnapshot = DisplayMessageSnapshot(
    id = id,
    role = role,
    content = content,
    timestamp = timestamp,
    isStreaming = isStreaming,
    ephemeralGroupId = ephemeralGroupId,
    ephemeralType = ephemeralType
)

private fun UserConfirmationRequest.toSnapshot(): UserConfirmationSnapshot =
    UserConfirmationSnapshot(
        toolCallId = toolCallId,
        action = action,
        impact = impact,
        details = details.map { HeaderEntry(it.key, it.value) },
        timeout = timeout
    )

private fun ChatState.toSnapshot(): ChatStateSnapshot = ChatStateSnapshot(
    activeAgent = activeAgent?.toSnapshot(),
    messages = messages.map { it.toSnapshot() },
    ephemeralMessage = ephemeralMessage?.toSnapshot(),
    isLoading = isLoading,
    isConnected = isConnected,
    error = error,
    pendingConfirmation = pendingConfirmation?.toSnapshot()
)

class ChatViewModelBridge(private val viewModel: ChatViewModel = ChatViewModel()) {
    private val scope = MainScope()

    fun observeState(onEach: (ChatStateSnapshot) -> Unit): FlowSubscription {
        val job = scope.launch {
            viewModel.state.collectLatest { state ->
                withContext(Dispatchers.Main) {
                    onEach(state.toSnapshot())
                }
            }
        }
        return FlowSubscription(job)
    }

    fun currentState(): ChatStateSnapshot = viewModel.state.value.toSnapshot()

    fun sendMessage(content: String) {
        viewModel.sendMessage(content)
    }

    fun confirmAction() {
        viewModel.confirmAction()
    }

    fun rejectAction() {
        viewModel.rejectAction()
    }

    fun cancelCurrentOperation() {
        viewModel.cancelCurrentOperation()
    }

    fun clearError() {
        viewModel.clearError()
    }

    fun close() {
        scope.cancel()
    }
}

class AgentRepositoryBridge(
    private val repository: AgentRepository = AgentRepository.getInstance(getPlatformSettings())
) {
    private val scope = MainScope()

    fun observeAgents(onEach: (List<AgentSnapshot>) -> Unit): FlowSubscription {
        val job = scope.launch {
            repository.agents.collectLatest { agents ->
                withContext(Dispatchers.Main) {
                    onEach(agents.map { it.toSnapshot() })
                }
            }
        }
        return FlowSubscription(job)
    }

    fun observeActiveAgent(onEach: (AgentSnapshot?) -> Unit): FlowSubscription {
        val job = scope.launch {
            repository.activeAgent.collectLatest { agent ->
                withContext(Dispatchers.Main) {
                    onEach(agent?.toSnapshot())
                }
            }
        }
        return FlowSubscription(job)
    }

    fun currentAgents(): List<AgentSnapshot> = repository.agents.value.map { it.toSnapshot() }

    fun currentActiveAgent(): AgentSnapshot? = repository.activeAgent.value?.toSnapshot()

    fun addAgent(agent: AgentConfig, completion: (Throwable?) -> Unit) {
        scope.launch {
            runCatching { repository.addAgent(agent) }
                .onSuccess { withContext(Dispatchers.Main) { completion(null) } }
                .onFailure { error -> withContext(Dispatchers.Main) { completion(error) } }
        }
    }

    fun updateAgent(agent: AgentConfig, completion: (Throwable?) -> Unit) {
        scope.launch {
            runCatching { repository.updateAgent(agent) }
                .onSuccess { withContext(Dispatchers.Main) { completion(null) } }
                .onFailure { error -> withContext(Dispatchers.Main) { completion(error) } }
        }
    }

    fun deleteAgent(agentId: String, completion: (Throwable?) -> Unit) {
        scope.launch {
            runCatching { repository.deleteAgent(agentId) }
                .onSuccess { withContext(Dispatchers.Main) { completion(null) } }
                .onFailure { error -> withContext(Dispatchers.Main) { completion(error) } }
        }
    }

    fun setActiveAgent(agentId: String?, completion: (Throwable?) -> Unit) {
        scope.launch {
            runCatching {
                val target = agentId?.let { repository.getAgent(it) }
                repository.setActiveAgent(target)
            }
                .onSuccess { withContext(Dispatchers.Main) { completion(null) } }
                .onFailure { error -> withContext(Dispatchers.Main) { completion(error) } }
        }
    }

    fun close() {
        scope.cancel()
    }
}

fun createAgentConfig(
    name: String,
    url: String,
    description: String?,
    authMethod: AuthMethod,
    headers: List<HeaderEntry>,
    systemPrompt: String?
): AgentConfig = AgentConfig(
    id = AgentConfig.generateId(),
    name = name,
    url = url,
    description = description,
    authMethod = authMethod,
    customHeaders = headers.associate { it.key to it.value },
    systemPrompt = systemPrompt
)

fun updateAgentConfig(
    existing: AgentSnapshot,
    name: String,
    url: String,
    description: String?,
    authMethod: AuthMethod,
    headers: List<HeaderEntry>,
    systemPrompt: String?
): AgentConfig = AgentConfig(
    id = existing.id,
    name = name,
    url = url,
    description = description,
    authMethod = authMethod,
    isActive = existing.isActive,
    createdAt = Instant.fromEpochMilliseconds(existing.createdAtMillis),
    lastUsedAt = existing.lastUsedAtMillis?.let { Instant.fromEpochMilliseconds(it) },
    customHeaders = headers.associate { it.key to it.value },
    systemPrompt = systemPrompt
)

fun headersFromMap(map: Map<String, String>): List<HeaderEntry> =
    map.map { HeaderEntry(it.key, it.value) }

fun mapFromEntries(entries: List<HeaderEntry>): Map<String, String> =
    entries.associate { it.key to it.value }

fun createOAuth2Auth(
    clientId: String,
    clientSecret: String?,
    authorizationUrl: String,
    tokenUrl: String,
    scopes: List<String>,
    accessToken: String?,
    refreshToken: String?
): AuthMethod = AuthMethod.OAuth2(
    clientId = clientId,
    clientSecret = clientSecret,
    authorizationUrl = authorizationUrl,
    tokenUrl = tokenUrl,
    scopes = scopes,
    accessToken = accessToken,
    refreshToken = refreshToken
)

fun createCustomAuth(
    type: String,
    entries: List<HeaderEntry>
): AuthMethod = AuthMethod.Custom(
    type = type,
    config = mapFromEntries(entries)
)
