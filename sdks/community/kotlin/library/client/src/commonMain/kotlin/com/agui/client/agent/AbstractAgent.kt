package com.agui.client.agent

import com.agui.core.types.*
import com.agui.client.chunks.transformChunks
import com.agui.client.state.defaultApplyEvents
import com.agui.client.verify.verifyEvents
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.datetime.Clock
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import co.touchlab.kermit.Logger

private val logger = Logger.withTag("AbstractAgent")

/**
 * Base class for all agents in the AG-UI protocol.
 * Provides the core agent functionality including state management and event processing.
 */
abstract class AbstractAgent(
    config: AgentConfig = AgentConfig()
) {
    var agentId: String? = config.agentId
    val description: String = config.description
    val threadId: String = config.threadId ?: generateId()
    
    // Agent state - consider using StateFlow for reactive updates in the future
    var messages: List<Message> = config.initialMessages
        protected set
    
    var state: State = config.initialState
        protected set
    
    var rawEvents: List<RawEvent> = emptyList()
        protected set
    
    var customEvents: List<CustomEvent> = emptyList()
        protected set
    
    var thinking: ThinkingTelemetryState? = null
        protected set
    
    val debug: Boolean = config.debug
    
    // Coroutine scope for agent lifecycle
    protected val agentScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    
    // Current run job for cancellation
    private var currentRunJob: Job? = null

    // Registered subscribers for lifecycle and event hooks
    private val subscribers = mutableListOf<AgentSubscriber>()
    
    /**
     * Abstract method to be implemented by concrete agents.
     * Produces the event stream for the agent run.
     */
    protected abstract fun run(input: RunAgentInput): Flow<BaseEvent>

    /**
     * Registers an [AgentSubscriber] to receive lifecycle and event notifications.
     */
    fun subscribe(subscriber: AgentSubscriber): AgentSubscription {
        subscribers += subscriber
        return object : AgentSubscription {
            override fun unsubscribe() {
                subscribers.remove(subscriber)
            }
        }
    }
    
    /**
     * Main entry point to run the agent.
     * Consumes events internally for state management and returns when complete.
     * Matches TypeScript AbstractAgent.runAgent(): Promise<void>
     * 
     * @param parameters Optional parameters for the agent run including runId, tools, context, and forwarded properties
     * @throws CancellationException if the agent run is cancelled
     * @throws Exception if an unexpected error occurs during execution
     */
    suspend fun runAgent(parameters: RunAgentParameters? = null, subscriber: AgentSubscriber? = null) {
        agentId = agentId ?: generateId()
        val input = prepareRunAgentInput(parameters)
        messages = input.messages
        state = input.state
        val activeSubscribers = subscribers.toMutableList().apply {
            subscriber?.let { add(it) }
        }

        notifyRunInitialized(input, activeSubscribers)

        currentRunJob = agentScope.launch {
            try {
                run(input)
                    .transformChunks(debug)
                    .verifyEvents(debug)
                    .let { events -> apply(input, events, activeSubscribers) }
                    .let { states -> processApplyEvents(input, states, activeSubscribers) }
                    .catch { error ->
                        val stopPropagation = notifyRunFailed(input, activeSubscribers, error)
                        if (!stopPropagation) {
                            logger.e(error) { "Agent execution failed" }
                            onError(error)
                        }
                    }
                    .onCompletion {
                        notifyRunFinalized(input, activeSubscribers)
                        onFinalize()
                    }
                    .collect()
            } catch (e: CancellationException) {
                logger.d { "Agent run cancelled" }
                throw e
            } catch (e: Exception) {
                val stopPropagation = notifyRunFailed(input, activeSubscribers, e)
                if (!stopPropagation) {
                    logger.e(e) { "Unexpected error in agent run" }
                    onError(e)
                }
            }
        }

        currentRunJob?.join()
    }

    /**
     * Returns a Flow of events that can be observed/collected.
     * 
     * IMPORTANT: This method exists due to API confusion between TypeScript and Kotlin implementations.
     * 
     * In TypeScript:
     * - AbstractAgent.runAgent(): Promise<void> - consumes events internally, returns when complete
     * - Some usage examples show .subscribe() but this appears to be from a different/legacy API
     * - The protected run() method returns Observable<BaseEvent> but is not directly accessible
     * 
     * In Kotlin:
     * - runAgent(): suspend fun - matches TypeScript behavior (consumes events, returns Unit)
     * - runAgentObservable(): Flow<BaseEvent> - exposes event stream for observation/collection
     * 
     * Use this method when you need to observe individual events as they arrive:
     * ```
     * agent.runAgentObservable(input).collect { event ->
     *     when (event.eventType) {
     *         "text_message_content" -> println("Content: ${event.delta}")
     *         // Handle other events
     *     }
     * }
     * ```
     * 
     * Use runAgent() when you just want to execute the agent and wait for completion:
     * ```
     * agent.runAgent(parameters) // Suspends until complete
     * ```
     */
    fun runAgentObservable(input: RunAgentInput, subscriber: AgentSubscriber? = null): Flow<BaseEvent> {
        agentId = agentId ?: generateId()
        messages = input.messages
        state = input.state
        val activeSubscribers = subscribers.toMutableList().apply {
            subscriber?.let { add(it) }
        }

        return run(input)
            .transformChunks(debug)
            .verifyEvents(debug)
            .onStart {
                notifyRunInitialized(input, activeSubscribers)
            }
            .onEach { event ->
                try {
                    val updatedInput = input.copy(
                        state = state,
                        messages = messages.toList()
                    )
                    flowOf(event)
                        .let { events -> apply(updatedInput, events, activeSubscribers) }
                        .let { states -> processApplyEvents(input, states, activeSubscribers) }
                        .collect()
                } catch (e: Exception) {
                    logger.w(e) { "Error in state management pipeline for event: ${event.eventType}" }
                }
            }
            .catch { error ->
                val stopPropagation = notifyRunFailed(input, activeSubscribers, error)
                if (!stopPropagation) {
                    logger.e(error) { "Agent execution failed" }
                    onError(error)
                }
                throw error
            }
            .onCompletion {
                notifyRunFinalized(input, activeSubscribers)
                onFinalize()
            }
    }

    /**
     * Convenience method to observe agent events with parameters instead of full input.
     * Returns a Flow of events that can be observed/collected for real-time event processing.
     * 
     * @param parameters Optional parameters for the agent run including runId, tools, context, and forwarded properties
     * @return Flow<BaseEvent> stream of events emitted during agent execution
     * @see runAgentObservable(RunAgentInput) for the full input version
     */
    fun runAgentObservable(parameters: RunAgentParameters? = null, subscriber: AgentSubscriber? = null): Flow<BaseEvent> {
        val input = prepareRunAgentInput(parameters)
        return runAgentObservable(input, subscriber)
    }
    
    /**
     * Cancels the current agent run.
     * This method is safe to call multiple times and will only cancel if a run is in progress.
     */
    open fun abortRun() {
        logger.d { "Aborting agent run" }
        currentRunJob?.cancel("Agent run aborted")
    }
    
    /**
     * Applies events to update agent state.
     * Can be overridden for custom state management. The default implementation
     * uses the defaultApplyEvents function to transform events into state updates.
     * 
     * @param input The original run input containing context and configuration
     * @param events Flow of events to be processed into state updates
     * @return Flow<AgentState> representing state changes over time
     */
    protected open fun apply(
        input: RunAgentInput,
        events: Flow<BaseEvent>,
        subscribers: List<AgentSubscriber> = emptyList()
    ): Flow<AgentState> {
        return defaultApplyEvents(input, events, agent = this, subscribers = subscribers)
    }

    /**
     * Processes state updates from the apply stage.
     * Updates the agent's internal state (messages and state) based on the state changes.
     * Can be overridden to customize how state updates are handled.
     * 
     * @param input The original run input containing context and configuration
     * @param states Flow of state updates to be processed
     * @return Flow<AgentState> the same flow of states, after applying side effects
     */
    protected open fun processApplyEvents(
        input: RunAgentInput,
        states: Flow<AgentState>,
        subscribers: List<AgentSubscriber> = emptyList()
    ): Flow<AgentState> {
        return states.onEach { agentState ->
            var messagesChanged = false
            var stateChanged = false

            agentState.messages?.let {
                messages = it
                messagesChanged = true
                val preview = it.joinToString(" | ") { msg ->
                    when (msg) {
                        is AssistantMessage -> "A:${msg.id}:${msg.content?.take(40)}"
                        is UserMessage -> "U:${msg.id}:${msg.content.take(40)}"
                        is SystemMessage -> "S:${msg.id}:${msg.content ?: ""}"
                        is ToolMessage -> "T:${msg.id}:${msg.content.take(40)}"
                        else -> "${msg::class.simpleName}:${msg.id}"
                    }
                }
                logger.d { "Updated messages(${it.size}): $preview" }
            }
            agentState.state?.let {
                state = it
                stateChanged = true
                if (debug) {
                    logger.d { "Updated state" }
                }
            }
            agentState.rawEvents?.let {
                rawEvents = it
            }
            agentState.customEvents?.let {
                customEvents = it
            }
            agentState.thinking?.let {
                thinking = it
            }

            if (messagesChanged) {
                notifyMessagesChanged(subscribers, input)
            }
            if (stateChanged) {
                notifyStateChanged(subscribers, input)
            }
        }
    }
    
    /**
     * Prepares the input for running the agent.
     * Converts RunAgentParameters into a complete RunAgentInput with all required fields.
     * Generates a new runId if not provided in parameters.
     * 
     * @param parameters Optional parameters to configure the agent run
     * @return RunAgentInput complete input object for agent execution
     */
    protected open fun prepareRunAgentInput(
        parameters: RunAgentParameters?
    ): RunAgentInput {
        return RunAgentInput(
            threadId = threadId,
            runId = parameters?.runId ?: generateId(),
            tools = parameters?.tools ?: emptyList(),
            context = parameters?.context ?: emptyList(),
            forwardedProps = parameters?.forwardedProps ?: JsonObject(emptyMap()),
            state = state,
            messages = messages.toList() // defensive copy
        )
    }
    
    /**
     * Called when an error occurs during agent execution.
     * Override this method to implement custom error handling logic.
     * The default implementation logs the error.
     * 
     * @param error The throwable that caused the execution failure
     */
    protected open fun onError(error: Throwable) {
        // Default implementation logs the error
        logger.e(error) { "Agent execution failed" }
    }
    
    /**
     * Called when agent execution completes (success or failure).
     * Override this method to implement cleanup logic that should run
     * regardless of whether the execution succeeded or failed.
     * The default implementation logs a debug message.
     */
    protected open fun onFinalize() {
        // Default implementation does nothing
        logger.d { "Agent execution finalized" }
    }
    
    /**
     * Creates a deep copy of this agent.
     * Concrete implementations should override this method to provide
     * proper cloning behavior with all configuration and state preserved.
     * 
     * @return AbstractAgent a new instance with the same configuration as this agent
     * @throws NotImplementedError if not overridden by concrete implementations
     */
    open fun clone(): AbstractAgent {
        throw NotImplementedError("Clone must be implemented by concrete agent classes")
    }
    
    /**
     * Cleanup resources when agent is no longer needed.
     * Cancels any running operations and cleans up the coroutine scope.
     * Call this method when the agent will no longer be used to prevent resource leaks.
     */
    open fun dispose() {
        logger.d { "Disposing agent" }
        currentRunJob?.cancel()
        agentScope.cancel()
    }

    private suspend fun notifyRunInitialized(
        input: RunAgentInput,
        subscribers: List<AgentSubscriber>
    ) {
        if (subscribers.isEmpty()) return

        val mutation = runSubscribersWithMutation(subscribers, messages, state) { subscriber, msgSnapshot, stateSnapshot ->
            subscriber.onRunInitialized(
                AgentSubscriberParams(
                    messages = msgSnapshot,
                    state = stateSnapshot,
                    agent = this,
                    input = input
                )
            )
        }
        applyMutationToAgent(mutation, input, subscribers)
    }

    private suspend fun notifyRunFailed(
        input: RunAgentInput,
        subscribers: List<AgentSubscriber>,
        error: Throwable
    ): Boolean {
        if (subscribers.isEmpty()) return false

        val mutation = runSubscribersWithMutation(subscribers, messages, state) { subscriber, msgSnapshot, stateSnapshot ->
            subscriber.onRunFailed(
                AgentRunFailureParams(
                    error = error,
                    messages = msgSnapshot,
                    state = stateSnapshot,
                    agent = this,
                    input = input
                )
            )
        }
        applyMutationToAgent(mutation, input, subscribers)
        return mutation.stopPropagation
    }

    private suspend fun notifyRunFinalized(
        input: RunAgentInput,
        subscribers: List<AgentSubscriber>
    ) {
        if (subscribers.isEmpty()) return

        val mutation = runSubscribersWithMutation(subscribers, messages, state) { subscriber, msgSnapshot, stateSnapshot ->
            subscriber.onRunFinalized(
                AgentSubscriberParams(
                    messages = msgSnapshot,
                    state = stateSnapshot,
                    agent = this,
                    input = input
                )
            )
        }
        applyMutationToAgent(mutation, input, subscribers)
    }

    private suspend fun applyMutationToAgent(
        mutation: AgentStateMutation,
        input: RunAgentInput,
        subscribers: List<AgentSubscriber>
    ) {
        var messagesChanged = false
        var stateChanged = false

        mutation.messages?.let {
            messages = it.toList()
            messagesChanged = true
        }
        mutation.state?.let {
            state = it
            stateChanged = true
        }

        if (messagesChanged) {
            notifyMessagesChanged(subscribers, input)
        }
        if (stateChanged) {
            notifyStateChanged(subscribers, input)
        }
    }

    private suspend fun notifyMessagesChanged(
        subscribers: List<AgentSubscriber>,
        input: RunAgentInput
    ) {
        if (subscribers.isEmpty()) return

        val stateSnapshot = state
        for (subscriber in subscribers) {
            subscriber.onMessagesChanged(
                AgentStateChangedParams(
                    messages = messages.deepCopyMessages(),
                    state = stateSnapshot,
                    agent = this,
                    input = input
                )
            )
        }
    }

    private suspend fun notifyStateChanged(
        subscribers: List<AgentSubscriber>,
        input: RunAgentInput
    ) {
        if (subscribers.isEmpty()) return

        val stateSnapshot = state
        for (subscriber in subscribers) {
            subscriber.onStateChanged(
                AgentStateChangedParams(
                    messages = messages.deepCopyMessages(),
                    state = stateSnapshot,
                    agent = this,
                    input = input
                )
            )
        }
    }

    companion object {
        private fun generateId(): String = "id_${Clock.System.now().toEpochMilliseconds()}"
    }
}

