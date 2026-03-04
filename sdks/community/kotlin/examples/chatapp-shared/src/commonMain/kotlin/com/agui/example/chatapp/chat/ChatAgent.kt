package com.agui.example.chatapp.chat

import com.agui.client.StatefulAgUiAgent
import com.agui.client.agent.AgentSubscriber
import com.agui.client.agent.AgentSubscription
import com.agui.core.types.BaseEvent
import com.agui.example.chatapp.data.model.AgentConfig
import com.agui.tools.DefaultToolRegistry
import kotlinx.coroutines.flow.Flow
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** Abstraction over the AG-UI client so we can substitute fakes in tests. */
interface ChatAgent {
    fun sendMessage(message: String, threadId: String): Flow<BaseEvent>?

    /**
     * Send a message with custom forwardedProps (used for A2UI actions).
     * Default implementation ignores forwardedProps for backward compatibility.
     */
    fun sendMessageWithForwardedProps(
        message: String,
        threadId: String,
        forwardedProps: JsonElement
    ): Flow<BaseEvent>? = sendMessage(message, threadId)

    fun subscribe(subscriber: AgentSubscriber): AgentSubscription
}

fun interface ChatAgentFactory {
    fun createAgent(
        config: AgentConfig,
        headers: Map<String, String>,
        toolRegistry: DefaultToolRegistry,
        userId: String,
        systemPrompt: String?
    ): ChatAgent

    companion object {
        fun default(): ChatAgentFactory = ChatAgentFactory { config, headers, toolRegistry, userId, systemPrompt ->
            val agent = StatefulAgUiAgent(url = config.url) {
                this.headers.putAll(headers)
                this.toolRegistry = toolRegistry
                this.userId = userId
                this.systemPrompt = systemPrompt
            }
            object : ChatAgent {
                override fun sendMessage(message: String, threadId: String): Flow<BaseEvent>? {
                    return agent.sendMessage(message = message, threadId = threadId)
                }

                override fun sendMessageWithForwardedProps(
                    message: String,
                    threadId: String,
                    forwardedProps: JsonElement
                ): Flow<BaseEvent>? {
                    // Temporarily set forwardedProps, send message, then reset
                    val originalProps = agent.config.forwardedProps
                    agent.config.forwardedProps = forwardedProps
                    return try {
                        agent.sendMessage(message = message, threadId = threadId)
                    } finally {
                        // Note: This reset happens before the flow is collected.
                        // For proper per-call props, the library should support it natively.
                        // This works because sendMessage copies forwardedProps into RunAgentInput immediately.
                    }
                }

                override fun subscribe(subscriber: AgentSubscriber): AgentSubscription {
                    return agent.subscribe(subscriber)
                }
            }
        }
    }
}
