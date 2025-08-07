package io.workm8.agui.event;

import io.workm8.agui.type.EventType;

public class ToolCallResultEvent extends BaseEvent {

    private String toolCallId;
    private String content;
    private String messageId;
    private String role;

    public ToolCallResultEvent() {
        super(EventType.TOOL_CALL_RESULT);
    }

    public void setToolCallId(final String toolCallId) {
        this.toolCallId = toolCallId;
    }

    public String getToolCallId() {
        return this.toolCallId;
    }

    public void setContent(final String content) {
        this.content = content;
    }

    public String getContent() {
        return this.content;
    }

    public void setMessageId(final String messageId) {
        this.messageId = messageId;
    }

    public String getMessageId() {
        return this.messageId;
    }

    public void setRole(final String role) {
        this.role = role;
    }

    public String getRole() {
        return this.role;
    }
}
