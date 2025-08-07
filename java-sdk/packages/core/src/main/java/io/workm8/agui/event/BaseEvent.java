package io.workm8.agui.event;

import io.workm8.agui.type.EventType;

import java.time.Instant;

public abstract class BaseEvent {

    private final EventType type;

    private long timestamp;

    private Object rawEvent;

    public BaseEvent(final EventType type) {
        this.type = type;
        this.timestamp = Instant.now().toEpochMilli();
    }

    public EventType getType() {
        return this.type;
    }

    public void setTimestamp(final long timestamp) {
        this.timestamp = timestamp;
    }

    public long getTimestamp() {
        return this.timestamp;
    }

    public void setRawEvent(final Object rawEvent) {
        this.rawEvent = rawEvent;
    }

    public Object getRawEvent() {
        return this.rawEvent;
    }
}

