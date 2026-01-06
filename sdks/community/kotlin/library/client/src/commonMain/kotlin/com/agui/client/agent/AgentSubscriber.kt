package com.agui.client.agent

import com.agui.core.types.*

/**
 * Represents a mutation requested by an [AgentSubscriber].
 *
 * Subscribers can replace the pending message collection, update state, or
 * stop propagation so the default handlers skip their own processing.
 */
data class AgentStateMutation(
    val messages: List<Message>? = null,
    val state: State? = null,
    val stopPropagation: Boolean = false
)

/**
 * Common parameters shared across subscriber callbacks.
 */
data class AgentSubscriberParams(
    val messages: List<Message>,
    val state: State,
    val agent: AbstractAgent,
    val input: RunAgentInput
)

/**
 * Parameters delivered when subscribers observe a raw event.
 */
data class AgentEventParams(
    val event: BaseEvent,
    val messages: List<Message>,
    val state: State,
    val agent: AbstractAgent,
    val input: RunAgentInput
)

/**
 * Parameters passed when the run fails with an exception.
 */
data class AgentRunFailureParams(
    val error: Throwable,
    val messages: List<Message>,
    val state: State,
    val agent: AbstractAgent,
    val input: RunAgentInput
)

/**
 * Parameters used when notifying subscribers of state or message changes.
 */
data class AgentStateChangedParams(
    val messages: List<Message>,
    val state: State,
    val agent: AbstractAgent,
    val input: RunAgentInput
)

/**
 * Subscription handle returned by [AbstractAgent.subscribe].
 */
interface AgentSubscription {
    fun unsubscribe()
}

/**
 * Contract for observers that want to intercept lifecycle or event updates.
 *
 * All callbacks are optional. Returning [AgentStateMutation.stopPropagation] = true
 * prevents the default handlers from mutating the agent state for that event.
 */
interface AgentSubscriber {
    suspend fun onRunInitialized(params: AgentSubscriberParams): AgentStateMutation? = null

    suspend fun onRunFailed(params: AgentRunFailureParams): AgentStateMutation? = null

    suspend fun onRunFinalized(params: AgentSubscriberParams): AgentStateMutation? = null

    suspend fun onEvent(params: AgentEventParams): AgentStateMutation? = null

    suspend fun onMessagesChanged(params: AgentStateChangedParams) {}

    suspend fun onStateChanged(params: AgentStateChangedParams) {}
}

internal fun Message.deepCopy(): Message = when (this) {
    is DeveloperMessage -> this.copy()
    is SystemMessage -> this.copy()
    is AssistantMessage -> this.copy(
        content = this.content,
        name = this.name,
        toolCalls = this.toolCalls?.map { it.copy(function = it.function.copy()) }
    )
    is UserMessage -> this.copy()
    is ToolMessage -> this.copy()
    is ActivityMessage -> this.copy()
}

internal fun List<Message>.deepCopyMessages(): List<Message> = map { it.deepCopy() }

/**
 * Executes subscribers sequentially, feeding the latest message/state snapshot.
 */
suspend fun runSubscribersWithMutation(
    subscribers: List<AgentSubscriber>,
    messages: List<Message>,
    state: State,
    executor: suspend (AgentSubscriber, List<Message>, State) -> AgentStateMutation?
): AgentStateMutation {
    var currentMessages = messages
    var currentState = state
    var aggregatedMessages: List<Message>? = null
    var aggregatedState: State? = null
    var stopPropagation = false

    for (subscriber in subscribers) {
        val mutation = executor(subscriber, currentMessages.deepCopyMessages(), currentState)

        if (mutation != null) {
            mutation.messages?.let {
                currentMessages = it
                aggregatedMessages = it
            }
            mutation.state?.let {
                currentState = it
                aggregatedState = it
            }
            if (mutation.stopPropagation) {
                stopPropagation = true
                break
            }
        }
    }

    return AgentStateMutation(
        messages = aggregatedMessages,
        state = aggregatedState,
        stopPropagation = stopPropagation
    )
}
