package com.agui.example.chatapp.chat

import com.agui.client.StatefulAgUiAgent
import com.agui.client.agent.AgentSubscriber
import com.agui.client.agent.AgentSubscription
import com.agui.core.types.BaseEvent
import com.agui.example.chatapp.data.model.AgentConfig
import com.agui.tools.DefaultToolRegistry
import kotlinx.coroutines.flow.Flow

/** Abstraction over the AG-UI client so we can substitute fakes in tests. */
interface ChatAgent {
    fun sendMessage(message: String, threadId: String): Flow<BaseEvent>?

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

                override fun subscribe(subscriber: AgentSubscriber): AgentSubscription {
                    return agent.subscribe(subscriber)
                }
            }
        }
    }
}
