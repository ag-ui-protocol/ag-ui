package com.agui.event;

import com.agui.types.EventType;

public class CustomEvent extends BaseEvent {

    public CustomEvent() {
        super(EventType.CUSTOM);
    }
}
