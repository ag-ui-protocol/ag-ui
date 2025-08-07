package com.agui.event;

import com.agui.types.EventType;

public class RunErrorEvent extends BaseEvent {

    public RunErrorEvent() {
        super(EventType.RUN_ERROR);
    }
}
