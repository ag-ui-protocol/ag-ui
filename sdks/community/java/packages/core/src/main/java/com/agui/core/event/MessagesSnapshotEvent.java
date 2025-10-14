package com.agui.core.event;

import com.agui.core.message.BaseMessage;
import com.agui.core.type.EventType;

import java.util.ArrayList;
import java.util.List;

/**
 * An event that represents a snapshot of messages at a specific point in time.
 * <p>
 * This event is typically used to capture and transmit the current state of
 * all messages in the system. It contains a collection of {@link BaseMessage}
 * objects that represent the complete message history or a filtered subset
 * at the time the snapshot was taken.
 * </p>
 * <p>
 * The event automatically sets its type to {@link EventType#MESSAGES_SNAPSHOT}
 * and initializes with an empty message list that can be populated with the
 * actual messages.
 * </p>
 *
 * @see BaseEvent
 * @see BaseMessage
 * @see EventType#MESSAGES_SNAPSHOT
 *
 * @author Pascal Wilbrink
 */
public class MessagesSnapshotEvent extends BaseEvent {

    private List<BaseMessage> messages = new ArrayList<>();

    /**
     * Creates a new MessagesSnapshotEvent with type set to {@link EventType#MESSAGES_SNAPSHOT}.
     * <p>
     * The timestamp is automatically set to the current time and the messages
     * list is initialized as an empty ArrayList.
     * </p>
     */
    public MessagesSnapshotEvent() {
        super(EventType.MESSAGES_SNAPSHOT);
    }

    /**
     * Sets the list of messages for this snapshot.
     *
     * @param messages the list of messages to include in this snapshot.
     *                Can be null or empty.
     */
    public void setMessages(final List<BaseMessage> messages) {
        this.messages = messages;
    }

    /**
     * Returns the list of messages in this snapshot.
     *
     * @return the list of messages, never null but may be empty
     */
    public List<BaseMessage> getMessages() {
        return this.messages;
    }
}