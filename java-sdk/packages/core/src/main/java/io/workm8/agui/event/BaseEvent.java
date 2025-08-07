package io.workm8.agui.event;

import io.workm8.agui.type.EventType;

public class BaseEvent {

    private final EventType type;

    private int timestamp;

    private Object rawEvent;

    public BaseEvent(final EventType type) {
        this.type = type;
    }

    public EventType getType() {
        return this.type;
    }

    public void setTimestamp(final int timestamp) {
        this.timestamp = timestamp;
    }

    public int getTimestamp() {
        return this.timestamp;
    }

    public void setRawEvent(final Object rawEvent) {
        this.rawEvent = rawEvent;
    }

    public Object getRawEvent() {
        return this.rawEvent;
    }
}

