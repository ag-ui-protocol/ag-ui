package io.workm8.agui.client;

import io.workm8.agui.client.subscriber.AgentSubscriber;
import io.workm8.agui.client.subscriber.AgentSubscriberParams;
import io.workm8.agui.message.BaseMessage;
import io.workm8.agui.type.RunAgentInput;
import io.workm8.agui.type.State;
import io.workm8.agui.event.*;

import java.util.*;
import java.util.concurrent.CompletableFuture;
import java.util.function.Consumer;

public abstract class AbstractAgent {

    protected String agentId;
    protected String description;
    protected String threadId;
    protected List<BaseMessage> messages;
    protected State state;
    protected boolean debug = false;

    private final List<AgentSubscriber> agentSubscribers = new ArrayList<>();

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
    }

    public Subscription subscribe(final AgentSubscriber subscriber) {
        this.agentSubscribers.add(subscriber);
        return () -> this.agentSubscribers.remove(subscriber);
    }

    protected abstract CompletableFuture<Void> run(final RunAgentInput input, Consumer<BaseEvent> eventHandler);

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

        Consumer<BaseEvent> eventHandler = event -> {
            try {
                subscribers.forEach(s -> {
                    try {
                        s.onEvent(event);
                    } catch (Exception e) {
                        System.err.println("Error in subscriber.onEvent: " + e.getMessage());
                        if (debug) {
                            e.printStackTrace();
                        }
                    }
                });

                if (Objects.nonNull(subscriber)) {
                    handleEventByType(event, subscriber);
                }
            } catch (Exception e) {
                System.err.println("Error handling event: " + e.getMessage());
                if (debug) {
                    e.printStackTrace();
                }
            }
        };

        return this.run(input, eventHandler)
                .whenComplete((result, throwable) -> {
                    try {
                        subscribers.forEach(s -> {
                            try {
                                var params = new AgentSubscriberParams(
                                    this.messages,
                                    this.state,
                                    this,
                                    input
                                );
                                s.onRunFinalized(params);
                            } catch (Exception e) {
                                System.err.println("Error in subscriber.onRunFinalized: " + e.getMessage());
                                if (debug) {
                                    e.printStackTrace();
                                }
                            }
                        });

                        if (debug) {
                            System.out.println("Agent run completed - parameters = " + parameters + ", subscriber = " + subscriber);
                        }

                        if (throwable != null) {
                            System.err.println("Agent run completed with error: " + throwable.getMessage());
                            if (debug) {
                                throwable.printStackTrace();
                            }
                        }
                    } catch (Exception e) {
                        System.err.println("Error in completion handler: " + e.getMessage());
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
                case TEXT_MESSAGE_START -> subscriber.onTextMessageStartEvent((TextMessageStartEvent) event);
                case TEXT_MESSAGE_CONTENT -> subscriber.onTextMessageContentEvent((TextMessageContentEvent) event);
                case TEXT_MESSAGE_CHUNK -> {
                    var contentEvent = new TextMessageContentEvent();
                    contentEvent.setMessageId(((TextMessageChunkEvent)event).getMessageId());
                    contentEvent.setDelta(((TextMessageChunkEvent)event).getDelta());
                    contentEvent.setTimestamp(event.getTimestamp());
                    subscriber.onTextMessageContentEvent(contentEvent);
                }
                case TEXT_MESSAGE_END -> subscriber.onTextMessageEndEvent((TextMessageEndEvent) event);
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
            parameters.getRunId().orElse(UUID.randomUUID().toString()),
            this.state,
            this.messages,
            parameters.getTools().orElse(Collections.emptyList()),
            parameters.getContext().orElse(Collections.emptyList()),
            parameters.getForwardedProps().orElse(null)
        );
    }

    public State getState() {
        return this.state;
    }

}