package com.agui.event;

import com.agui.types.EventType;

public class RunFinishedEvent extends BaseEvent {

    private final String threadId;
    private final String runId;
    private final Object result;

    public RunFinishedEvent(
            final String threadId,
            final String runId,
            final Object result
    ) {
        super(EventType.RUN_FINISHED);

        this.threadId = threadId;
        this.runId = runId;
        this.result = result;
    }

    public String getThreadId() {
        return this.threadId;
    }

    public String getRunId() {
        return this.runId;
    }

    public Object getResult() {
        return this.result;
    }
}