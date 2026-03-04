package com.agui.core.event;

import com.agui.core.type.EventType;

/**
 * An event that represents the successful completion of a run or execution.
 * <p>
 * This event is fired when a process, operation, or run cycle completes
 * successfully. It captures essential information about the completed run
 * including identifiers for tracking and the result of the execution.
 * </p>
 * <p>
 * The event automatically sets its type to {@link EventType#RUN_FINISHED} and
 * provides fields to store the thread ID, run ID, and execution result.
 * </p>
 *
 * @see BaseEvent
 * @see EventType#RUN_FINISHED
 *
 * @author Pascal Wilbrink
 */
public class RunFinishedEvent extends BaseEvent {

    private String threadId;
    private String runId;
    private Object result;

    /**
     * Creates a new RunFinishedEvent with type set to {@link EventType#RUN_FINISHED}.
     * <p>
     * The timestamp is automatically set to the current time and all fields
     * are initialized as null.
     * </p>
     */
    public RunFinishedEvent() {
        super(EventType.RUN_FINISHED);
    }

    /**
     * Sets the thread identifier where the run was executed.
     *
     * @param threadId the thread identifier. Can be null.
     */
    public void setThreadId(final String threadId) {
        this.threadId = threadId;
    }

    /**
     * Returns the thread identifier where the run was executed.
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

    /**
     * Sets the result produced by the completed run.
     *
     * @param result the execution result. Can be null.
     */
    public void setResult(final Object result) {
        this.result = result;
    }

    /**
     * Returns the result produced by the completed run.
     *
     * @return the execution result, can be null
     */
    public Object getResult() {
        return this.result;
    }
}