package com.agui.core.message;

import java.util.Objects;
import java.util.UUID;

/**
 * Abstract base class for all message types in the system.
 * <p>
 * This class provides common functionality for messages including unique
 * identification, content storage, and naming. All concrete message implementations
 * must extend this base class and provide their specific role implementation.
 * The class automatically generates a unique UUID for new messages when using
 * the default constructor.
 * </p>
 * <p>
 * Messages are fundamental building blocks for communication within the system,
 * whether between users, AI assistants, or system components.
 * </p>
 *
 * @author Pascal Wilbrink
 */
public abstract class BaseMessage {

    private String id;
    private String content;
    private String name;

    /**
     * Creates a new BaseMessage with auto-generated UUID and empty content and name.
     * <p>
     * This constructor automatically assigns a unique identifier using
     * {@link UUID#randomUUID()} and initializes content and name as empty strings.
     * </p>
     */
    protected BaseMessage() {
        this(UUID.randomUUID().toString(), "", "");
    }

    /**
     * Creates a new BaseMessage with the specified identifier, content, and name.
     *
     * @param id      the unique identifier for this message
     * @param content the content/text of the message
     * @param name    the name associated with this message
     */
    protected BaseMessage(final String id, final String content, final String name) {
        this.id = id;
        this.content = content;
        this.name = name;
    }

    /**
     * Returns the role of this message.
     * <p>
     * This abstract method must be implemented by concrete message classes
     * to define their specific role (e.g., "user", "assistant", "system").
     * </p>
     *
     * @return the role of this message, never null
     */
    public abstract Role getRole();

    /**
     * Sets the unique identifier for this message.
     *
     * @param id the message identifier
     */
    public void setId(final String id) {
        this.id = id;
    }

    /**
     * Returns the unique identifier for this message.
     *
     * @return the message identifier
     */
    public String getId() {
        return this.id;
    }

    /**
     * Sets the content/text of this message.
     *
     * @param content the message content
     */
    public void setContent(final String content) {
        this.content = content;
    }

    /**
     * Returns the content/text of this message.
     *
     * @return the message content
     */
    public String getContent() {
        return this.content;
    }

    /**
     * Sets the name associated with this message.
     *
     * @param name the message name
     */
    public void setName(final String name) {
        this.name = name;
    }

    /**
     * Returns the name associated with this message.
     *
     * @return the message name
     */
    public String getName() {
        return this.name;
    }


    /**
     * Compares this message to another object for equality.
     * <p>
     * Two messages are considered equal if they have the same role, id, and content.
     * The name field is not considered in equality comparison.
     * </p>
     *
     * @param obj the object to compare with
     * @return true if the messages are equal, false otherwise
     */
    @Override
    public boolean equals(final Object obj) {
        if (this == obj) {
            return true;
        }
        if (obj == null || getClass() != obj.getClass()) {
            return false;
        }

        BaseMessage that = (BaseMessage) obj;

        if (!getRole().equals(that.getRole())) {
            return false;
        }
        if (!Objects.equals(id, that.id)) {
            return false;
        }
        return Objects.equals(content, that.content);
    }

    /**
     * Returns a hash code value for this message.
     * <p>
     * The hash code is computed based on role, id, and content to be consistent
     * with the equals method.
     * </p>
     *
     * @return a hash code value for this message
     */
    @Override
    public int hashCode() {
        int result = getRole().hashCode();
        result = 31 * result + (id != null ? id.hashCode() : 0);
        result = 31 * result + (content != null ? content.hashCode() : 0);
        return result;
    }
}