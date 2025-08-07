package io.workm8.agui.event;

import io.workm8.agui.type.EventType;

public class StateDeltaEvent extends BaseEvent {

    public StateDeltaEvent() {
        super(EventType.STATE_DELTA);
    }
}
