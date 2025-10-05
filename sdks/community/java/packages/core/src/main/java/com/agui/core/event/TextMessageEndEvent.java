package com.agui.core.event;

import com.agui.core.type.EventType;

/**
 * An event that signals the completion of a text message stream.
 * <p>
 * This event is fired when a text message has finished streaming and no more
 * content chunks or updates are expected. It serves as a completion marker
 * for streaming message scenarios, allowing consumers to know when message
 * assembly is complete.
 * </p>
 * <p>
 * The event automatically sets its type to {@link EventType#TEXT_MESSAGE_END}
 * and identifies the completed message through its unique identifier.
 * </p>
 *
 * @see BaseEvent
 * @see EventType#TEXT_MESSAGE_END
 * @see TextMessageStartEvent
 * @see TextMessageContentEvent
 * @see TextMessageChunkEvent
 *
 * @author Pascal Wilbrink
 */
public class TextMessageEndEvent extends BaseEvent {

    private String messageId;

    /**
     * Creates a new TextMessageEndEvent with type set to {@link EventType#TEXT_MESSAGE_END}.
     * <p>
     * The timestamp is automatically set to the current time and the message ID
     * is initialized as null.
     * </p>
     */
    public TextMessageEndEvent() {
        super(EventType.TEXT_MESSAGE_END);
    }

    /**
     * Sets the unique identifier of the message that has finished streaming.
     *
     * @param messageId the message identifier. Can be null.
     */
    public void setMessageId(final String messageId) {
        this.messageId = messageId;
    }

    /**
     * Returns the unique identifier of the message that has finished streaming.
     *
     * @return the message identifier, can be null
     */
    public String getMessageId() {
        return this.messageId;
    }
}