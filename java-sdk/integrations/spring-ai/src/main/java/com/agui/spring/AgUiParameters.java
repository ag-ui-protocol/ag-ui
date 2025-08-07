package com.agui.spring;

import com.agui.message.BaseMessage;
import com.agui.types.Context;
import com.agui.types.Tool;

import java.util.List;

public class AgUiParameters {

    private String threadId;
    private List<Tool> tools;
    private List<Context> context;
    private Object forwardedProps;
    private List<BaseMessage> messages;

    public void setThreadId(final String threadId) {
        this.threadId = threadId;
    }

    public String getThreadId() {
        return this.threadId;
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
}
