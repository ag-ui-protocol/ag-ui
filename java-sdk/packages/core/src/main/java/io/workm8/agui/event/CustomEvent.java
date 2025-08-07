package io.workm8.agui.event;

import io.workm8.agui.type.EventType;

public class CustomEvent extends BaseEvent {

    public CustomEvent() {
        super(EventType.CUSTOM);
    }
}
