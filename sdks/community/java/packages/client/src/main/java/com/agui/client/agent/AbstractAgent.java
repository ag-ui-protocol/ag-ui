package com.agui.client.agent;

import com.agui.client.message.MessageFactory;
import com.agui.core.agent.*;
import com.agui.core.event.*;
import com.agui.core.exception.AGUIException;
import com.agui.core.message.BaseMessage;
import com.agui.core.message.Role;
import com.agui.core.state.State;
import com.agui.core.stream.EventStream;
import com.agui.core.stream.IEventStream;
import com.agui.core.subscription.Subscription;
import com.agui.core.type.EventType;

import java.util.*;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicReference;
import java.util.logging.Level;
import java.util.logging.Logger;

/**
 * Abstract base implementation of the Agent interface providing common functionality
 * for agent execution, event handling, and subscriber management.
 * <p>
 * This class handles the core orchestration of agent runs, including:
 * <ul>
 * <li>Managing subscriber callbacks and event distribution</li>
 * <li>Handling asynchronous execution with proper error handling</li>
 * <li>Managing conversation state and message history</li>
 * <li>Providing extensible event streaming capabilities</li>
 * </ul>
 * <p>
 * Subclasses must implement the {@link #run(RunAgentInput, IEventStream)} method
 * to define their specific agent logic while benefiting from the common infrastructure
 * provided by this base class.
 * <p>
 * The class supports both persistent subscribers (added via {@link #subscribe(AgentSubscriber)})
 * and per-execution subscribers (passed to {@link #runAgent(RunAgentParameters, AgentSubscriber)}).
 * <p>
 * Many methods are marked as protected to allow subclasses to customize event handling,
 * message processing, and other aspects of the agent execution lifecycle.
 *
 * @author Pascal Wilbrink
 */
public abstract class AbstractAgent implements Agent {
    private static final Logger logger = Logger.getLogger(AbstractAgent.class.getName());

    protected String agentId;
    protected String description;
    protected String threadId;
    protected List<BaseMessage> messages;
    protected State state;
    protected boolean debug = false;

    private final List<AgentSubscriber> agentSubscribers = new ArrayList<>();
    private final MessageFactory messageFactory;

    /**
     * Constructs a new AbstractAgent with the specified configuration.
     *
     * @param agentId         unique identifier for this agent instance
     * @param description     human-readable description of the agent's purpose
     * @param threadId        identifier for the conversation thread, or null to generate one
     * @param initialMessages initial conversation history, or null for empty history
     * @param state           initial agent state, or null for default empty state
     * @param debug           whether to enable debug logging and output
     */
    protected AbstractAgent(
        String agentId,
        String description,
        String threadId,
        List<BaseMessage> initialMessages,
        State state,
        boolean debug
    ) {
        this.agentId = agentId;
        this.description = Optional.ofNullable(description).orElse("");
        this.threadId = Optional.ofNullable(threadId).orElse(UUID.randomUUID().toString());
        this.messages = Optional.ofNullable(initialMessages).orElse(new ArrayList<>());
        this.state = Optional.ofNullable(state).orElse(new State());
        this.debug = debug;

        this.messageFactory = new MessageFactory();
    }

    /**
     * Subscribes a persistent subscriber to receive events from all agent runs.
     * <p>
     * Persistent subscribers will receive events from every execution of this agent
     * instance until they are unsubscribed using the returned Subscription.
     *
     * @param subscriber the subscriber to register for events
     * @return a Subscription that can be used to unsubscribe the subscriber
     */
    public Subscription subscribe(AgentSubscriber subscriber) {
        agentSubscribers.add(subscriber);
        return () -> agentSubscribers.remove(subscriber);
    }

    /**
     * Abstract method that subclasses must implement to define their agent logic.
     * <p>
     * This method is called asynchronously when the agent is executed. Implementations
     * should use the provided event stream to emit events during execution and handle
     * the input parameters to perform their specific AI agent tasks.
     *
     * @param input  the input parameters containing context, messages, tools, and configuration
     * @param stream the event stream for emitting events during execution
     */
    protected abstract void run(RunAgentInput input, IEventStream<BaseEvent> stream);

