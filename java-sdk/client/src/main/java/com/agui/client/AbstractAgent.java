package com.agui.client;

import com.agui.client.subscriber.AgentStateMutation;
import com.agui.client.subscriber.AgentSubscriber;
import com.agui.client.subscriber.AgentSubscriberParams;
import com.agui.event.BaseEvent;
import com.agui.event.RunFinishedEvent;
import com.agui.message.BaseMessage;
import com.agui.types.RunAgentInput;
import io.reactivex.Observable;
import io.reactivex.internal.operators.observable.ObservableAny;

import javax.swing.plaf.basic.BasicListUI;
import java.util.*;
import java.util.concurrent.CompletableFuture;

import static java.util.Arrays.asList;

public abstract class AbstractAgent {

    private String agentId;
    private String description;
    private String threadId;
    private List<BaseMessage> messages;
    private State state;
    private boolean debug = false;

    private List<AgentSubscriber> agentSubscribers = new ArrayList<>();

    public AbstractAgent(
        String agentId,
        String description,
        String threadId,
        List<BaseMessage> messages,
        State state,
        boolean debug
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


    public CompletableFuture<RunAgentResult> runAgent(
        RunAgentParameters parameters,
        AgentSubscriber subscriber
    ) {
        this.agentId = Objects.nonNull(this.agentId) ? this.agentId : UUID.randomUUID().toString();

        var input = this.prepareRunAgentInput(parameters);
        Object result = null;

        List<AgentSubscriber> subscribers = asList(
            new AgentSubscriber() {
                @Override
                public CompletableFuture<AgentStateMutation> onRunFinishedEvent(AgentSubscriberParams params, RunFinishedEvent event) {
                    //result = event.getResult();

                    return CompletableFuture.completedFuture(null);
                }
            },
            subscriber
        );
        subscribers.addAll(this.agentSubscribers);

        this.onInitialize(input, subscribers);

        return null;
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