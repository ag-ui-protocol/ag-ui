package com.agui.community.core.event;

import java.util.Objects;

/**
 * Signals the end of a reasoning (chain-of-thought) sequence. The
 * {@link #messageId()} matches the corresponding {@link ReasoningStartEvent}.
 *
 * @param messageId the reasoning identifier (required)
 * @param timestamp the event creation time in epoch milliseconds, or
 *                  {@code null} (optional)
 * @param rawEvent  the original event this was transformed from, or
 *                  {@code null} (optional)
 * @param subagentRunId the producing subagent invocation, or {@code null} for
 *                       output from the parent agent (optional)
 * @see <a href="https://docs.ag-ui.com/concepts/events">AG-UI Events</a>
 */
public record ReasoningEndEvent(String messageId, Long timestamp, Object rawEvent,
                                String subagentRunId)
        implements Event {

    public ReasoningEndEvent {
        Objects.requireNonNull(messageId, "messageId must not be null");
    }

    /** Creates an event without subagent attribution using the original signature. */
    public ReasoningEndEvent(String messageId, Long timestamp, Object rawEvent) {
        this(messageId, timestamp, rawEvent, null);
    }

    /**
     * Creates a reasoning-end event from a message id.
     *
     * @param messageId the reasoning identifier
     */
    public ReasoningEndEvent(String messageId) {
        this(messageId, null, null);
    }

    @Override
    public EventType type() {
        return EventType.REASONING_END;
    }
}