/**
 * Configuration for creating an agent.
 * Base configuration class containing common agent settings such as ID, description,
 * initial state, and debug options.
 * 
 * @property agentId Optional unique identifier for the agent
 * @property description Human-readable description of the agent's purpose
 * @property threadId Optional thread identifier for conversation continuity
 * @property initialMessages List of messages to start the agent with
 * @property initialState Initial state object for the agent
 * @property debug Whether to enable debug logging
 */
open class AgentConfig(
    open val agentId: String? = null,
    open val description: String = "",
    open val threadId: String? = null,
    open val initialMessages: List<Message> = emptyList(),
    open val initialState: State = JsonObject(emptyMap()),
    open val debug: Boolean = false
)

/**
 * HTTP-specific agent configuration extending AgentConfig.
 * Includes URL and HTTP headers for HTTP-based agent implementations.
 * 
 * @property url The HTTP endpoint URL for the agent
 * @property headers Additional HTTP headers to send with requests
 * @property requestTimeout Timeout for HTTP requests in milliseconds (default: 10 minutes)
 * @property connectTimeout Timeout for establishing HTTP connections in milliseconds (default: 30 seconds)
 */
class HttpAgentConfig(
    agentId: String? = null,
    description: String = "",
    threadId: String? = null,
    initialMessages: List<Message> = emptyList(),
    initialState: State = JsonObject(emptyMap()),
    debug: Boolean = false,
    val url: String,
    val headers: Map<String, String> = emptyMap(),
    val requestTimeout: Long = 600_000L, // 10 minutes
    val connectTimeout: Long = 30_000L   // 30 seconds
) : AgentConfig(agentId, description, threadId, initialMessages, initialState, debug)

