package io.workm8.agui.event;

import io.workm8.agui.type.EventType;

public class RunFinishedEvent extends BaseEvent {

    private String threadId;
    private String runId;
    private Object result;

    public RunFinishedEvent() {
        super(EventType.RUN_FINISHED);
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

    public void setResult(final Object result) {
        this.result = result;
    }

    public Object getResult() {
        return this.result;
    }
}