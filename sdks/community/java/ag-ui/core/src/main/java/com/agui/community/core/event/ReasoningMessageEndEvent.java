package com.agui.community.core.event;

import java.util.Objects;

/**
 * Signals the end of a streamed reasoning message. The {@link #messageId()}
 * matches the corresponding {@link ReasoningMessageStartEvent}.
 *
 * @param messageId the message identifier (required)
 * @param timestamp the event creation time in epoch milliseconds, or
 *                  {@code null} (optional)
 * @param rawEvent  the original event this was transformed from, or
 *                  {@code null} (optional)
 * @param subagentRunId the producing subagent invocation, or {@code null} for
 *                       output from the parent agent (optional)
 * @see <a href="https://docs.ag-ui.com/concepts/events">AG-UI Events</a>
 */
public record ReasoningMessageEndEvent(String messageId, Long timestamp, Object rawEvent,
                                       String subagentRunId)
        implements Event {

    public ReasoningMessageEndEvent {
        Objects.requireNonNull(messageId, "messageId must not be null");
    }

    /** Creates an event without subagent attribution using the original signature. */
    public ReasoningMessageEndEvent(String messageId, Long timestamp, Object rawEvent) {
        this(messageId, timestamp, rawEvent, null);
    }

    /**
     * Creates a reasoning-message-end event from a message id.
     *
     * @param messageId the message identifier
     */
    public ReasoningMessageEndEvent(String messageId) {
        this(messageId, null, null);
    }

    @Override
    public EventType type() {
        return EventType.REASONING_MESSAGE_END;
    }
}
