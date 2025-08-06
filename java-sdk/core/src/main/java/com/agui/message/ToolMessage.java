package com.agui.message;

public class ToolMessage extends BaseMessage {

    private final String toolCallId;
    private final String error;

    public ToolMessage(final String id, final String content, final String name, final String toolCallId, final String error) {
        super(id, content, name);

        this.toolCallId = toolCallId;
        this.error = error;
    }

    public String getRole() {
        return "tool";
    }
}

