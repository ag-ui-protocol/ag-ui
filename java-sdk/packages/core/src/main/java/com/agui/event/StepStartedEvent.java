package com.agui.event;

import com.agui.types.EventType;

public class StepStartedEvent extends BaseEvent {

    public StepStartedEvent() {
        super(EventType.STEP_STARTED);
    }
}
