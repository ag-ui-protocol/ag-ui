package com.agui.client.message;

import com.agui.core.exception.AGUIException;
import com.agui.core.message.*;
import com.agui.core.tool.ToolCall;

import java.util.HashMap;
import java.util.Map;

/**
 * Factory class for creating and managing chat messages during streaming operations.
 * <p>
 * This factory supports building messages incrementally by receiving chunks of content
 * and assembling them into complete {@link BaseMessage} objects based on the role type.
 * It also provides specialized operations for assistant and tool messages.
 * </p>
 *
 * @author Pascal Wilbrink
 */
public class MessageFactory {

    private final Map<String, BaseMessage> messages;

    /**
     * Creates a new MessageFactory with an empty message store.
     */
    public MessageFactory() {
        this.messages = new HashMap<>();
    }

    /**
     * Creates a new message with the specified ID and role.
     * <p>
     * This method should be called when a new message stream begins,
     * typically triggered by a 'MESSAGE_STARTED' event.
     * </p>
     *
     * @param id   the unique identifier for the message
     * @param role the role of the message sender (e.g., "user", "assistant", "developer", "tool")
     * @throws AGUIException if the role is not supported
     */
    public void createMessage(final String id, final Role role) throws AGUIException {
        this.messages.put(id, this.createMessageByRole(id, role));
    }

    /**
     * Adds a content chunk to an existing message.
     * <p>
     * This method is used during streaming to incrementally build message content
     * as chunks are received from the message source.
     * </p>
     *
     * @param id    the ID of the message to add content to
     * @param chunk the content chunk to append to the message
     * @throws AGUIException if no message with the specified ID exists
     */
    public void addChunk(final String id, final String chunk) throws AGUIException {
        this.ensureMessageExists(id);

        messages.get(id).setContent(
            "%s%s".formatted(messages.get(id).getContent(), chunk)
        );
    }

    /**
     * Retrieves a complete message by ID.
     *
     * @param id the ID of the message to retrieve
     * @return the complete message object with all accumulated content
     * @throws AGUIException if no message with the specified ID exists
     */
    public BaseMessage getMessage(final String id) throws AGUIException {
        this.ensureMessageExists(id);

        return this.messages.get(id);
    }

    /**
     * Removes a message from the factory by ID.
     * <p>
     * This is useful for cleaning up completed messages to free memory.
     * </p>
     *
     * @param id the ID of the message to remove
     * @throws AGUIException if no message with the specified ID exists
     */
    public void removeMessage(final String id) throws AGUIException {
        this.ensureMessageExists(id);

        this.messages.remove(id);
    }

    /**
     * Adds a tool call to an assistant message.
     * <p>
     * Tool calls can only be added to messages with the "assistant" role.
     * </p>
     *
     * @param id       the ID of the assistant message
     * @param toolCall the tool call to add to the message
     * @throws AGUIException if no message with the specified ID exists or if the message is not an assistant message
     */
    public void addToolCall(final String id, final ToolCall toolCall) throws AGUIException {
        this.ensureMessageExists(id);

        var message = this.messages.get(id);
        if (!(message instanceof AssistantMessage)) {
            throw new AGUIException("Cannot add tool call for message with role '%s'.".formatted(message.getRole().name()));
        }
        ((AssistantMessage) message).addToolCall(toolCall);
    }

    /**
     * Sets an error message for a tool message.
     * <p>
     * Errors can only be set on messages with the "tool" role.
     * </p>
     *
     * @param id    the ID of the tool message
     * @param error the error message to set
     * @throws AGUIException if no message with the specified ID exists or if the message is not a tool message
     */
    public void setError(final String id, final String error) throws AGUIException {
        this.ensureMessageExists(id);

        var message = this.messages.get(id);

        if (!(message instanceof ToolMessage)) {
            throw new AGUIException("Cannot set an error for message with role '%s'.".formatted(message.getRole().name()));
        }
        ((ToolMessage) message).setError(error);
    }

    /**
     * Sets the tool call ID for a tool message.
     * <p>
     * Tool call IDs can only be set on messages with the "tool" role.
     * This links the tool message back to the original tool call from an assistant.
     * </p>
     *
     * @param id         the ID of the tool message
     * @param toolCallId the ID of the tool call that generated this message
     * @throws AGUIException if no message with the specified ID exists or if the message is not a tool message
     */
    public void setToolCallId(final String id, final String toolCallId) throws AGUIException {
        this.ensureMessageExists(id);

        var message = this.messages.get(id);

        if (!(message instanceof ToolMessage)) {
            throw new AGUIException("Cannot set tool call id for message with role '%s'.".formatted(message.getRole().name()));
        }

        ((ToolMessage) message).setToolCallId(toolCallId);
    }

    /**
     * Ensures that a message with the given ID exists in the factory.
     *
     * @param id the ID to check
     * @throws AGUIException if no message with the specified ID exists
     */
    private void ensureMessageExists(final String id) throws AGUIException {
        if (!this.messages.containsKey(id)) {
            throw new AGUIException("No message with id '%s' found. Create a new message first with the 'MESSAGE_STARTED' event.".formatted(id));
        }
    }

    /**
     * Creates a new message instance based on the specified role.
     * <p>
     * Supported roles and their corresponding message types:
     * </p>
     * <ul>
     *   <li>"user" → {@link UserMessage}</li>
     *   <li>"assistant" → {@link AssistantMessage}</li>
     *   <li>"developer" → {@link DeveloperMessage}</li>
     *   <li>"tool" → {@link ToolMessage}</li>
     * </ul>
     *
     * @param id   the unique identifier for the message
     * @param role the role type for the message
     * @return a new message instance configured with the given ID and role
     */
    private BaseMessage createMessageByRole(String id, Role role) {
        BaseMessage message = switch (role) {
            case developer -> new DeveloperMessage();
            case assistant -> new AssistantMessage();
            case user -> new UserMessage();
            case tool -> new ToolMessage();
            case system -> new SystemMessage();
        };

        message.setId(id);
        message.setName(role.name());

        return message;
    }

}

