package com.agui.core.event;

import com.agui.core.type.EventType;

/**
 * An event that signals the beginning of a text message stream.
 * <p>
 * This event is fired when a text message begins streaming, marking the start
 * of an incremental message delivery process. It provides initial metadata
 * about the message including its identifier and the role of the sender,
 * which helps consumers prepare for subsequent content chunks.
 * </p>
 * <p>
 * The event automatically sets its type to {@link EventType#TEXT_MESSAGE_START}
 * and establishes the context for the streaming message that will follow.
 * </p>
 *
 * @see BaseEvent
 * @see EventType#TEXT_MESSAGE_START
 * @see TextMessageEndEvent
 * @see TextMessageContentEvent
 * @see TextMessageChunkEvent
 *
 * @author Pascal Wilbrink
 */
public class TextMessageStartEvent extends BaseEvent {

    private String messageId;
    private String role;

    /**
     * Creates a new TextMessageStartEvent with type set to {@link EventType#TEXT_MESSAGE_START}.
     * <p>
     * The timestamp is automatically set to the current time and both fields
     * are initialized as null.
     * </p>
     */
    public TextMessageStartEvent() {
        super(EventType.TEXT_MESSAGE_START);
    }

    /**
     * Sets the unique identifier for the message that is starting to stream.
     *
     * @param messageId the message identifier. Can be null.
     */
    public void setMessageId(final String messageId) {
        this.messageId = messageId;
    }

    /**
     * Returns the unique identifier for the message that is starting to stream.
     *
     * @return the message identifier, can be null
     */
    public String getMessageId() {
        return this.messageId;
    }

    /**
     * Sets the role of the message sender (e.g., "user", "assistant", "system").
     *
     * @param role the sender role. Can be null.
     */
    public void setRole(final String role) {
        this.role = role;
    }

    /**
     * Returns the role of the message sender.
     *
     * @return the sender role, can be null
     */
    public String getRole() {
        return this.role;
    }
}