    /**
     * Executes the agent asynchronously with the specified parameters and optional subscriber.
     * <p>
     * This method orchestrates the complete agent execution lifecycle, including:
     * <ul>
     * <li>Preparing input parameters and subscriber lists</li>
     * <li>Initializing the event stream and subscriber callbacks</li>
     * <li>Executing the agent logic asynchronously</li>
     * <li>Handling events, errors, and completion</li>
     * </ul>
     *
     * @param parameters the configuration parameters for this agent execution
     * @param subscriber optional additional subscriber for this specific execution
     * @return a CompletableFuture that completes when the agent execution finishes
     */
    public CompletableFuture<Void> runAgent(RunAgentParameters parameters, AgentSubscriber subscriber) {
        agentId = Optional.ofNullable(agentId).orElse(UUID.randomUUID().toString());

        RunAgentInput input = prepareRunAgentInput(parameters);
        List<AgentSubscriber> subscribers = prepareSubscribers(subscriber);

        onInitialize(input, subscribers);

        CompletableFuture<Void> future = new CompletableFuture<>();
        AtomicReference<IEventStream<BaseEvent>> streamRef = new AtomicReference<>();

        IEventStream<BaseEvent> stream = new EventStream<>(
            event -> handleEvent(event, subscribers, streamRef),
            error -> handleError(error, subscribers, future),
            () -> handleComplete(subscribers, input, future)
        );

        streamRef.set(stream);

        CompletableFuture.runAsync(() -> {
            try {
                run(input, stream);
            } catch (Exception e) {
                stream.error(e);
            }
        });

        return future;
    }

    /**
     * Handles individual events from the event stream by distributing them to subscribers.
     * <p>
     * This method is protected to allow subclasses to customize event handling behavior,
     * such as filtering events, adding custom processing, or modifying the event flow.
     *
     * @param event        the event to handle
     * @param subscribers  the list of subscribers to notify
     * @param streamRef    reference to the event stream for completion handling
     */
    protected void handleEvent(
            BaseEvent event,
            List<AgentSubscriber> subscribers,
            AtomicReference<IEventStream<BaseEvent>> streamRef
    ) {
        subscribers.forEach(subscriber -> {
            try {
                subscriber.onEvent(event);
                handleEventByType(event, subscriber);
            } catch (Exception e) {
                logError("Error in subscriber", e);
            }
        });

        if (event.getType().equals(EventType.RUN_FINISHED)) {
            streamRef.get().complete();
        }
    }

    /**
     * Handles the completion of agent execution by notifying subscribers and completing the future.
     * <p>
     * This method is protected to allow subclasses to customize completion behavior,
     * such as performing cleanup operations or additional finalization steps.
     *
     * @param subscribers the list of subscribers to notify
     * @param input       the original input parameters
     * @param future      the CompletableFuture to complete
     */
    protected void handleComplete(
        List<AgentSubscriber> subscribers,
        RunAgentInput input,
        CompletableFuture<Void> future
    ) {
        AgentSubscriberParams params = new AgentSubscriberParams(messages, state, this, input);
        subscribers.forEach(subscriber -> {
            try {
                subscriber.onRunFinalized(params);
            } catch (Exception e) {
                logError("Error in subscriber complete handler", e);
            }
        });
        future.complete(null);
    }

    /**
     * Handles errors during agent execution by notifying subscribers and failing the future.
     * <p>
     * This method is protected to allow subclasses to customize error handling behavior,
     * such as implementing retry logic, custom error transformation, or recovery strategies.
     *
     * @param error       the error that occurred
     * @param subscribers the list of subscribers to notify
     * @param future      the CompletableFuture to complete exceptionally
     */
    protected void handleError(
        Throwable error,
        List<AgentSubscriber> subscribers,
        CompletableFuture<Void> future
    ) {
        subscribers.forEach(subscriber -> {
            try {
                RunErrorEvent event = new RunErrorEvent();
                event.setError(error.getMessage());
                subscriber.onRunErrorEvent(event);
            } catch (Exception e) {
                logError("Error in subscriber error handler", e);
            }
        });
        future.completeExceptionally(error);
    }

    /**
     * Prepares the list of subscribers by combining persistent and per-execution subscribers.
     *
     * @param subscriber optional additional subscriber for this execution
     * @return combined list of all subscribers for this execution
     */
    private List<AgentSubscriber> prepareSubscribers(AgentSubscriber subscriber) {
        List<AgentSubscriber> subscribers = new ArrayList<>(agentSubscribers);
        if (subscriber != null) {
            subscribers.add(subscriber);
        }
        return subscribers;
    }

