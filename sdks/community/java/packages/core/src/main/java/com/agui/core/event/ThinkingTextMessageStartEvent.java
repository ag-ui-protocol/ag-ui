package com.agui.core.event;

import com.agui.core.type.EventType;

/**
 * An event that signals the beginning of thinking text message content generation.
 * <p>
 * This event is fired when a system or AI component begins generating text
 * content as part of its thinking or reasoning phase. It marks the start of
 * internal deliberation text that provides transparency into the decision-making
 * process and prepares consumers for subsequent thinking content.
 * </p>
 * <p>
 * The event automatically sets its type to {@link EventType#THINKING_TEXT_MESSAGE_START}
 * and establishes the context for the thinking text stream that will follow.
 * </p>
 *
 * @see BaseEvent
 * @see EventType#THINKING_TEXT_MESSAGE_START
 * @see ThinkingTextMessageEndEvent
 * @see ThinkingTextMessageContentEvent
 * @see ThinkingStartEvent
 *
 * @author Pascal Wilbrink
 */
public class ThinkingTextMessageStartEvent extends BaseEvent {

    /**
     * Creates a new ThinkingTextMessageStartEvent with type set to {@link EventType#THINKING_TEXT_MESSAGE_START}.
     * <p>
     * The timestamp is automatically set to the current time.
     * </p>
     */
    public ThinkingTextMessageStartEvent() {
        super(EventType.THINKING_TEXT_MESSAGE_START);
    }
}