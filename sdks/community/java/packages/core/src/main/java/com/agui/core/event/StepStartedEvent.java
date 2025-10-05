package com.agui.core.event;

import com.agui.core.type.EventType;

/**
 * An event that represents the initiation of a specific step within a process or workflow.
 * <p>
 * This event is fired when an individual step in a larger execution sequence
 * begins. It provides granular tracking of progress within multi-step operations,
 * allowing for detailed monitoring and debugging of complex workflows.
 * </p>
 * <p>
 * The event automatically sets its type to {@link EventType#STEP_STARTED} and
 * captures the name of the step being initiated for identification purposes.
 * </p>
 *
 * @see BaseEvent
 * @see EventType#STEP_STARTED
 * @see StepFinishedEvent
 *
 * @author Pascal Wilbrink
 */
public class StepStartedEvent extends BaseEvent {

    private String stepName;

    /**
     * Creates a new StepStartedEvent with type set to {@link EventType#STEP_STARTED}.
     * <p>
     * The timestamp is automatically set to the current time and the step name
     * is initialized as null.
     * </p>
     */
    public StepStartedEvent() {
        super(EventType.STEP_STARTED);
    }

    /**
     * Sets the name of the step that is starting.
     *
     * @param stepName the name of the step being initiated. Can be null.
     */
    public void setStepName(final String stepName) {
        this.stepName = stepName;
    }

    /**
     * Returns the name of the step that is starting.
     *
     * @return the name of the step being initiated, can be null
     */
    public String getStepName() {
        return this.stepName;
    }
}