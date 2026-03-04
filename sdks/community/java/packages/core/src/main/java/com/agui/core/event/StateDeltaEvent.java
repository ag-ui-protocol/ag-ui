package com.agui.core.event;

import com.agui.core.type.EventType;

/**
 * An event that represents a change or delta in the application state.
 * <p>
 * This event is fired when there are incremental changes to the system state
 * that need to be communicated or processed. Unlike full state snapshots,
 * this event represents only the changes (deltas) that have occurred.
 * </p>
 * <p>
 * The event automatically sets its type to {@link EventType#STATE_DELTA} and
 * can carry the actual state change data through the inherited
 * {@link BaseEvent#setRawEvent(Object)} method.
 * </p>
 *
 * @see BaseEvent
 * @see EventType#STATE_DELTA
 *
 * @author Pascal Wilbrink
 */
public class StateDeltaEvent extends BaseEvent {

    /**
     * Creates a new StateDeltaEvent with type set to {@link EventType#STATE_DELTA}.
     * <p>
     * The timestamp is automatically set to the current time.
     * </p>
     */
    public StateDeltaEvent() {
        super(EventType.STATE_DELTA);
    }
}