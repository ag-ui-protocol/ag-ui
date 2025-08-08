package io.workm8.agui.client;

import io.workm8.agui.client.message.MessageFactory;
import io.workm8.agui.client.stream.EventStream;
import io.workm8.agui.client.stream.IEventStream;
import io.workm8.agui.client.subscriber.AgentSubscriber;
import io.workm8.agui.client.subscriber.AgentSubscriberParams;
import io.workm8.agui.message.BaseMessage;
import io.workm8.agui.type.EventType;
import io.workm8.agui.input.RunAgentInput;
import io.workm8.agui.state.State;
import io.workm8.agui.event.*;

import java.util.*;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicReference;

public abstract class AbstractAgent {

    protected String agentId;
    protected String description;
    protected String threadId;
    protected List<BaseMessage> messages;
    protected State state;
    protected boolean debug = false;

    private final List<AgentSubscriber> agentSubscribers = new ArrayList<>();

    private final MessageFactory messageFactory;

    public AbstractAgent(
        final String agentId,
        final String description,
        final String threadId,
        final List<BaseMessage> messages,
        final State state,
        final boolean debug
    ) {
        this.agentId = agentId;
        this.description = Objects.nonNull(description) ? description : "";
        this.threadId = Objects.nonNull(threadId) ? threadId : UUID.randomUUID().toString();
        this.messages = Objects.nonNull(messages) ? messages : new ArrayList<>();
        this.state = Objects.nonNull(state) ? state : new State();
        this.debug = debug;

        this.messageFactory = new MessageFactory();
    }

    public Subscription subscribe(final AgentSubscriber subscriber) {
        this.agentSubscribers.add(subscriber);
        return () -> this.agentSubscribers.remove(subscriber);
    }

    protected abstract void run(RunAgentInput input, IEventStream<BaseEvent> stream);

    public CompletableFuture<Void> runAgent(RunAgentParameters parameters) {
        return this.runAgent(parameters, null);
    }

    public CompletableFuture<Void> runAgent(
        RunAgentParameters parameters,
        AgentSubscriber subscriber
    ) {
        this.agentId = Objects.nonNull(this.agentId) ? this.agentId : UUID.randomUUID().toString();

        var input = this.prepareRunAgentInput(parameters);
        List<AgentSubscriber> subscribers = prepareSubscribers(subscriber);

        this.onInitialize(input, subscribers);

        CompletableFuture<Void> future = new CompletableFuture<>();

        AtomicReference<IEventStream<BaseEvent>> streamRef = new AtomicReference<>();

        // Create the stream with callbacks
        IEventStream<BaseEvent> stream = new EventStream<>(
            event -> {
                handleEvent(event, subscribers);
                if (event.getType().equals(EventType.RUN_FINISHED)) {
                    streamRef.get().complete();
                }
            },
            error -> {
                handleError(error, subscribers);
                future.completeExceptionally(error);
            },
            () -> {
                handleComplete(subscribers, new AgentSubscriberParams(messages, state, this, input));
                future.complete(null);
            }
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

    private void handleEvent(BaseEvent event, List<AgentSubscriber> subscribers) {
        subscribers.forEach(subscriber -> {
            try {
                subscriber.onEvent(event);
                this.handleEventByType(event, subscriber);
            } catch (Exception e) {
                System.err.println("Error in subscriber: " + e.getMessage());
                if (debug) {
                    e.printStackTrace();
                }
            }
        });
    }

    private void handleComplete(List<AgentSubscriber> subscribers, AgentSubscriberParams params) {
        subscribers.forEach(subscriber -> {
            try {
                subscriber.onRunFinalized(params);
            } catch (Exception e) {
                System.err.println("Error in subscriber complete handler: " + e.getMessage());
                if (debug) {
                    e.printStackTrace();
                }
            }
        });
    }

    private void handleError(Throwable error, List<AgentSubscriber> subscribers) {
        subscribers.forEach(subscriber -> {
            try {
                var event = new RunErrorEvent();
                event.setError(error.getMessage());
                subscriber.onRunErrorEvent(event);
            } catch (Exception e) {
                System.err.println("Error in subscriber error handler: " + e.getMessage());
                if (debug) {
                    e.printStackTrace();
                }
            }
        });
    }

    private List<AgentSubscriber> prepareSubscribers(AgentSubscriber subscriber) {
        List<AgentSubscriber> subscribers = new ArrayList<>();

        if (Objects.nonNull(subscriber)) {
            subscribers.add(subscriber);
        }

        subscribers.addAll(this.agentSubscribers);
        return subscribers;
    }

    private void handleEventByType(BaseEvent event, AgentSubscriber subscriber) {
        try {
            switch (event.getType()) {
                case RUN_STARTED -> subscriber.onRunStartedEvent((RunStartedEvent) event);
                case RUN_ERROR -> subscriber.onRunErrorEvent((RunErrorEvent) event);
                case RUN_FINISHED -> subscriber.onRunFinishedEvent((RunFinishedEvent) event);
                case STEP_STARTED -> subscriber.onStepStartedEvent((StepStartedEvent) event);
                case STEP_FINISHED -> subscriber.onStepFinishedEvent((StepFinishedEvent) event);
                case TEXT_MESSAGE_START -> {
                    var textMessageStartEvent = (TextMessageStartEvent)event;
                    this.messageFactory.createMessage(textMessageStartEvent.getMessageId(), "assistant");
                    subscriber.onTextMessageStartEvent(textMessageStartEvent);
                }
                case TEXT_MESSAGE_CONTENT -> {
                    var textMessageContentEvent = (TextMessageContentEvent)event;

                    this.messageFactory.addChunk(textMessageContentEvent.getMessageId(), textMessageContentEvent.getDelta());
                    subscriber.onTextMessageContentEvent(textMessageContentEvent);
                }
                case TEXT_MESSAGE_CHUNK -> {
                    var textMessageChunkEvent = (TextMessageChunkEvent)event;
                    var contentEvent = new TextMessageContentEvent();
                    contentEvent.setMessageId(textMessageChunkEvent.getMessageId());
                    contentEvent.setDelta(textMessageChunkEvent.getDelta());
                    contentEvent.setTimestamp(event.getTimestamp());
                    subscriber.onTextMessageContentEvent(contentEvent);

                    this.messageFactory.addChunk(textMessageChunkEvent.getMessageId(), textMessageChunkEvent.getDelta());
                }
                case TEXT_MESSAGE_END -> {
                    var textMessageEndEvent = (TextMessageEndEvent)event;
                    subscriber.onTextMessageEndEvent(textMessageEndEvent);
                    var newMessage = this.messageFactory.getMessage(textMessageEndEvent.getMessageId());
                    this.addMessage(newMessage);
                    subscriber.onNewMessage(newMessage);
                }
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
                        System.out.println("Unhandled event type: " + event.getType());
                    }
                }
            }
        } catch (Exception e) {
            System.err.println("Error handling event type " + event.getType() + ": " + e.getMessage());
            if (debug) {
                e.printStackTrace();
            }
        }
    }

