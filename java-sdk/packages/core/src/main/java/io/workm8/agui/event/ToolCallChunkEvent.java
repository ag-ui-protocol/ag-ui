package io.workm8.agui.event;

import io.workm8.agui.type.EventType;

public class ToolCallChunkEvent extends BaseEvent {

    private final String toolCallId;
    private final String toolCallName;
    private final String parentMessageId;
    private final String delta;

    public ToolCallChunkEvent(final String toolCallId, final String toolCallName, final String parentMessageId, final String delta) {
        super(EventType.TOOL_CALL_CHUNK);

        this.toolCallId = toolCallId;
        this.toolCallName = toolCallName;

        this.parentMessageId = parentMessageId;
        this.delta = delta;
    }

    public String getToolCallId() {
        return this.toolCallId;
    }

    public String getToolCallName() {
        return this.toolCallName;
    }

    public String getParentMessageId() {
        return this.parentMessageId;
    }

    public String getDelta() {
        return this.delta;
    }
}
