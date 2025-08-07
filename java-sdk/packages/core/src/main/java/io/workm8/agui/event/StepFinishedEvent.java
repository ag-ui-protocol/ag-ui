package io.workm8.agui.event;

import io.workm8.agui.type.EventType;

public class StepFinishedEvent extends BaseEvent {

    public StepFinishedEvent() {
        super(EventType.STEP_FINISHED);
    }
}
