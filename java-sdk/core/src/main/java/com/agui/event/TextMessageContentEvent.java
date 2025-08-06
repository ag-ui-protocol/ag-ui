package com.agui.event;

import com.agui.types.EventType;

public class TextMessageContentEvent extends BaseEvent {

    public TextMessageContentEvent() {
        super(EventType.TEXT_MESSAGE_CONTENT);
    }
}
