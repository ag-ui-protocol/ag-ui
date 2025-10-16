package com.agui.core.event;

import com.agui.core.type.EventType;

/**
 * An event that represents a partial chunk of a text message being streamed.
 * <p>
 * This event is typically used in streaming scenarios where text messages
 * are delivered incrementally in chunks rather than as complete messages.
 * Each chunk contains a portion of the message content along with metadata
 * to identify the message and the role of the sender.
 * </p>
 * <p>
 * The event automatically sets its type to {@link EventType#TEXT_MESSAGE_CHUNK}
 * and provides fields to track the message identifier, sender role, and the
 * incremental text content (delta).
 * </p>
 *
 * @see BaseEvent
 * @see EventType#TEXT_MESSAGE_CHUNK
 *
 * @author Pascal Wilbrink
 */
public class TextMessageChunkEvent extends BaseEvent {

    private String messageId;
    private String role;
    private String delta;

    /**
     * Creates a new TextMessageChunkEvent with type set to {@link EventType#TEXT_MESSAGE_CHUNK}.
     * <p>
     * The timestamp is automatically set to the current time and all fields
     * are initialized as null.
     * </p>
     */
    public TextMessageChunkEvent() {
        super(EventType.TEXT_MESSAGE_CHUNK);
    }

    /**
     * Sets the unique identifier of the message this chunk belongs to.
     *
     * @param messageId the message identifier. Can be null.
     */
    public void setMessageId(final String messageId) {
        this.messageId = messageId;
    }

    /**
     * Returns the unique identifier of the message this chunk belongs to.
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

    /**
     * Sets the incremental text content for this chunk.
     *
     * @param delta the text content delta/chunk. Can be null.
     */
    public void setDelta(final String delta) {
        this.delta = delta;
    }

    /**
     * Returns the incremental text content for this chunk.
     *
     * @return the text content delta/chunk, can be null
     */
    public String getDelta() {
        return this.delta;
    }
}