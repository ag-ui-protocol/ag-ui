package com.agui.core.event;

import com.agui.core.type.EventType;

/**
 * An event for handling unprocessed or low-level system events.
 * <p>
 * This event type is designed to wrap raw, unfiltered event data that
 * hasn't been processed or transformed into more specific event types.
 * It automatically sets the event type to {@link EventType#RAW}.
 * </p>
 * <p>
 * Raw events typically contain the original event data in the inherited
 * {@link BaseEvent#setRawEvent(Object)} field and serve as a bridge
 * between external event sources and the application's event processing
 * pipeline.
 * </p>
 *
 * @see BaseEvent
 * @see EventType#RAW
 *
 * @author Pascal Wilbrink
 */
public class RawEvent extends BaseEvent {

    /**
     * Creates a new RawEvent with type set to {@link EventType#RAW}.
     * <p>
     * The timestamp is automatically set to the current time.
     * </p>
     */
    public RawEvent() {
        super(EventType.RAW);
    }
}