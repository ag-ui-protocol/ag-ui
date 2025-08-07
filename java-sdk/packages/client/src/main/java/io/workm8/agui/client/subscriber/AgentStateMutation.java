package io.workm8.agui.client.subscriber;

import io.workm8.agui.type.State;
import io.workm8.agui.message.BaseMessage;

import java.util.List;

public class AgentStateMutation {

    private List<BaseMessage> messages;
    private State state;
    private boolean stopPropagation;
}
