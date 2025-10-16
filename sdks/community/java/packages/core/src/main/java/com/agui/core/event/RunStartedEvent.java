package com.agui.core.event;

import com.agui.core.type.EventType;

/**
 * An event that represents the initiation of a run or execution.
 * <p>
 * This event is fired when a process, operation, or run cycle begins
 * execution. It captures essential tracking information including the
 * thread and run identifiers to enable monitoring and correlation with
 * subsequent events in the execution lifecycle.
 * </p>
 * <p>
 * The event automatically sets its type to {@link EventType#RUN_STARTED} and
 * provides fields to store the thread ID and run ID for tracking purposes.
 * </p>
 *
 * @see BaseEvent
 * @see EventType#RUN_STARTED
 * @see RunFinishedEvent
 * @see RunErrorEvent
 *
 * @author Pascal Wilbrink
 */
public class RunStartedEvent extends BaseEvent {

    private String threadId;
    private String runId;

    /**
     * Creates a new RunStartedEvent with type set to {@link EventType#RUN_STARTED}.
     * <p>
     * The timestamp is automatically set to the current time and both identifier
     * fields are initialized as null.
     * </p>
     */
    public RunStartedEvent() {
        super(EventType.RUN_STARTED);
    }

    /**
     * Sets the thread identifier where the run will be executed.
     *
     * @param threadId the thread identifier. Can be null.
     */
    public void setThreadId(final String threadId) {
        this.threadId = threadId;
    }

    /**
     * Returns the thread identifier where the run will be executed.
     *
     * @return the thread identifier, can be null
     */
    public String getThreadId() {
        return this.threadId;
    }

    /**
     * Sets the unique identifier for this run.
     *
     * @param runId the run identifier. Can be null.
     */
    public void setRunId(final String runId) {
        this.runId = runId;
    }

    /**
     * Returns the unique identifier for this run.
     *
     * @return the run identifier, can be null
     */
    public String getRunId() {
        return this.runId;
    }
}