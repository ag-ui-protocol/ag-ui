package com.agui.community.core.event;

import java.util.Objects;

/**
 * Reports a failed subagent invocation. The parent agent may handle this error
 * and continue; it is not a {@link RunErrorEvent}.
 *
 * @param subagentRunId the failed invocation (required)
 * @param message a human-readable explanation (required)
 * @param code a machine-readable error code, or {@code null} (optional)
 * @param timestamp the creation time in epoch milliseconds, or {@code null} (optional)
 * @param rawEvent the original provider event, or {@code null} (optional)
 * @see <a href="https://docs.ag-ui.com/concepts/events">AG-UI Events</a>
 */
public record SubagentErrorEvent(String subagentRunId, String message, String code,
                                 Long timestamp, Object rawEvent) implements Event {

    public SubagentErrorEvent {
        Objects.requireNonNull(subagentRunId, "subagentRunId must not be null");
        Objects.requireNonNull(message, "message must not be null");
    }

    /**
     * Creates a subagent error with its required fields.
     *
     * @param subagentRunId the failed invocation
     * @param message a human-readable explanation
     */
    public SubagentErrorEvent(String subagentRunId, String message) {
        this(subagentRunId, message, null, null, null);
    }

    @Override
    public EventType type() {
        return EventType.SUBAGENT_ERROR;
    }
}
