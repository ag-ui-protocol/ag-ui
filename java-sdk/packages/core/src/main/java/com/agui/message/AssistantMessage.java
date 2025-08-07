package com.agui.message;

import com.agui.types.ToolCall;

import java.util.ArrayList;
import java.util.List;

public class AssistantMessage extends BaseMessage {

    private List<ToolCall> toolCalls = new ArrayList<>();

    public String getRole() {
        return "assistant";
    }

    public void setToolCalls(final List<ToolCall> toolCalls) {
        this.toolCalls = toolCalls;
    }

    public List<ToolCall> getToolCalls() {
        return this.toolCalls;
    }
}
