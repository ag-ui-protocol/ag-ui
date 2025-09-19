package com.agui.event;

import com.agui.types.EventType;

public class TextMessageContentEvent extends BaseEvent {

    private String messageId;
    private String delta;

    public TextMessageContentEvent() {
        super(EventType.TEXT_MESSAGE_CONTENT);
    }

    public void setMessageId(final String messageId) {
        this.messageId = messageId;
    }

    public String getMessageId() {
        return this.messageId;
    }

    public void setDelta(final String delta) {
        this.delta = delta;
    }

    public String getDelta() {
        return this.delta;
    }
}
