package com.agui.core.event;

import com.agui.core.type.EventType;

import javax.validation.constraints.NotNull;
import java.time.Instant;
import java.util.Objects;

/**
 * Abstract base class for all events that the AG-UI protocol can emit.
 * <p>
 * This class provides common functionality for events including type identification,
 * timestamp tracking, and raw event data storage. All concrete event implementations
 * should extend this base class to ensure consistent event handling.
 * </p>
 * <p>
 * The timestamp is automatically set to the current time when the event is created,
 * but can be overridden if needed. The raw event object can store the original
 * event data from external sources.
 * </p>
 *
 * @author Pascal Wilbrink
 */
public abstract class BaseEvent {

    private final EventType type;

    private long timestamp;

    private Object rawEvent;

    /**
     * Creates a new BaseEvent with the specified type.
     * <p>
     * The timestamp is automatically set to the current time in milliseconds
     * since epoch.
     * </p>
     *
     * @param type the type of this event. Cannot be null.
     * @throws NullPointerException if type is null
     */
    public BaseEvent(@NotNull final EventType type) {
        Objects.requireNonNull(type, "type cannot be null");
        this.type = type;
        this.timestamp = Instant.now().toEpochMilli();
    }

    /**
     * Returns the type of this event.
     *
     * @return the event type, never null
     */
    public EventType getType() {
        return this.type;
    }

    /**
     * Sets the timestamp for this event.
     *
     * @param timestamp the timestamp in milliseconds since epoch
     */
    public void setTimestamp(final long timestamp) {
        this.timestamp = timestamp;
    }

    /**
     * Returns the timestamp when this event occurred.
     *
     * @return the timestamp in milliseconds since epoch
     */
    public long getTimestamp() {
        return this.timestamp;
    }

    /**
     * Sets the raw event object containing the original event data.
     *
     * @param rawEvent the raw event data, can be null
     */
    public void setRawEvent(final Object rawEvent) {
        this.rawEvent = rawEvent;
    }

    /**
     * Returns the raw event object containing the original event data.
     *
     * @return the raw event data, can be null
     */
    public Object getRawEvent() {
        return this.rawEvent;
    }
}

