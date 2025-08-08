package io.workm8.agui.client.subscriber;

import io.workm8.agui.state.State;
import io.workm8.agui.message.BaseMessage;

import java.util.List;

public record AgentStateMutation(List<BaseMessage> messages, State state, boolean stopPropagation) { }