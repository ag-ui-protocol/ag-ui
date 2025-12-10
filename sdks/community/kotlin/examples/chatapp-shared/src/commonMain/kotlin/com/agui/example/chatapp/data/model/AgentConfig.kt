package com.agui.example.chatapp.data.model

import kotlinx.serialization.Serializable
import kotlinx.datetime.Clock
import kotlinx.datetime.Instant

/**
 * Represents a configured agent that the user can connect to.
 */
@Serializable
data class AgentConfig(
    val id: String,
    val name: String,
    val url: String,
    val description: String? = null,
    val authMethod: AuthMethod = AuthMethod.None(),
    val isActive: Boolean = false,
    val createdAt: Instant = Clock.System.now(),
    val lastUsedAt: Instant? = null,
    val customHeaders: Map<String, String> = emptyMap(),
    val systemPrompt: String? = null
) {
    companion object {
        fun generateId(): String {
            val timestamp = Clock.System.now().toEpochMilliseconds()
            val random = kotlin.random.Random.nextInt(1000, 9999)
            return "agent_${timestamp}_${random}"
        }
    }
}

/**
 * Represents the current chat session state.
 */
@Serializable
data class ChatSession(
    val agentId: String,
    val threadId: String,
    val startedAt: Instant = Clock.System.now()
)