    /**
     * Dispatches events to the appropriate subscriber methods based on event type.
     * <p>
     * This method is protected to allow subclasses to customize event dispatching,
     * such as handling custom event types, modifying event processing order,
     * or implementing additional event filtering logic.
     *
     * @param event      the event to dispatch
     * @param subscriber the subscriber to notify
     */
    protected void handleEventByType(BaseEvent event, AgentSubscriber subscriber) {
        try {
            switch (event.getType()) {
                case RUN_STARTED -> subscriber.onRunStartedEvent((RunStartedEvent) event);
                case RUN_ERROR -> subscriber.onRunErrorEvent((RunErrorEvent) event);
                case RUN_FINISHED -> subscriber.onRunFinishedEvent((RunFinishedEvent) event);
                case STEP_STARTED -> subscriber.onStepStartedEvent((StepStartedEvent) event);
                case STEP_FINISHED -> subscriber.onStepFinishedEvent((StepFinishedEvent) event);
                case TEXT_MESSAGE_START -> handleTextMessageStart((TextMessageStartEvent) event, subscriber);
                case TEXT_MESSAGE_CONTENT -> handleTextMessageContent((TextMessageContentEvent) event, subscriber);
                case TEXT_MESSAGE_CHUNK -> handleTextMessageChunk((TextMessageChunkEvent) event, subscriber);
                case TEXT_MESSAGE_END -> handleTextMessageEnd((TextMessageEndEvent) event, subscriber);
                case TOOL_CALL_START -> subscriber.onToolCallStartEvent((ToolCallStartEvent) event);
                case TOOL_CALL_ARGS -> subscriber.onToolCallArgsEvent((ToolCallArgsEvent) event);
                case TOOL_CALL_RESULT -> subscriber.onToolCallResultEvent((ToolCallResultEvent) event);
                case TOOL_CALL_END -> subscriber.onToolCallEndEvent((ToolCallEndEvent) event);
                case RAW -> subscriber.onRawEvent((RawEvent) event);
                case CUSTOM -> subscriber.onCustomEvent((CustomEvent) event);
                case MESSAGES_SNAPSHOT -> subscriber.onMessagesSnapshotEvent((MessagesSnapshotEvent) event);
                case STATE_SNAPSHOT -> subscriber.onStateSnapshotEvent((StateSnapshotEvent) event);
                case STATE_DELTA -> subscriber.onStateDeltaEvent((StateDeltaEvent) event);
                default -> {
                    if (debug) {
                        logger.info("Unhandled event type: " + event.getType());
                    }
                }
            }
        } catch (Exception e) {
            logError("Error handling event type " + event.getType(), e);
        }
    }

    /**
     * Handles text message start events by creating a new message in the factory.
     * <p>
     * This method is protected to allow subclasses to customize message creation
     * behavior, such as setting custom message properties or implementing
     * different message initialization strategies.
     *
     * @param event      the text message start event
     * @param subscriber the subscriber to notify
     * @throws AGUIException if message creation fails
     */
    protected void handleTextMessageStart(TextMessageStartEvent event, AgentSubscriber subscriber) throws AGUIException {
        messageFactory.createMessage(event.getMessageId(), Role.assistant);
        subscriber.onTextMessageStartEvent(event);
    }

    /**
     * Handles text message content events by adding content chunks to the message.
     * <p>
     * This method is protected to allow subclasses to customize content processing,
     * such as filtering content, applying transformations, or implementing
     * custom content validation logic.
     *
     * @param event      the text message content event
     * @param subscriber the subscriber to notify
     * @throws AGUIException if content addition fails
     */
    protected void handleTextMessageContent(TextMessageContentEvent event, AgentSubscriber subscriber) throws AGUIException {
        messageFactory.addChunk(event.getMessageId(), event.getDelta());
        subscriber.onTextMessageContentEvent(event);
    }

    /**
     * Handles text message chunk events by converting them to content events.
     * <p>
     * This method is protected to allow subclasses to customize chunk processing,
     * such as implementing custom chunk aggregation strategies or adding
     * chunk-level validation and transformation logic.
     *
     * @param event      the text message chunk event
     * @param subscriber the subscriber to notify
     * @throws AGUIException if chunk processing fails
     */
    protected void handleTextMessageChunk(TextMessageChunkEvent event, AgentSubscriber subscriber) throws AGUIException {
        TextMessageContentEvent contentEvent = new TextMessageContentEvent();
        contentEvent.setMessageId(event.getMessageId());
        contentEvent.setDelta(event.getDelta());
        contentEvent.setTimestamp(event.getTimestamp());

        subscriber.onTextMessageContentEvent(contentEvent);
        messageFactory.addChunk(event.getMessageId(), event.getDelta());
    }

