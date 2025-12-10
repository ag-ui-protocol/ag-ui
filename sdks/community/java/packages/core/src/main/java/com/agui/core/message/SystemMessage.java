package com.agui.core.message;

/**
 * A message representing communication from the system itself.
 * <p>
 * This message type is used for communications that originate from the system,
 * such as configuration instructions, system prompts, initialization messages,
 * or other automated system-level communications. System messages typically
 * provide context, instructions, or configuration that influences how other
 * components (like AI assistants) should behave.
 * </p>
 * <p>
 * System messages are often used to set up conversation context, provide
 * behavioral guidelines, or communicate system state changes that need to
 * be processed by other system components.
 * </p>
 *
 * @see BaseMessage
 *
 * @author Pascal Wilbrink
 */
public class SystemMessage extends BaseMessage {

    /**
     * Returns the role of this message as "system".
     * <p>
     * This implementation fulfills the abstract contract from {@link BaseMessage}
     * and identifies this message as originating from the system itself.
     * </p>
     *
     * @return "system" - the fixed role for system messages
     */
    public Role getRole() {
        return Role.system;
    }
}