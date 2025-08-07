package com.agui.event;

import com.agui.types.EventType;

public class RunStartedEvent extends BaseEvent {

    private String threadId;

    private String runId;

    public RunStartedEvent() {
        super(EventType.RUN_STARTED);
    }

    public void setThreadId(final String threadId) {
        this.threadId = threadId;
    }

    public String getThreadId() {
        return this.threadId;
    }

    public void setRunId(final String runId) {
        this.runId = runId;
    }

    public String getRunId() {
        return this.runId;
    }
}
