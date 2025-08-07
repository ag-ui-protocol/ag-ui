package io.workm8.agui.event;

import io.workm8.agui.type.EventType;

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