    /**
     * Handles text message end events by finalizing the message and adding it to history.
     * <p>
     * This method is protected to allow subclasses to customize message finalization,
     * such as post-processing message content, implementing custom storage strategies,
     * or adding message-level validation before adding to conversation history.
     *
     * @param event      the text message end event
     * @param subscriber the subscriber to notify
     * @throws AGUIException if message finalization fails
     */
    protected void handleTextMessageEnd(TextMessageEndEvent event, AgentSubscriber subscriber) throws AGUIException {
        subscriber.onTextMessageEndEvent(event);
        BaseMessage newMessage = messageFactory.getMessage(event.getMessageId());
        addMessage(newMessage);
        subscriber.onNewMessage(newMessage);
    }

    /**
     * Called during agent initialization to notify subscribers that a run is starting.
     * <p>
     * This method is protected to allow subclasses to customize initialization behavior,
     * such as performing setup operations, validating input parameters, or implementing
     * custom initialization logic before the agent begins execution.
     *
     * @param input       the input parameters for this run
     * @param subscribers the list of subscribers to notify
     */
    protected void onInitialize(RunAgentInput input, List<AgentSubscriber> subscribers) {
        AgentSubscriberParams params = new AgentSubscriberParams(messages, state, this, input);
        subscribers.forEach(subscriber -> {
            try {
                subscriber.onRunInitialized(params);
            } catch (Exception e) {
                logError("Error in subscriber.onRunInitialized", e);
            }
        });
    }

    /**
     * Adds a new message to the conversation history and notifies subscribers.
     * <p>
     * If the message does not have an ID or name, they will be automatically generated.
     *
     * @param message the message to add to the conversation
     */
    public void addMessage(BaseMessage message) {
        if (message.getId() == null) {
            message.setId(UUID.randomUUID().toString());
        }
        if (message.getName() == null) {
            message.setName("");
        }
        messages.add(message);

        agentSubscribers.forEach(subscriber -> {
            try {
                subscriber.onNewMessage(message);
            } catch (Exception e) {
                logError("Error in message subscriber", e);
            }
        });
    }

    /**
     * Adds multiple messages to the conversation history.
     *
     * @param messages the list of messages to add
     */
    public void addMessages(List<BaseMessage> messages) {
        messages.forEach(this::addMessage);
    }

    /**
     * Replaces the entire conversation history and notifies subscribers of the change.
     *
     * @param messages the new conversation history
     */
    public void setMessages(List<BaseMessage> messages) {
        this.messages = messages;

        AgentSubscriberParams params = new AgentSubscriberParams(messages, state, this, null);
        agentSubscribers.forEach(subscriber -> {
            try {
                subscriber.onMessagesChanged(params);
            } catch (Exception e) {
                logError("Error in messages changed subscriber", e);
            }
        });
    }

    @Override
    public List<BaseMessage> getMessages() {
        return this.messages;
    }

    /**
     * Updates the agent's internal state and notifies subscribers.
     * <p>
     * Note: The state change notification is currently not implemented (TODO).
     *
     * @param state the new agent state
     */
    public void setState(State state) {
        this.state = state;

        agentSubscribers.forEach(subscriber -> {
            try {
                subscriber.onStateChanged(state);
            } catch (Exception e) {
                logError("Error in state changed subscriber", e);
            }
        });
    }

    /**
     * Prepares the RunAgentInput from the provided parameters and agent state.
     * <p>
     * This method is protected to allow subclasses to customize input preparation,
     * such as adding default values, validating parameters, or implementing
     * custom parameter transformation logic.
     *
     * @param parameters the execution parameters
     * @return a complete RunAgentInput with all necessary information
     */
    protected RunAgentInput prepareRunAgentInput(RunAgentParameters parameters) {
        return new RunAgentInput(
            Objects.nonNull(parameters.getThreadId())
                ? parameters.getThreadId()
                : this.threadId,
            Optional.ofNullable(parameters.getRunId()).orElse(UUID.randomUUID().toString()),
            this.state,
            this.messages,
            Optional.ofNullable(parameters.getTools()).orElse(Collections.emptyList()),
            Optional.ofNullable(parameters.getContext()).orElse(Collections.emptyList()),
            parameters.getForwardedProps()
        );
    }

    /**
     * Gets the current agent state.
     *
     * @return the current State object
     */
    public State getState() {
        return state;
    }

    /**
     * Logs errors with appropriate detail based on debug settings.
     *
     * @param message the error message
     * @param e       the exception that occurred
     */
    private void logError(String message, Exception e) {
        logger.log(Level.SEVERE, message + ": " + e.getMessage(), e);
        if (debug) {
            e.printStackTrace();
        }
    }
}