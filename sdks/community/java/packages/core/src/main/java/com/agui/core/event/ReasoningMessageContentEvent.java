package com.agui.core.event;

import com.agui.core.type.EventType;

/**
 * An event that delivers incremental content for a reasoning message.
 * <p>
 * This event carries a delta (partial fragment) of the reasoning text
 * being streamed for the message identified by {@code messageId}.
 * Consumers concatenate successive deltas into the assembled reasoning
 * content, mirroring the streaming pattern used by
 * {@link TextMessageContentEvent} for primary text output.
 * </p>
 * <p>
 * The event automatically sets its type to
 * {@link EventType#REASONING_MESSAGE_CONTENT}.
 * </p>
 *
 * @see BaseEvent
 * @see EventType#REASONING_MESSAGE_CONTENT
 * @see ReasoningMessageStartEvent
 * @see ReasoningMessageEndEvent
 */
public class ReasoningMessageContentEvent extends BaseEvent {

    private String messageId;
    private String delta;

    /**
     * Creates a new ReasoningMessageContentEvent with type set to
     * {@link EventType#REASONING_MESSAGE_CONTENT}.
     * <p>
     * The timestamp is automatically set to the current time and both
     * fields are initialized as null.
     * </p>
     */
    public ReasoningMessageContentEvent() {
        super(EventType.REASONING_MESSAGE_CONTENT);
    }

    /**
     * Sets the unique identifier of the reasoning message this content
     * belongs to.
     *
     * @param messageId the message identifier. Can be null.
     */
    public void setMessageId(final String messageId) {
        this.messageId = messageId;
    }

    /**
     * Returns the unique identifier of the reasoning message this
     * content belongs to.
     *
     * @return the message identifier, can be null
     */
    public String getMessageId() {
        return this.messageId;
    }

    /**
     * Sets the incremental reasoning content fragment for this message.
     *
     * @param delta the reasoning text delta. Can be null.
     */
    public void setDelta(final String delta) {
        this.delta = delta;
    }

    /**
     * Returns the incremental reasoning content fragment for this
     * message.
     *
     * @return the reasoning text delta, can be null
     */
    public String getDelta() {
        return this.delta;
    }
}
