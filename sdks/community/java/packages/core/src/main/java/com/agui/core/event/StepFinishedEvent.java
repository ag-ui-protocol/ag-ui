package com.agui.core.event;

import com.agui.core.type.EventType;

/**
 * An event that represents the completion of a specific step within a process or workflow.
 * <p>
 * This event is fired when an individual step in a larger execution sequence
 * completes successfully. It provides granular tracking of progress within
 * multi-step operations, allowing for detailed monitoring and debugging of
 * complex workflows.
 * </p>
 * <p>
 * The event automatically sets its type to {@link EventType#STEP_FINISHED} and
 * captures the name of the completed step for identification purposes.
 * </p>
 *
 * @see BaseEvent
 * @see EventType#STEP_FINISHED
 * @see StepStartedEvent
 *
 * @author Pascal Wilbrink
 */
public class StepFinishedEvent extends BaseEvent {

    private String stepName;

    /**
     * Creates a new StepFinishedEvent with type set to {@link EventType#STEP_FINISHED}.
     * <p>
     * The timestamp is automatically set to the current time and the step name
     * is initialized as null.
     * </p>
     */
    public StepFinishedEvent() {
        super(EventType.STEP_FINISHED);
    }

    /**
     * Sets the name of the step that has finished.
     *
     * @param stepName the name of the completed step. Can be null.
     */
    public void setStepName(final String stepName) {
        this.stepName = stepName;
    }

    /**
     * Returns the name of the step that has finished.
     *
     * @return the name of the completed step, can be null
     */
    public String getStepName() {
        return this.stepName;
    }
}