/**
 * Parameters for running an agent.
 * Optional parameters that can be provided when starting an agent run.
 * 
 * @property runId Optional unique identifier for this specific run
 * @property tools Optional list of tools available to the agent
 * @property context Optional list of context items for the agent
 * @property forwardedProps Optional additional properties to forward to the agent
 */
data class RunAgentParameters(
    val runId: String? = null,
    val tools: List<Tool>? = null,
    val context: List<Context>? = null,
    val forwardedProps: JsonElement? = null
)

/**
 * Represents the transformed agent state.
 * Contains the current state of the agent including messages, thinking telemetry,
 * state data, and auxiliary events.
 * 
 * @property messages Optional list of messages in the current conversation
 * @property thinking Optional thinking telemetry describing the agent's internal reasoning stream
 * @property state Optional state object containing agent-specific data
 * @property rawEvents Optional list of RAW events that have been received
 * @property customEvents Optional list of CUSTOM events that have been received
 */
data class AgentState(
    val messages: List<Message>? = null,
    val thinking: ThinkingTelemetryState? = null,
    val state: State? = null,
    val rawEvents: List<RawEvent>? = null,
    val customEvents: List<CustomEvent>? = null
)

/**
 * Represents the agent's thinking telemetry stream.
 *
 * @property isThinking Whether the agent is actively thinking
 * @property title Optional title or description supplied with the thinking step
 * @property messages Ordered list of thinking text messages emitted by the agent
 */
data class ThinkingTelemetryState(
    val isThinking: Boolean,
    val title: String? = null,
    val messages: List<String> = emptyList()
)
