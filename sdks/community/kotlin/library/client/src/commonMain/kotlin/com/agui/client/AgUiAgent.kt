package com.agui.client

import com.agui.client.agent.*
import com.agui.core.types.*
import com.agui.tools.*
import com.agui.client.tools.ClientToolResponseHandler
import kotlinx.coroutines.flow.*
import kotlinx.datetime.Clock
import kotlinx.serialization.json.*
import co.touchlab.kermit.Logger

private val logger = Logger.withTag("AgUiAgent")

/**
 * Stateless AG-UI agent that processes each request independently.
 * Does not maintain conversation history or state between calls.
 */
open class AgUiAgent(
    protected val url: String,
    configure: AgUiAgentConfig.() -> Unit = {}
) {
    protected val config = AgUiAgentConfig().apply(configure)

    // Create HttpAgent which extends AbstractAgent
    protected val agent = HttpAgent(
        config = HttpAgentConfig(
            agentId = null,
            description = "",
            threadId = null,
            initialMessages = emptyList(),
            initialState = JsonObject(emptyMap()),
            debug = config.debug,
            url = url,
            headers = config.buildHeaders(),
            requestTimeout = config.requestTimeout,
            connectTimeout = config.connectTimeout
        ),
        httpClient = null
    )

    protected val toolExecutionManager = config.toolRegistry?.let {
        ToolExecutionManager(it, ClientToolResponseHandler(agent))
    }

    // Track threads that have already received tools (for stateless agent optimization)
    private val threadsWithToolsInfo = mutableSetOf<String>()

    /**
     * Run agent with explicit input and return observable event stream
     */
    /**
     * Run agent with explicit input and return observable event stream
     *
     * @param input The run agent input containing messages, tools, state, and other configuration
     * @return Flow of events from the agent, potentially processed through tool execution
     */
    open fun run(input: RunAgentInput): Flow<BaseEvent> {
        // Get the raw event stream from the agent
        val eventStream = agent.runAgentObservable(input)
        
        // If we have a tool execution manager, process events through it
        return if (toolExecutionManager != null) {
            toolExecutionManager.processEventStream(
                events = eventStream,
                threadId = input.threadId,
                runId = input.runId
            )
        } else {
            // No tools configured, just pass through the events
            eventStream
        }
    }

    /**
     * Simple message interface - creates fresh input each time
     */
    /**
     * Simple message interface - creates fresh input each time
     *
     * @param message The user message to send to the agent
     * @param threadId The thread ID for this conversation (defaults to generated ID)
     * @param state The initial state for the agent (defaults to empty object)
     * @param includeSystemPrompt Whether to include the configured system prompt
     * @return Flow of events from the agent
     */
    open fun sendMessage(
        message: String,
        threadId: String = generateThreadId(),
        state: JsonElement? = null,
        includeSystemPrompt: Boolean = true
    ): Flow<BaseEvent> {
        val messages = mutableListOf<Message>()

        if (includeSystemPrompt && config.systemPrompt != null) {
            messages.add(SystemMessage(
                id = generateId("sys"),
                content = config.systemPrompt!!
            ))
        }

        messages.add(UserMessage(
            id = config.userId ?: generateId("usr"),
            content = message
        ))

        // Only send tools on the first run for each thread (stateless agent optimization)
        val isFirstRunForThread = !threadsWithToolsInfo.contains(threadId)
        val toolRegistry = config.toolRegistry
        val toolsToSend = if (isFirstRunForThread && toolRegistry != null) {
            threadsWithToolsInfo.add(threadId)
            toolRegistry.getAllTools()
        } else {
            emptyList()
        }

        val input = RunAgentInput(
            threadId = threadId,
            runId = generateRunId(),
            messages = messages,
            state = state ?: JsonObject(emptyMap()),
            tools = toolsToSend,
            context = config.context,
            forwardedProps = config.forwardedProps
        )

        return run(input)
    }

    /**
     * Clear the thread tracking for tools (useful for testing or resetting state)
     */
    fun clearThreadToolsTracking() {
        threadsWithToolsInfo.clear()
    }

    /**
     * Close the agent and release resources
     */
    open fun close() {
        agent.dispose()
    }

    /**
     * Generate a unique thread ID based on current timestamp
     *
     * @return A unique thread ID
     */
    protected fun generateThreadId(): String = "thread_${Clock.System.now().toEpochMilliseconds()}"

    /**
     * Generate a unique run ID based on current timestamp
     *
     * @return A unique run ID
     */
    protected fun generateRunId(): String = "run_${Clock.System.now().toEpochMilliseconds()}"

    /**
     * Generate a unique ID with the given prefix
     *
     * @param prefix The prefix for the generated ID
     * @return A unique ID with the specified prefix
     */
    protected fun generateId(prefix: String): String = "${prefix}_${Clock.System.now().toEpochMilliseconds()}"
}

/**
 * Configuration for AG-UI agents
 */
/**
 * Configuration for AG-UI agents
 */
open class AgUiAgentConfig {
    /** Bearer token for authentication */
    var bearerToken: String? = null
    
    /** API key for authentication */
    var apiKey: String? = null
    
    /** Header name for the API key (defaults to "X-API-Key") */
    var apiKeyHeader: String = "X-API-Key"
    
    /** Additional custom headers to include in requests */
    var headers: MutableMap<String, String> = mutableMapOf()
    
    /** System prompt to prepend to conversations */
    var systemPrompt: String? = null
    
    /** Enable debug mode for verbose logging */
    var debug: Boolean = false
    
    /** Tool registry for agent tools */
    var toolRegistry: ToolRegistry? = null
    
    /** Persistent user ID for message attribution */
    var userId: String? = null
    
    /** Context items to include with requests */
    val context: MutableList<Context> = mutableListOf()
    
    /** Properties to forward to the agent */
    var forwardedProps: JsonElement = JsonObject(emptyMap())
    
    /** Request timeout in milliseconds (defaults to 10 minutes) */
    var requestTimeout: Long = 600_000L
    
    /** Connection timeout in milliseconds (defaults to 30 seconds) */
    var connectTimeout: Long = 30_000L

    /**
     * Build the complete headers map including authentication headers
     *
     * @return Map of headers to include in requests
     */
    fun buildHeaders(): Map<String, String> = buildMap {
        bearerToken?.let { put("Authorization", "Bearer $it") }
        apiKey?.let { put(apiKeyHeader, it) }
        putAll(headers)
    }
}