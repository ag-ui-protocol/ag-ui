package com.agui.event;

import com.agui.types.EventType;

public class StateSnapshotEvent extends BaseEvent {

    public StateSnapshotEvent() {
        super(EventType.STATE_SNAPSHOT);
    }
}
