package com.agui.example.chatapp.bridge

import com.agui.example.chatapp.chat.ChatController
import com.agui.example.chatapp.chat.ChatState
import com.agui.example.chatapp.chat.DisplayMessage
import com.agui.example.chatapp.chat.EphemeralType
import com.agui.example.chatapp.chat.MessageRole
import com.agui.example.chatapp.data.model.AgentConfig
import com.agui.example.chatapp.data.model.AuthMethod
import com.agui.example.chatapp.data.repository.AgentRepository
import com.agui.example.chatapp.util.getPlatformSettings
import com.agui.example.tools.BackgroundStyle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
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
    val authMethod: AuthMethodSnapshot,
    val isActive: Boolean,
    val createdAtMillis: Long,
    val lastUsedAtMillis: Long?,
    val customHeaders: List<HeaderEntry>,
    val systemPrompt: String?
)

// Internal enum keeps conversions between Kotlin models and the string identifiers exposed to Swift.
private enum class AuthMethodKind(val identifier: String) {
    NONE("none"),
    API_KEY("apiKey"),
    BEARER_TOKEN("bearerToken"),
    BASIC_AUTH("basicAuth"),
    OAUTH2("oauth2"),
    CUSTOM("custom");

    companion object {
        fun fromIdentifier(identifier: String?): AuthMethodKind =
            values().firstOrNull { it.identifier.equals(identifier, ignoreCase = true) } ?: NONE
    }
}

