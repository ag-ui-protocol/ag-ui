package com.agui.client;

import com.agui.client.subscriber.AgentSubscriber;
import com.agui.client.subscriber.AgentSubscriberParams;
import com.agui.event.*;
import com.agui.message.BaseMessage;
import com.agui.types.RunAgentInput;
import com.agui.types.State;
import io.reactivex.Observable;

import java.util.*;

public abstract class AbstractAgent {

    private String agentId;
    private String description;
    private String threadId;
    private List<BaseMessage> messages;
    private State state;
    private boolean debug = false;

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

    protected abstract Observable<BaseEvent> run(final RunAgentInput input);


    public void runAgent(RunAgentParameters parameters) {
        this.runAgent(parameters, null);
    }

    public void runAgent(
        RunAgentParameters parameters,
        AgentSubscriber subscriber
    ) {
        this.agentId = Objects.nonNull(this.agentId) ? this.agentId : UUID.randomUUID().toString();

        var input = this.prepareRunAgentInput(parameters);
        Object result = null;

        List<AgentSubscriber> subscribers = new ArrayList<>();
        subscribers.add(
            new AgentSubscriber() {
                @Override
                public void onRunFinishedEvent(RunFinishedEvent event) {
                    //result = event.getResult();
                }
            }
        );

        if (Objects.nonNull(subscriber)) {
            subscribers.add(subscriber);
        }
        subscribers.addAll(this.agentSubscribers);

        this.onInitialize(input, subscribers);

        this.run(input)
            .map((event) -> {
                subscribers.forEach((s) -> {
                    s.onEvent(event);
                });

                switch (event.getType()) {
                    case RUN_STARTED -> subscriber.onRunStartedEvent((RunStartedEvent) event);
                    case RUN_ERROR -> subscriber.onRunErrorEvent((RunErrorEvent) event);
                    case RUN_FINISHED -> subscriber.onRunFinishedEvent((RunFinishedEvent) event);
                    case STEP_STARTED -> subscriber.onStepStartedEvent((StepStartedEvent) event);
                    case STEP_FINISHED -> subscriber.onStepFinishedEvent((StepFinishedEvent) event);
                    case TEXT_MESSAGE_START -> subscriber.onTextMessageStartEvent((TextMessageStartEvent) event);
                    case TEXT_MESSAGE_CONTENT -> subscriber.onTextMessageContentEvent((TextMessageContentEvent) event);
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
                }

                return event;
            })
            .doFinally(() -> {
                subscribers.forEach(s -> {
                    var params = new AgentSubscriberParams(
                        this.messages,
                            this.state,
                            this,
                            input
                    );
                    s.onRunFinalized(params);
                });
                System.out.println("parameters = " + parameters + ", subscriber = " + subscriber);
            }).subscribe();
/*
        () => this.run(input),
                transformChunks(this.debug),
                verifyEvents(this.debug),
                (source$) => this.apply(input, source$, subscribers),
                (source$) => this.processApplyEvents(input, source$, subscribers),
                catchError((error) => {
        return this.onError(input, error, subscribers);
      }),
        finalize(() => {
        void this.onFinalize(input, subscribers);
      }),
*/
    }


    protected void onInitialize(
        final RunAgentInput input,
        final List<AgentSubscriber> subscribers
    ) {
        subscribers.forEach(subscriber -> subscriber.onRunInitialized(
            new AgentSubscriberParams(
                this.messages,
                this.state,
                this,
                input
            )
        ));
    }

    public void addMessage(final BaseMessage message) {
        this.messages.add(message);

        this.agentSubscribers
                .forEach((subscriber -> {
                    // On new message

                }));

        // Fire onNewToolCall if the message is from assistant and contains tool calls


        // Fire onMessagesChanged sequentially
    }

    public void addMessages(final List<BaseMessage> messages) {
        this.messages.forEach(this::addMessage);
    }

    public void setMessages(final List<BaseMessage> messages) {
        this.messages = messages;

        this.agentSubscribers
                .forEach((subscriber -> {
                    // Fire onMessagesChanged
                }));
    }

    public void setState(final State state) {
        this.state = state;

        this.agentSubscribers
                .forEach(subscriber -> {
                    // Fire onStateChanged
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