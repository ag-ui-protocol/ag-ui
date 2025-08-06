package com.agui.event;

import com.agui.types.EventType;

public class TextMessageEndEvent extends BaseEvent {

    public TextMessageEndEvent() {
        super(EventType.TEXT_MESSAGE_END);
    }
}