data class AuthMethodSnapshot(
    val kind: String,
    val key: String? = null,
    val headerName: String? = null,
    val token: String? = null,
    val username: String? = null,
    val password: String? = null,
    val clientId: String? = null,
    val clientSecret: String? = null,
    val authorizationUrl: String? = null,
    val tokenUrl: String? = null,
    val scopes: List<String> = emptyList(),
    val accessToken: String? = null,
    val refreshToken: String? = null,
    val customType: String? = null,
    val customConfiguration: List<HeaderEntry> = emptyList()
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

/** Snapshot of the current chat background styling. */
data class BackgroundSnapshot(
    val colorHex: String?,
    val description: String?
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
    val background: BackgroundSnapshot
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
    authMethod = authMethod.toSnapshot(),
    isActive = isActive,
    createdAtMillis = createdAt.toEpochMilliseconds(),
    lastUsedAtMillis = lastUsedAt?.toEpochMilliseconds(),
    customHeaders = customHeaders.map { HeaderEntry(it.key, it.value) },
    systemPrompt = systemPrompt
)

private fun DisplayMessage.toSnapshot(stableId: String = id): DisplayMessageSnapshot = DisplayMessageSnapshot(
    id = stableId,
    role = role,
    content = content,
    timestamp = timestamp,
    isStreaming = isStreaming,
    ephemeralGroupId = ephemeralGroupId,
    ephemeralType = ephemeralType
)

private fun BackgroundStyle.toSnapshot(): BackgroundSnapshot =
    BackgroundSnapshot(
        colorHex = colorHex,
        description = description
    )

private fun ChatState.toSnapshot(): ChatStateSnapshot = ChatStateSnapshot(
    activeAgent = activeAgent?.toSnapshot(),
    messages = messages.map { message ->
        val stableId = buildString {
            append(message.id)
            append(":")
            append(message.timestamp)
        }
        message.toSnapshot(stableId)
    },
    ephemeralMessage = ephemeralMessage?.let { message ->
        val stableId = buildString {
            append(message.id)
            append(":")
            append(message.timestamp)
        }
        message.toSnapshot(stableId)
    },
    isLoading = isLoading,
    isConnected = isConnected,
    error = error,
    background = background.toSnapshot()
)

private fun AuthMethod.toSnapshot(): AuthMethodSnapshot = when (this) {
    is AuthMethod.None -> AuthMethodSnapshot(kind = AuthMethodKind.NONE.identifier)
    is AuthMethod.ApiKey -> AuthMethodSnapshot(
        kind = AuthMethodKind.API_KEY.identifier,
        key = key,
        headerName = headerName
    )
    is AuthMethod.BearerToken -> AuthMethodSnapshot(
        kind = AuthMethodKind.BEARER_TOKEN.identifier,
        token = token
    )
    is AuthMethod.BasicAuth -> AuthMethodSnapshot(
        kind = AuthMethodKind.BASIC_AUTH.identifier,
        username = username,
        password = password
    )
    is AuthMethod.OAuth2 -> AuthMethodSnapshot(
        kind = AuthMethodKind.OAUTH2.identifier,
        clientId = clientId,
        clientSecret = clientSecret,
        authorizationUrl = authorizationUrl,
        tokenUrl = tokenUrl,
        scopes = scopes,
        accessToken = accessToken,
        refreshToken = refreshToken
    )
    is AuthMethod.Custom -> AuthMethodSnapshot(
        kind = AuthMethodKind.CUSTOM.identifier,
        customType = type,
        customConfiguration = config.map { HeaderEntry(it.key, it.value) }
    )
}

private fun AuthMethodSnapshot.toAuthMethod(): AuthMethod = when (AuthMethodKind.fromIdentifier(kind)) {
    AuthMethodKind.NONE -> AuthMethod.None()
    AuthMethodKind.API_KEY -> AuthMethod.ApiKey(
        key = key ?: "",
        headerName = headerName ?: "X-API-Key"
    )
    AuthMethodKind.BEARER_TOKEN -> AuthMethod.BearerToken(token = token ?: "")
    AuthMethodKind.BASIC_AUTH -> AuthMethod.BasicAuth(
        username = username ?: "",
        password = password ?: ""
    )
    AuthMethodKind.OAUTH2 -> AuthMethod.OAuth2(
        clientId = clientId ?: "",
        clientSecret = clientSecret,
        authorizationUrl = authorizationUrl ?: "",
        tokenUrl = tokenUrl ?: "",
        scopes = scopes,
        accessToken = accessToken,
        refreshToken = refreshToken
    )
    AuthMethodKind.CUSTOM -> AuthMethod.Custom(
        type = customType ?: "",
        config = ChatBridgeFactory.mapFromEntries(customConfiguration)
    )
}

class ChatViewModelBridge(private val controller: ChatController) {
    private val scope = MainScope()

    constructor() : this(ChatController())

    fun observeState(onEach: (ChatStateSnapshot) -> Unit): FlowSubscription {
        val job = scope.launch {
            controller.state.collectLatest { state ->
                withContext(Dispatchers.Main) {
                    onEach(state.toSnapshot())
                }
            }
        }
        return FlowSubscription(job)
    }

    fun currentState(): ChatStateSnapshot = controller.state.value.toSnapshot()

    fun sendMessage(content: String) {
        controller.sendMessage(content)
    }

    fun cancelCurrentOperation() {
        controller.cancelCurrentOperation()
    }

    fun clearError() {
        controller.clearError()
    }

    fun close() {
        scope.cancel()
        controller.close()
    }
}

class AgentRepositoryBridge(
    private val repository: AgentRepository
) {
    private val scope = MainScope()

    constructor() : this(AgentRepository.getInstance(getPlatformSettings()))

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
            }.onSuccess {
                withContext(Dispatchers.Main) { completion(null) }
            }.onFailure { error ->
                withContext(Dispatchers.Main) { completion(error) }
            }
        }
    }

    fun close() {
        scope.cancel()
    }
}


object ChatBridgeFactory {
    @Suppress("unused")
    val shared: ChatBridgeFactory get() = this

    fun createAgentConfig(
        name: String,
        url: String,
        description: String?,
        authMethod: AuthMethodSnapshot,
        headers: List<HeaderEntry>,
        systemPrompt: String?
    ): AgentConfig = AgentConfig(
        id = AgentConfig.generateId(),
        name = name,
        url = url,
        description = description,
        authMethod = authMethod.toAuthMethod(),
        customHeaders = headers.associate { it.key to it.value },
        systemPrompt = systemPrompt
    )

    fun updateAgentConfig(
        existing: AgentSnapshot,
        name: String,
        url: String,
        description: String?,
        authMethod: AuthMethodSnapshot,
        headers: List<HeaderEntry>,
        systemPrompt: String?
    ): AgentConfig = AgentConfig(
        id = existing.id,
        name = name,
        url = url,
        description = description,
        authMethod = authMethod.toAuthMethod(),
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
    ): AuthMethodSnapshot = AuthMethodSnapshot(
        kind = AuthMethodKind.OAUTH2.identifier,
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
    ): AuthMethodSnapshot = AuthMethodSnapshot(
        kind = AuthMethodKind.CUSTOM.identifier,
        customType = type,
        customConfiguration = entries
    )
}
