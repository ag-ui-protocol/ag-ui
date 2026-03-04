package com.agui.core.event;

import com.agui.core.type.EventType;

/**
 * An event that represents content updates for a text message.
 * <p>
 * This event is used to deliver incremental content updates for text messages,
 * typically in streaming scenarios where message content is built up over time.
 * Unlike {@link TextMessageChunkEvent}, this event focuses specifically on
 * content delivery without role information.
 * </p>
 * <p>
 * The event automatically sets its type to {@link EventType#TEXT_MESSAGE_CONTENT}
 * and provides fields to identify the target message and deliver the content delta.
 * </p>
 *
 * @see BaseEvent
 * @see EventType#TEXT_MESSAGE_CONTENT
 * @see TextMessageChunkEvent
 *
 * @author Pascal Wilbrink
 */
public class TextMessageContentEvent extends BaseEvent {

    private String messageId;
    private String delta;

    /**
     * Creates a new TextMessageContentEvent with type set to {@link EventType#TEXT_MESSAGE_CONTENT}.
     * <p>
     * The timestamp is automatically set to the current time and both fields
     * are initialized as null.
     * </p>
     */
    public TextMessageContentEvent() {
        super(EventType.TEXT_MESSAGE_CONTENT);
    }

    /**
     * Sets the unique identifier of the message this content belongs to.
     *
     * @param messageId the message identifier. Can be null.
     */
    public void setMessageId(final String messageId) {
        this.messageId = messageId;
    }

    /**
     * Returns the unique identifier of the message this content belongs to.
     *
     * @return the message identifier, can be null
     */
    public String getMessageId() {
        return this.messageId;
    }

    /**
     * Sets the incremental text content for this message.
     *
     * @param delta the text content delta. Can be null.
     */
    public void setDelta(final String delta) {
        this.delta = delta;
    }

    /**
     * Returns the incremental text content for this message.
     *
     * @return the text content delta, can be null
     */
    public String getDelta() {
        return this.delta;
    }
}