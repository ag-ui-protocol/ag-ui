package com.agui.event;

import com.agui.types.EventType;

public class TextMessageChunkEvent extends BaseEvent {

    private final String messageId;
    private final String role;
    private final String delta;

    public TextMessageChunkEvent(final String messageId, final String role, final String delta) {
        super(EventType.TEXT_MESSAGE_CHUNK);

        this.messageId = messageId;
        this.role = role;
        this.delta = delta;
    }

    public String getMessageId() {
        return this.messageId;
    }

    public String getRole() {
        return this.role;
    }

    public String getDelta() {
        return this.delta;
    }
}
