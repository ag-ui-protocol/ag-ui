package com.agui.event;

import com.agui.types.EventType;

public class StateDeltaEvent extends BaseEvent {

    public StateDeltaEvent() {
        super(EventType.STATE_DELTA);
    }
}
