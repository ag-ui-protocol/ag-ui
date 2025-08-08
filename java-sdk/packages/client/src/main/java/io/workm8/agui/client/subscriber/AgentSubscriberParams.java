package io.workm8.agui.client.subscriber;

import io.workm8.agui.client.AbstractAgent;

import io.workm8.agui.state.State;
import io.workm8.agui.message.BaseMessage;
import io.workm8.agui.input.RunAgentInput;

import java.util.List;

public record AgentSubscriberParams(List<BaseMessage> messages, State state, AbstractAgent agent, RunAgentInput input) { }
