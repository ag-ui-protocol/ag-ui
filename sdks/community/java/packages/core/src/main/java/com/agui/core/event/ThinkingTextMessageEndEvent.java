package com.agui.core.event;

import com.agui.core.type.EventType;

/**
 * An event that signals the completion of thinking text message content.
 * <p>
 * This event is fired when a system or AI component has finished generating
 * text content during its thinking or reasoning phase. It serves as a completion
 * marker for internal deliberation text, indicating that no more thinking
 * content will be produced for the current reasoning cycle.
 * </p>
 * <p>
 * The event automatically sets its type to {@link EventType#THINKING_TEXT_MESSAGE_END}
 * and helps coordinate the transition from internal reasoning to final output
 * or decision-making.
 * </p>
 *
 * @see BaseEvent
 * @see EventType#THINKING_TEXT_MESSAGE_END
 * @see ThinkingTextMessageStartEvent
 * @see ThinkingTextMessageContentEvent
 * @see ThinkingEndEvent
 *
 * @author Pascal Wilbrink
 */
public class ThinkingTextMessageEndEvent extends BaseEvent {

    /**
     * Creates a new ThinkingTextMessageEndEvent with type set to {@link EventType#THINKING_TEXT_MESSAGE_END}.
     * <p>
     * The timestamp is automatically set to the current time.
     * </p>
     */
    public ThinkingTextMessageEndEvent() {
        super(EventType.THINKING_TEXT_MESSAGE_END);
    }
}