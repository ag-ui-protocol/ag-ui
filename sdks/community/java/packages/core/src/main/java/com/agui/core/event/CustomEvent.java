package com.agui.core.event;

import com.agui.core.type.EventType;

/**
 * A concrete implementation of BaseEvent for custom user-defined events.
 * <p>
 * This event type is intended for application-specific events that don't
 * fit into the standard predefined event categories. It automatically
 * sets the event type to {@link EventType#CUSTOM}.
 * </p>
 * <p>
 * Custom events can carry additional data through the inherited
 * {@link BaseEvent#setRawEvent(Object)} method to store domain-specific
 * event information.
 * </p>
 *
 * @see BaseEvent
 * @see EventType#CUSTOM
 *
 * @author Pascal Wilbrink
 */
public class CustomEvent extends BaseEvent {

    /**
     * Creates a new CustomEvent with type set to {@link EventType#CUSTOM}.
     * <p>
     * The timestamp is automatically set to the current time.
     * </p>
     */
    public CustomEvent() {
        super(EventType.CUSTOM);
    }
}