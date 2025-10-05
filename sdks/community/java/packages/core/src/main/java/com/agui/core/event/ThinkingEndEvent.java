package com.agui.core.event;

import com.agui.core.type.EventType;

/**
 * An event that signals the completion of a thinking or processing phase.
 * <p>
 * This event is fired when a system or AI component has finished its internal
 * reasoning, deliberation, or processing phase. It serves as a marker to indicate
 * that the thinking process has concluded and the system is ready to proceed
 * with the next phase of operation.
 * </p>
 * <p>
 * The event automatically sets its type to {@link EventType#THINKING_END} and
 * can be used to coordinate workflows that depend on completion of cognitive
 * or analytical processes.
 * </p>
 *
 * @see BaseEvent
 * @see EventType#THINKING_END
 * @see ThinkingStartEvent
 *
 * @author Pascal Wilbrink
 */
public class ThinkingEndEvent extends BaseEvent {

    /**
     * Creates a new ThinkingEndEvent with type set to {@link EventType#THINKING_END}.
     * <p>
     * The timestamp is automatically set to the current time.
     * </p>
     */
    public ThinkingEndEvent() {
        super(EventType.THINKING_END);
    }
}