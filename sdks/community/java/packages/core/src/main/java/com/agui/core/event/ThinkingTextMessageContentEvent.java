package com.agui.core.event;

import com.agui.core.type.EventType;

/**
 * An event that represents text content generated during a thinking or reasoning phase.
 * <p>
 * This event is fired when a system or AI component produces text output as part
 * of its internal reasoning process. Unlike regular text message content, this
 * represents the "thinking out loud" or internal deliberation that may be shared
 * with users to provide transparency into the decision-making process.
 * </p>
 * <p>
 * The event automatically sets its type to {@link EventType#THINKING_TEXT_MESSAGE_CONTENT}
 * and can carry the actual thinking content through the inherited
 * {@link BaseEvent#setRawEvent(Object)} method.
 * </p>
 *
 * @see BaseEvent
 * @see EventType#THINKING_TEXT_MESSAGE_CONTENT
 * @see ThinkingStartEvent
 * @see ThinkingEndEvent
 * @see TextMessageContentEvent
 *
 *  @author Pascal Wilbrink
 */
public class ThinkingTextMessageContentEvent extends BaseEvent {

    /**
     * Creates a new ThinkingTextMessageContentEvent with type set to {@link EventType#THINKING_TEXT_MESSAGE_CONTENT}.
     * <p>
     * The timestamp is automatically set to the current time.
     * </p>
     */
    public ThinkingTextMessageContentEvent() {
        super(EventType.THINKING_TEXT_MESSAGE_CONTENT);
    }
}