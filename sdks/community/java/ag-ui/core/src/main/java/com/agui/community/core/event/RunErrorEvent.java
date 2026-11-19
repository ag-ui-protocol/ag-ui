package com.agui.community.core.event;

import java.util.List;
import java.util.Objects;

/**
 * Signals that an agent run has errored.
 *
 * @param message   the error message (required)
 * @param code      the error code, or {@code null} (optional)
 * @param usage     token usage accrued before the failure, or {@code null}
 *                  (optional; copied to an unmodifiable list)
 * @param timestamp the event creation time in epoch milliseconds, or
 *                  {@code null} (optional)
 * @param rawEvent  the original event this was transformed from, or
 *                  {@code null} (optional)
 * @see <a href="https://docs.ag-ui.com/concepts/events">AG-UI Events</a>
 */
public record RunErrorEvent(String message, String code, List<TokenUsage> usage,
                            Long timestamp, Object rawEvent)
        implements Event {

    public RunErrorEvent {
        Objects.requireNonNull(message, "message must not be null");
        usage = usage == null ? null : List.copyOf(usage);
    }

    /**
     * Creates a run-error event without usage, preserving the original signature.
     *
     * @param message   the error message
     * @param code      the error code, or {@code null}
     * @param timestamp the event creation time, or {@code null}
     * @param rawEvent  the original event, or {@code null}
     */
    public RunErrorEvent(String message, String code, Long timestamp, Object rawEvent) {
        this(message, code, null, timestamp, rawEvent);
    }

    /**
     * Creates a run-error event with only an error message.
     *
     * @param message the error message
     */
    public RunErrorEvent(String message) {
        this(message, null, null, null);
    }

    @Override
    public EventType type() {
        return EventType.RUN_ERROR;
    }
}
