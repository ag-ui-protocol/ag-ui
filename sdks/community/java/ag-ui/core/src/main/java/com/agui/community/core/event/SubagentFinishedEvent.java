package com.agui.community.core.event;

import java.util.Objects;

/**
 * Ends a subagent's segment in the current run, successfully or suspended.
 * A suspended invocation may continue in a later run. This event does not end
 * the parent run.
 *
 * @param subagentRunId the invocation being closed (required)
 * @param outcome why the segment ended, or {@code null} for success (optional)
 * @param result a JSON-compatible return value, or {@code null} (optional)
 * @param timestamp the creation time in epoch milliseconds, or {@code null} (optional)
 * @param rawEvent the original provider event, or {@code null} (optional)
 * @see <a href="https://docs.ag-ui.com/concepts/events">AG-UI Events</a>
 */
public record SubagentFinishedEvent(String subagentRunId, SubagentFinishedOutcome outcome,
                                    Object result, Long timestamp, Object rawEvent) implements Event {

    public SubagentFinishedEvent {
        Objects.requireNonNull(subagentRunId, "subagentRunId must not be null");
    }

    /**
     * Creates a successful subagent completion without a return value.
     *
     * @param subagentRunId the invocation being closed
     */
    public SubagentFinishedEvent(String subagentRunId) {
        this(subagentRunId, null, null, null, null);
    }

    @Override
    public EventType type() {
        return EventType.SUBAGENT_FINISHED;
    }
}
