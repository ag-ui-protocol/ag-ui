package com.agui.types;

import com.agui.message.BaseMessage;

import java.util.List;

public class RunAgentInput {

    private final String threadId;
    private final String runId;
    private final Object state;
    private final List<BaseMessage> messages;
    private final List<Tool> tools;
    private final List<Context> context;
    private final Object forwardedProps;

    public RunAgentInput(
        final String threadId,
        final String runId,
        final Object state,
        final List<BaseMessage> messages,
        final List<Tool> tools,
        final List<Context> context,
        final Object forwardedProps
    ) {
        this.threadId = threadId;
        this.runId = runId;
        this.state = state;
        this.messages = messages;
        this.tools = tools;
        this.context = context;
        this.forwardedProps = forwardedProps;
    }

    public String getThreadId() {
        return this.threadId;
    }

    public String getRunId() {
        return this.runId;
    }

    public Object getState() {
        return this.state;
    }

    public List<BaseMessage> getMessages() {
        return this.messages;
    }

    public List<Tool> getTools() {
        return this.tools;
    }

    public List<Context> getContext() {
        return this.context;
    }

    public Object getForwardedProps() {
        return this.forwardedProps;
    }
}

