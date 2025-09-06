package com.agui.client.builders

import com.agui.client.*
import com.agui.tools.ToolRegistry
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * Create a simple stateless agent with bearer token auth
 */
fun agentWithBearer(url: String, token: String): AgUiAgent {
    return AgUiAgent(url) {
        bearerToken = token
    }
}

/**
 * Create a simple stateless agent with API key auth
 */
fun agentWithApiKey(
    url: String,
    apiKey: String,
    headerName: String = "X-API-Key"
): AgUiAgent {
    return AgUiAgent(url) {
        this.apiKey = apiKey
        this.apiKeyHeader = headerName
    }
}

/**
 * Create a stateless agent with tools
 */
fun agentWithTools(
    url: String,
    toolRegistry: ToolRegistry,
    configure: AgUiAgentConfig.() -> Unit = {}
): AgUiAgent {
    return AgUiAgent(url) {
        this.toolRegistry = toolRegistry
        configure()
    }
}

/**
 * Create a stateful chat agent
 */
fun chatAgent(
    url: String,
    systemPrompt: String,
    configure: StatefulAgUiAgentConfig.() -> Unit = {}
): StatefulAgUiAgent {
    return StatefulAgUiAgent(url) {
        this.systemPrompt = systemPrompt
        configure()
    }
}

/**
 * Create a stateful agent with initial state
 */
fun statefulAgent(
    url: String,
    initialState: JsonElement,
    configure: StatefulAgUiAgentConfig.() -> Unit = {}
): StatefulAgUiAgent {
    return StatefulAgUiAgent(url) {
        this.initialState = initialState
        configure()
    }
}

/**
 * Create a debug agent that logs all events
 */
fun debugAgent(
    url: String,
    configure: AgUiAgentConfig.() -> Unit = {}
): AgUiAgent {
    return AgUiAgent(url) {
        debug = true
        configure()
    }
}