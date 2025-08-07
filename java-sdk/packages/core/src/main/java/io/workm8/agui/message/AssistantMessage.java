package io.workm8.agui.message;

import io.workm8.agui.tool.ToolCall;

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
