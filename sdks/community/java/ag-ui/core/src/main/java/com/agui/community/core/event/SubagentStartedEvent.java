package com.agui.community.core.event;

import java.util.Objects;

/**
 * Announces one subagent invocation. Its id identifies an invocation, while its
 * name may be reused by multiple invocations. Nested delegation is identified
 * by {@code parentSubagentRunId}, not by changing the invocation's own id.
 *
 * @param subagentRunId the unique invocation identifier (required)
 * @param name the subagent's reusable name (required)
 * @param description a display description, or {@code null} (optional)
 * @param parentSubagentRunId the enclosing subagent invocation, or {@code null}
 *                           when delegated directly by the parent agent (optional)
 * @param parentToolCallId the spawning tool call, or {@code null} (optional)
 * @param parentMessageId the message holding that tool call, or {@code null} (optional)
 * @param timestamp the creation time in epoch milliseconds, or {@code null} (optional)
 * @param rawEvent the original provider event, or {@code null} (optional)
 * @see <a href="https://docs.ag-ui.com/concepts/events">AG-UI Events</a>
 */
public record SubagentStartedEvent(String subagentRunId, String name, String description,
                                   String parentSubagentRunId, String parentToolCallId,
                                   String parentMessageId, Long timestamp, Object rawEvent) implements Event {

    public SubagentStartedEvent {
        Objects.requireNonNull(subagentRunId, "subagentRunId must not be null");
        Objects.requireNonNull(name, "name must not be null");
    }

    /**
     * Creates a subagent-started event with its required fields.
     *
     * @param subagentRunId the unique invocation identifier
     * @param name the subagent's reusable name
     */
    public SubagentStartedEvent(String subagentRunId, String name) {
        this(subagentRunId, name, null, null, null, null, null, null);
    }

    @Override
    public EventType type() {
        return EventType.SUBAGENT_STARTED;
    }
}
