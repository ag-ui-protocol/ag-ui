package com.agui.client.subscriber;

import com.agui.client.State;
import com.agui.message.BaseMessage;

import java.util.List;

public class AgentStateMutation {

    private List<BaseMessage> messages;
    private State state;
    private boolean stopPropagation;
}
