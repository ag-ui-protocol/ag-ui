package com.agui.event;

import com.agui.types.EventType;

public class MessagesSnapshotEvent extends BaseEvent {

    public MessagesSnapshotEvent() {
        super(EventType.MESSAGES_SNAPSHOT);
    }
}
