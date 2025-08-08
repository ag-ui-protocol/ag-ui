package io.workm8.agui.event;

import io.workm8.agui.type.EventType;

public class StepFinishedEvent extends BaseEvent {

    private String stepName;

    public StepFinishedEvent() {
        super(EventType.STEP_FINISHED);
    }

    public void setStepName(final String stepName) {
        this.stepName = stepName;
    }

    public String getStepName() {
        return this.stepName;
    }
}
