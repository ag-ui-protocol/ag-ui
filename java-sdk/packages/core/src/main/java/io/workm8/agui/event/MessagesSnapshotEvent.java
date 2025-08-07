package io.workm8.agui.event;

import io.workm8.agui.message.BaseMessage;
import io.workm8.agui.type.EventType;

import java.util.List;

public class MessagesSnapshotEvent extends BaseEvent {

    private List<BaseMessage> messages;

    public MessagesSnapshotEvent() {
        super(EventType.MESSAGES_SNAPSHOT);
    }

    public void setMessages(final List<BaseMessage> messages) {
        this.messages = messages;
    }

    public List<BaseMessage> getMessages() {
        return this.messages;
    }

}
