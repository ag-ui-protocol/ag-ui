package com.agui.core.event;

import com.agui.core.type.EventType;

/**
 * An event that signals the completion of a reasoning message stream.
 * <p>
 * This event is fired when no more
 * {@link ReasoningMessageContentEvent} deltas will be emitted for the
 * identified reasoning message. Client renderers should treat the
 * assembled content as final once this event is observed.
 * </p>
 * <p>
 * The event automatically sets its type to
 * {@link EventType#REASONING_MESSAGE_END}.
 * </p>
 *
 * @see BaseEvent
 * @see EventType#REASONING_MESSAGE_END
 * @see ReasoningMessageStartEvent
 * @see ReasoningMessageContentEvent
 */
public class ReasoningMessageEndEvent extends BaseEvent {

    private String messageId;

    /**
     * Creates a new ReasoningMessageEndEvent with type set to
     * {@link EventType#REASONING_MESSAGE_END}.
     * <p>
     * The timestamp is automatically set to the current time and the
     * message ID is initialized as null.
     * </p>
     */
    public ReasoningMessageEndEvent() {
        super(EventType.REASONING_MESSAGE_END);
    }

    /**
     * Sets the unique identifier of the reasoning message that has
     * finished streaming.
     *
     * @param messageId the message identifier. Can be null.
     */
    public void setMessageId(final String messageId) {
        this.messageId = messageId;
    }

    /**
     * Returns the unique identifier of the reasoning message that has
     * finished streaming.
     *
     * @return the message identifier, can be null
     */
    public String getMessageId() {
        return this.messageId;
    }
}
