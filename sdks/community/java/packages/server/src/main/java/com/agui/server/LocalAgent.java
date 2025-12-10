package com.agui.server;

import com.agui.core.agent.Agent;
import com.agui.core.agent.AgentSubscriber;
import com.agui.core.agent.RunAgentInput;
import com.agui.core.agent.RunAgentParameters;
import com.agui.core.context.Context;
import com.agui.core.event.*;
import com.agui.core.exception.AGUIException;
import com.agui.core.message.BaseMessage;
import com.agui.core.message.Role;
import com.agui.core.message.SystemMessage;
import com.agui.core.message.UserMessage;
import com.agui.core.state.State;

import java.util.*;
import java.util.concurrent.CompletableFuture;
import java.util.function.Function;

/**
 * Abstract base class for local agent implementations that provides common functionality
 * for running agents in the AG-UI framework.
 *
 * This class implements the {@link Agent} interface and provides a foundation for creating
 * agents that can process messages, maintain state, and emit events during execution.
 * The agent supports both static system messages and dynamic system message providers.
 *
 * @author Pascal Wilbrink
 */
public abstract class LocalAgent implements Agent {

    /**
     * Unique identifier for this agent instance.
     */
    protected final String agentId;

    /**
     * Current state of the agent, containing persistent data and configuration.
     */
    protected State state;

    /**
     * Static system message content used when no system message provider is specified.
     */
    protected String systemMessage;

    /**
     * Function that dynamically generates system messages based on the current agent state.
     * Takes precedence over the static system message if both are provided.
     */
    protected Function<LocalAgent, String> systemMessageProvider;

    protected List<BaseMessage> messages;

    /**
     * Constructs a new LocalAgent with the specified configuration.
     *
     * @param agentId unique identifier for this agent instance
     * @param state initial state for the agent
     * @param systemMessageProvider function to dynamically generate system messages (can be null)
     * @param systemMessage static system message content (can be null if systemMessageProvider is provided)
     * @throws AGUIException if both systemMessage and systemMessageProvider are null
     */
    public LocalAgent(
        final String agentId,
        final State state,
        final Function<LocalAgent, String> systemMessageProvider,
        final String systemMessage,
        final List<BaseMessage> messages
    ) throws AGUIException {
        this.agentId = agentId;

        this.state = state;

        if (Objects.isNull(systemMessage) && Objects.isNull(systemMessageProvider)) {
            throw new AGUIException("Either SystemMessage or SystemMessageProvider should be set.");
        }

        this.systemMessage = systemMessage;
        this.systemMessageProvider = systemMessageProvider;

        this.messages = messages;
    }

    /**
     * Returns the unique identifier for this agent.
     *
     * @return the agent ID
     */
    public String getAgentId() {
        return this.agentId;
    }

    /**
     * Updates the current state of the agent.
     *
     * @param state the new state to set for this agent
     */
    public void setState(final State state) {
        this.state = state;
    }

    /**
     * {@inheritDoc}
     *
     * Returns the messages of the agent
     */
    public List<BaseMessage> getMessages() {
        return this.messages;
    }

    /**
     * {@inheritDoc}
     *
     * Executes the agent asynchronously with the provided parameters and notifies
     * the subscriber of events during execution.
     */
    @Override
    public CompletableFuture<Void> runAgent(RunAgentParameters parameters, AgentSubscriber subscriber) {
        CompletableFuture<Void> future = new CompletableFuture<>();

        var input = new RunAgentInput(
            parameters.getThreadId(),
            Objects.isNull(parameters.getRunId())
                ? UUID.randomUUID().toString()
                : parameters.getRunId(),
            Objects.nonNull(parameters.getState())
                ? parameters.getState()
                : this.state,
            parameters.getMessages(),
            parameters.getTools(),
            parameters.getContext(),
            parameters.getForwardedProps()
        );

        CompletableFuture.runAsync(() -> this.run(input, subscriber));

        return future;
    }

    /**
     * Abstract method that must be implemented by subclasses to define the agent's
     * execution logic.
     *
     * @param input the input parameters for the agent run, including messages, tools, and context
     * @param subscriber the event subscriber to notify of execution events
     */
    protected abstract void run(RunAgentInput input, AgentSubscriber subscriber);

