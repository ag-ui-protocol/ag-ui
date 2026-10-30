package com.agui.community.core.event;

import com.agui.community.core.interrupt.RunOutcome;
import java.util.List;
import java.util.Objects;

/**
 * Signals that an agent run has finished.
 *
 * @param threadId  the conversation thread id (required)
 * @param runId     the agent run id (required)
 * @param outcome   the run outcome ({@code success} or {@code interrupt}), or
 *                  {@code null} for a normal completion (optional)
 * @param result    a free-form completion payload, or {@code null} (optional)
 * @param usage     token usage for this run, including subagents, or {@code null}
 *                  (optional; copied to an unmodifiable list)
 * @param timestamp the event creation time in epoch milliseconds, or
 *                  {@code null} (optional)
 * @param rawEvent  the original event this was transformed from, or
 *                  {@code null} (optional)
 * @see <a href="https://docs.ag-ui.com/concepts/events">AG-UI Events</a>
 * @see <a href="https://docs.ag-ui.com/concepts/interrupts">AG-UI Interrupts</a>
 */
public record RunFinishedEvent(String threadId, String runId, RunOutcome outcome, Object result,
                               List<TokenUsage> usage, Long timestamp, Object rawEvent) implements Event {

    public RunFinishedEvent {
        Objects.requireNonNull(threadId, "threadId must not be null");
        Objects.requireNonNull(runId, "runId must not be null");
        usage = usage == null ? null : List.copyOf(usage);
    }

    /**
     * Creates a run-finished event without usage, preserving the original signature.
     *
     * @param threadId  the conversation thread id
     * @param runId     the agent run id
     * @param outcome   the run outcome, or {@code null}
     * @param result    the completion payload, or {@code null}
     * @param timestamp the event creation time, or {@code null}
     * @param rawEvent  the original event, or {@code null}
     */
    public RunFinishedEvent(String threadId, String runId, RunOutcome outcome, Object result,
                            Long timestamp, Object rawEvent) {
        this(threadId, runId, outcome, result, null, timestamp, rawEvent);
    }

    /**
     * Creates a run-finished event with only the required fields.
     *
     * @param threadId the conversation thread id
     * @param runId    the agent run id
     */
    public RunFinishedEvent(String threadId, String runId) {
        this(threadId, runId, null, null, null, null);
    }

    @Override
    public EventType type() {
        return EventType.RUN_FINISHED;
    }
}