    protected void onInitialize(
        final RunAgentInput input,
        final List<AgentSubscriber> subscribers
    ) {
        subscribers.forEach(subscriber -> {
            try {
                subscriber.onRunInitialized(
                    new AgentSubscriberParams(
                        this.messages,
                        this.state,
                        this,
                        input
                    )
                );
            } catch (Exception e) {
                System.err.println("Error in subscriber.onRunInitialized: " + e.getMessage());
                if (debug) {
                    e.printStackTrace();
                }
            }
        });
    }

    public void addMessage(final BaseMessage message) {
        if (Objects.isNull(message.getId())) {
            message.setId(UUID.randomUUID().toString());
        }
        if (Objects.isNull(message.getName())) {
            message.setName("");
        }
        this.messages.add(message);

        this.agentSubscribers.forEach(subscriber -> {
            try {
                subscriber.onNewMessage(message);
            } catch (Exception e) {
                System.err.println("Error in message subscriber: " + e.getMessage());
                if (debug) {
                    e.printStackTrace();
                }
            }
        });

        // TODO: Fire onNewToolCall if the message is from assistant and contains tool calls
        // TODO: Fire onMessagesChanged sequentially
    }

    public void addMessages(final List<BaseMessage> messages) {
        messages.forEach(this::addMessage); // Fixed: was using this.messages instead of parameter
    }

    public void setMessages(final List<BaseMessage> messages) {
        this.messages = messages;

        this.agentSubscribers.forEach(subscriber -> {
            try {
                // TODO: Fire onMessagesChanged
            } catch (Exception e) {
                System.err.println("Error in messages changed subscriber: " + e.getMessage());
                if (debug) {
                    e.printStackTrace();
                }
            }
        });
    }

    public void setState(final State state) {
        this.state = state;

        this.agentSubscribers.forEach(subscriber -> {
            try {
                // TODO: Fire onStateChanged
            } catch (Exception e) {
                System.err.println("Error in state changed subscriber: " + e.getMessage());
                if (debug) {
                    e.printStackTrace();
                }
            }
        });
    }

    protected RunAgentInput prepareRunAgentInput(RunAgentParameters parameters) {
        return new RunAgentInput(
            this.threadId,
            Optional.ofNullable(parameters.getRunId()).orElse(UUID.randomUUID().toString()),
            this.state,
            this.messages,
            Optional.ofNullable(parameters.getTools()).orElse(Collections.emptyList()),
            Optional.ofNullable(parameters.getContext()).orElse(Collections.emptyList()),
            parameters.getForwardedProps()
        );
    }

    public State getState() {
        return this.state;
    }

}