    /**
     * Emits an event to the subscriber and routes it to the appropriate specific event handler
     * based on the event type.
     *
     * This method handles the polymorphic dispatch of events to their corresponding
     * handler methods on the subscriber.
     *
     * @param event the event to emit
     * @param subscriber the subscriber to notify of the event
     */
    protected void emitEvent(final BaseEvent event, final AgentSubscriber subscriber) {
        subscriber.onEvent(event);

        switch (event.getType()) {
            case RAW -> subscriber.onRawEvent((RawEvent) event);
            case CUSTOM -> subscriber.onCustomEvent((CustomEvent) event);
            case RUN_STARTED -> subscriber.onRunStartedEvent((RunStartedEvent) event);
            case RUN_ERROR -> subscriber.onRunErrorEvent((RunErrorEvent) event);
            case RUN_FINISHED -> subscriber.onRunFinishedEvent((RunFinishedEvent) event);
            case STEP_STARTED -> subscriber.onStepStartedEvent((StepStartedEvent) event);
            case STEP_FINISHED -> subscriber.onStepFinishedEvent((StepFinishedEvent) event);
            case TEXT_MESSAGE_START -> subscriber.onTextMessageStartEvent((TextMessageStartEvent) event);
            case TEXT_MESSAGE_CHUNK -> {
                var chunkEvent = (TextMessageChunkEvent)event;
                var textMessageContentEvent = new TextMessageContentEvent();
                textMessageContentEvent.setDelta(chunkEvent.getDelta());
                textMessageContentEvent.setMessageId(chunkEvent.getMessageId());
                textMessageContentEvent.setTimestamp(chunkEvent.getTimestamp());
                textMessageContentEvent.setRawEvent(chunkEvent.getRawEvent());
                subscriber.onTextMessageContentEvent(textMessageContentEvent);
            }
            case TEXT_MESSAGE_CONTENT -> subscriber.onTextMessageContentEvent((TextMessageContentEvent) event);
            case TEXT_MESSAGE_END -> subscriber.onTextMessageEndEvent((TextMessageEndEvent) event);
            case TOOL_CALL_START -> subscriber.onToolCallStartEvent((ToolCallStartEvent) event);
            case TOOL_CALL_ARGS -> subscriber.onToolCallArgsEvent((ToolCallArgsEvent) event);
            case TOOL_CALL_RESULT -> subscriber.onToolCallResultEvent((ToolCallResultEvent) event);
            case TOOL_CALL_END -> subscriber.onToolCallEndEvent((ToolCallEndEvent) event);
        }
    }

    /**
     * Creates a system message that includes the agent's system prompt, current state,
     * and provided context information.
     *
     * The system message is constructed by combining:
     * <ul>
     * <li>The system message content (either from the provider function or static message)</li>
     * <li>The current agent state</li>
     * <li>The provided context information</li>
     * </ul>
     *
     * @param context list of context objects to include in the system message
     * @return a new SystemMessage containing the formatted system prompt
     */
    protected SystemMessage createSystemMessage(final State state, final List<Context> context) {
        var message = """
%s

State:
%s

Context:
%s
"""
            .formatted(
                (Objects.nonNull(this.systemMessageProvider)
                    ? this.systemMessageProvider.apply(this)
                    : this.systemMessage
                ),
                state,
                String.join("\n",
                    context.stream().map(Context::toString)
                    .toList()
                )
            );

        var systemMessage = new SystemMessage();

        systemMessage.setId(UUID.randomUUID().toString());
        systemMessage.setContent(message);

        return systemMessage;
    }

    /**
     * Retrieves the most recent user message from a list of messages.
     *
     * This method filters the message list to find messages with the User role
     * and returns the last one in the list.
     *
     * @param messages list of messages to search through
     * @return the most recent UserMessage in the list
     * @throws AGUIException if no user message is found in the list
     */
    protected UserMessage getLatestUserMessage(List<BaseMessage> messages) throws AGUIException {
        return (UserMessage)messages.stream()
            .filter(m -> m.getRole().equals(Role.user))
            .reduce((a, b) -> b)
            .orElseThrow(() -> new AGUIException("No User Message found."));
    }

}