package com.agui.core.event;

import com.agui.core.type.EventType;

/**
 * An event that signals the beginning of a thinking or processing phase.
 * <p>
 * This event is fired when a system or AI component begins its internal
 * reasoning, deliberation, or processing phase. It serves as a marker to indicate
 * that cognitive or analytical work has started and can be used to coordinate
 * workflows or provide user feedback about system activity.
 * </p>
 * <p>
 * The event automatically sets its type to {@link EventType#THINKING_START} and
 * helps establish the start of processes that may require time for computation
 * or analysis.
 * </p>
 *
 * @see BaseEvent
 * @see EventType#THINKING_START
 * @see ThinkingEndEvent
 *
 * @author Pascal Wilbrink
 */
public class ThinkingStartEvent extends BaseEvent {

    /**
     * Creates a new ThinkingStartEvent with type set to {@link EventType#THINKING_START}.
     * <p>
     * The timestamp is automatically set to the current time.
     * </p>
     */
    public ThinkingStartEvent() {
        super(EventType.THINKING_START);
    }
}