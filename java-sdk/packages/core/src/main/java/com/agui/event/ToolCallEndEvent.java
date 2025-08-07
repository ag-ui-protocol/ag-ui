package com.agui.event;

import com.agui.types.EventType;

public class ToolCallEndEvent extends BaseEvent {

    private String toolCallId;

    public ToolCallEndEvent() {
        super(EventType.TOOL_CALL_END);
    }

    public void setToolCallId(final String toolCallId) {
        this.toolCallId = toolCallId;
    }

    public String getToolCallId() {
        return this.toolCallId;
    }
}
