package io.workm8.agui.event;

import io.workm8.agui.type.EventType;

public class TextMessageChunkEvent extends BaseEvent {

    private String messageId;
    private String role;
    private String delta;

    public TextMessageChunkEvent() {
        super(EventType.TEXT_MESSAGE_CHUNK);
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

    public void setDelta(final String delta) {
        this.delta = delta;
    }

    public String getDelta() {
        return this.delta;
    }
}
