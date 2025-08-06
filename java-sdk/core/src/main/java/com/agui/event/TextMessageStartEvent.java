package com.agui.event;

import com.agui.types.EventType;

public class TextMessageStartEvent extends BaseEvent {

    public TextMessageStartEvent() {
        super(EventType.TEXT_MESSAGE_START);
    }
}
