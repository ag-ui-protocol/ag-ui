package com.agui.event;

import com.agui.types.EventType;

public class RunStartedEvent extends BaseEvent {

    public RunStartedEvent() {
        super(EventType.RUN_STARTED);
    }
}
