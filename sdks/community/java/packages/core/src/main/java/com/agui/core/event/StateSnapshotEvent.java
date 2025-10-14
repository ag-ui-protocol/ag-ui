package com.agui.core.event;

import com.agui.core.state.State;
import com.agui.core.type.EventType;

/**
 * An event that represents a complete snapshot of the application state.
 * <p>
 * This event is fired when a full capture of the current system state is
 * needed, typically for synchronization, debugging, or state restoration
 * purposes. Unlike delta events, this represents the complete state at
 * a specific point in time.
 * </p>
 * <p>
 * The event automatically sets its type to {@link EventType#STATE_SNAPSHOT} and
 * can carry the actual state data through the inherited
 * {@link BaseEvent#setRawEvent(Object)} method.
 * </p>
 *
 * @see BaseEvent
 * @see EventType#STATE_SNAPSHOT
 * @see StateDeltaEvent
 *
 * @author Pascal Wilbrink
 */
public class StateSnapshotEvent extends BaseEvent {

    private State state;

    /**
     * Creates a new StateSnapshotEvent with type set to {@link EventType#STATE_SNAPSHOT}.
     * <p>
     * The timestamp is automatically set to the current time.
     * </p>
     */
    public StateSnapshotEvent() {
        super(EventType.STATE_SNAPSHOT);
    }

    public void setState(final State state) {
        this.state = state;
    }

    public State getState() {
        return state;
    }
}