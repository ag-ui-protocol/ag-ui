package com.agui.core.message;

/**
 * A message representing communication from a user.
 * <p>
 * This message type is used for communications that originate from end users
 * interacting with the system. It represents user input, questions, requests,
 * or any other form of human-generated communication within the application.
 * User messages are typically the primary driver of conversations and
 * interactions with AI assistants or other system components.
 * </p>
 * <p>
 * User messages contain the natural language input or instructions that
 * users provide to communicate their needs, ask questions, or request
 * actions from the system.
 * </p>
 *
 * @see BaseMessage
 *
 * @author Pascal Wilbrink
 */
public class UserMessage extends BaseMessage {

    /**
     * Returns the role of this message as "user".
     * <p>
     * This implementation fulfills the abstract contract from {@link BaseMessage}
     * and identifies this message as originating from an end user.
     * </p>
     *
     * @return "user" - the fixed role for user messages
     */
    public Role getRole() {
        return Role.user;
    }
}