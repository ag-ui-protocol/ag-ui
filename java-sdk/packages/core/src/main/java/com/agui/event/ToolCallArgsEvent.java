package com.agui.event;

import com.agui.types.EventType;

public class ToolCallArgsEvent extends BaseEvent {

    private String toolCallId;
    private String delta;

    public ToolCallArgsEvent() {
        super(EventType.TOOL_CALL_ARGS);
    }

    public void setToolCallId(final String toolCallId) {
        this.toolCallId = toolCallId;
    }

    public String getToolCallId() {
        return this.toolCallId;
    }

    public void setDelta(final String delta) {
        this.delta = delta;
    }

    public String getDelta() {
        return this.delta;
    }
}
