package io.workm8.agui.event;

import io.workm8.agui.type.EventType;

public class StepStartedEvent extends BaseEvent {

    public StepStartedEvent() {
        super(EventType.STEP_STARTED);
    }
}
