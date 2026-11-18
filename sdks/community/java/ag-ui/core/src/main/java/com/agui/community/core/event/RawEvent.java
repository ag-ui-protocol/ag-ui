package com.agui.community.core.event;

import java.util.Objects;

/**
 * Wraps an original event from an external system, passed through without
 * transformation.
 *
 * @param event     the original external event data (required)
 * @param source    the source system identifier, or {@code null} (optional)
 * @param timestamp the event creation time in epoch milliseconds, or
 *                  {@code null} (optional)
 * @param rawEvent  the original event this was transformed from, or
 *                  {@code null} (optional)
 * @param subagentRunId the producing subagent invocation, or {@code null} for
 *                       output from the parent agent (optional)
 * @see <a href="https://docs.ag-ui.com/concepts/events">AG-UI Events</a>
 */
public record RawEvent(Object event, String source, Long timestamp, Object rawEvent,
                       String subagentRunId)
        implements Event {

    public RawEvent {
        Objects.requireNonNull(event, "event must not be null");
    }

    /** Creates an event without subagent attribution using the original signature. */
    public RawEvent(Object event, String source, Long timestamp, Object rawEvent) {
        this(event, source, timestamp, rawEvent, null);
    }

    /**
     * Creates a raw event from external event data.
     *
     * @param event the original external event data
     */
    public RawEvent(Object event) {
        this(event, null, null, null);
    }

    @Override
    public EventType type() {
        return EventType.RAW;
    }
}
