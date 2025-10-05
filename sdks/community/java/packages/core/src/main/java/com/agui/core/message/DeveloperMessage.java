package com.agui.core.message;

/**
 * A message representing communication from a developer or system administrator.
 * <p>
 * This message type is used for communications that originate from developers,
 * system administrators, or other technical personnel. It provides a way to
 * distinguish developer-level messages from regular user messages or assistant
 * responses within the system.
 * </p>
 * <p>
 * Developer messages typically contain technical information, system commands,
 * debugging information, or administrative communications that are intended
 * for technical audiences or system processing.
 * </p>
 *
 * @see BaseMessage
 *
 * @author Pascal Wilbrink
 */
public class DeveloperMessage extends BaseMessage {

    /**
     * Returns the role of this message as "developer".
     * <p>
     * This implementation fulfills the abstract contract from {@link BaseMessage}
     * and identifies this message as originating from a developer or technical user.
     * </p>
     *
     * @return "developer" - the fixed role for developer messages
     */
    public Role getRole() {
        return Role.developer;
    }
}