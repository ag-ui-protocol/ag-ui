package com.agui.client.subscriber;

import com.agui.client.AbstractAgent;

import com.agui.client.State;
import com.agui.message.BaseMessage;
import com.agui.types.RunAgentInput;

import java.util.List;

public class AgentSubscriberParams {

    private List<BaseMessage> messages;
    private State state;
    private AbstractAgent agent;
    private RunAgentInput input;

    public AgentSubscriberParams(
        final List<BaseMessage> messages,
        final State state,
        final AbstractAgent agent,
        final RunAgentInput input
    ) {
        this.messages = messages;
        this.state = state;
        this.agent = agent;
        this.input = input;
    }

    public List<BaseMessage> getMessages() {
        return this.messages;
    }

    public State getState() {
        return this.state;
    }

    public AbstractAgent getAgent() {
        return this.agent;
    }

    public RunAgentInput getInput() {
        return this.input;
    }
}

