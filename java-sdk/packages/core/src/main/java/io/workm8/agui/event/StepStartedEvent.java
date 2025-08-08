package io.workm8.agui.event;

import io.workm8.agui.type.EventType;

public class StepStartedEvent extends BaseEvent {

    private String stepName;

    public StepStartedEvent() {
        super(EventType.STEP_STARTED);
    }

    public void setStepName(final String stepName) {
        this.stepName = stepName;
    }

    public String getStepName() {
        return this.stepName;
    }
}
