package io.workm8.spring;

import io.workm8.agui.message.BaseMessage;
import io.workm8.agui.state.State;
import io.workm8.agui.tool.Tool;
import io.workm8.agui.context.Context;

import java.util.List;

public class AgUiParameters {

    private String threadId;
    private String runId;
    private List<Tool> tools;
    private List<Context> context;
    private Object forwardedProps;
    private List<BaseMessage> messages;
    private State state;

    public void setThreadId(final String threadId) {
        this.threadId = threadId;
    }

    public String getThreadId() {
        return this.threadId;
    }

    public void setRunId(final String runId) {
        this.runId = runId;
    }

    public String getRunId() {
        return runId;
    }

    public void setTools(final List<Tool> tools) {
        this.tools = tools;
    }

    public List<Tool> getTools() {
        return tools;
    }

    public void setContext(final List<Context> context) {
        this.context = context;
    }

    public List<Context> getContext() {
        return this.context;
    }

    public void setForwardedProps(final Object forwardedProps) {
        this.forwardedProps = forwardedProps;
    }

    public Object getForwardedProps() {
        return this.forwardedProps;
    }

    public void setMessages(final List<BaseMessage> messages) {
        this.messages = messages;
    }

    public List<BaseMessage> getMessages() {
        return this.messages;
    }

    public void setState(State state) {
        this.state = state;
    }

    public State getState() {
        return state;
    }
}
