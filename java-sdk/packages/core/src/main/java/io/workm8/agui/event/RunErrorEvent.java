package io.workm8.agui.event;

import io.workm8.agui.type.EventType;

public class RunErrorEvent extends BaseEvent {

    private String error;

    public RunErrorEvent() {
        super(EventType.RUN_ERROR);
    }

    public void setError(final String error) {
        this.error = error;
    }

    public String getError() {
        return this.error;
    }
}
