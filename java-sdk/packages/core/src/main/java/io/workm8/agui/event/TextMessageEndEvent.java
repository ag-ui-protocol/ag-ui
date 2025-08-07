package io.workm8.agui.event;

import io.workm8.agui.type.EventType;

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
