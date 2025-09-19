package com.agui.event;

import com.agui.types.EventType;

public class ThinkingStartEvent extends BaseEvent {

    public ThinkingStartEvent() {
        super(EventType.THINKING_START);
    }
}
