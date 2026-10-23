package com.agui.community.core.event;

import java.util.List;
import java.util.Objects;

/**
 * The outcome of a {@link SubagentFinishedEvent}. A successful outcome carries
 * only {@code type:"success"}; a suspended outcome may also identify run-level
 * interrupts raised by this invocation. Suspension caused by a descendant can
 * omit that list or carry an empty list.
 *
 * <p>The wire discriminator is stored as a validated string so this concrete
 * record can be bound without a polymorphic JSON adapter. An absent outcome on
 * the event is equivalent to success.
 *
 * @param type {@link #SUCCESS} or {@link #SUSPENDED} (required)
 * @param interruptIds the invocation's own interrupt ids, allowed only when
 *                     suspended; {@code null} means omitted (optional)
 */
public record SubagentFinishedOutcome(String type, List<String> interruptIds) {

    /** The subagent completed its work. */
    public static final String SUCCESS = "success";

    /** The subagent is awaiting outside input and may continue in a later run. */
    public static final String SUSPENDED = "suspended";

    public SubagentFinishedOutcome {
        Objects.requireNonNull(type, "type must not be null");
        if (!SUCCESS.equals(type) && !SUSPENDED.equals(type)) {
            throw new IllegalArgumentException("Unknown subagent outcome type: " + type);
        }
        if (SUCCESS.equals(type) && interruptIds != null) {
            throw new IllegalArgumentException("interruptIds are only allowed for a suspended subagent");
        }
        interruptIds = interruptIds == null ? null : List.copyOf(interruptIds);
    }

    /** @return an explicit successful outcome */
    public static SubagentFinishedOutcome success() {
        return new SubagentFinishedOutcome(SUCCESS, null);
    }

    /** @return a suspended outcome without an owned interrupt list */
    public static SubagentFinishedOutcome suspended() {
        return new SubagentFinishedOutcome(SUSPENDED, null);
    }

    /**
     * Creates a suspended outcome, defensively copying its interrupt ids.
     *
     * @param interruptIds owned interrupt ids, or {@code null} to omit the list
     * @return the suspended outcome
     */
    public static SubagentFinishedOutcome suspended(List<String> interruptIds) {
        return new SubagentFinishedOutcome(SUSPENDED, interruptIds);
    }
}
