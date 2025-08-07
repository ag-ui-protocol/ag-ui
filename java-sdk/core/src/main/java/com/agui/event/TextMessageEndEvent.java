package com.agui.event;

import com.agui.types.EventType;

public class TextMessageEndEvent extends BaseEvent {

    private String messageId;

    public TextMessageEndEvent() {
        super(EventType.TEXT_MESSAGE_END);
    }

    public void setMessageId(final String messageId) {
        this.messageId = messageId;
    }

    public String getMessageId() {
        return this.messageId;
    }

}
