package com.agui.event;

import com.agui.types.EventType;

public class StepFinishedEvent extends BaseEvent {

    public StepFinishedEvent() {
        super(EventType.STEP_FINISHED);
    }
}
