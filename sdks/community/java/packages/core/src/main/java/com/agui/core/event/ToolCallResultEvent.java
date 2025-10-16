package com.agui.core.event;

import com.agui.core.message.Role;
import com.agui.core.type.EventType;

/**
 * An event that represents the result of a completed tool call.
 * <p>
 * This event is fired when a tool call has finished executing and carries
 * the result content along with metadata for correlation and context. It
 * provides the output from the tool execution along with identifiers to
 * link the result back to the original tool call and associated messages.
 * </p>
 * <p>
 * The event automatically sets its type to {@link EventType#TOOL_CALL_RESULT}
 * and includes comprehensive information about the tool call result including
 * content, identifiers, and role information.
 * </p>
 *
 * @see BaseEvent
 * @see EventType#TOOL_CALL_RESULT
 * @see ToolCallStartEvent
 * @see ToolCallEndEvent
 * @see ToolCallChunkEvent
 *
 * @author Pascal Wilbrink
 */
public class ToolCallResultEvent extends BaseEvent {

    private String toolCallId;
    private String content;
    private String messageId;
    private Role role;

    /**
     * Creates a new ToolCallResultEvent with type set to {@link EventType#TOOL_CALL_RESULT}.
     * <p>
     * The timestamp is automatically set to the current time and all fields
     * are initialized as null.
     * </p>
     */
    public ToolCallResultEvent() {
        super(EventType.TOOL_CALL_RESULT);
    }

    /**
     * Sets the unique identifier of the tool call that produced this result.
     *
     * @param toolCallId the tool call identifier. Can be null.
     */
    public void setToolCallId(final String toolCallId) {
        this.toolCallId = toolCallId;
    }

    /**
     * Returns the unique identifier of the tool call that produced this result.
     *
     * @return the tool call identifier, can be null
     */
    public String getToolCallId() {
        return this.toolCallId;
    }

    /**
     * Sets the content of the tool call result.
     *
     * @param content the result content from the tool execution. Can be null.
     */
    public void setContent(final String content) {
        this.content = content;
    }

    /**
     * Returns the content of the tool call result.
     *
     * @return the result content, can be null
     */
    public String getContent() {
        return this.content;
    }

    /**
     * Sets the message identifier associated with this tool call result.
     *
     * @param messageId the message identifier. Can be null.
     */
    public void setMessageId(final String messageId) {
        this.messageId = messageId;
    }

    /**
     * Returns the message identifier associated with this tool call result.
     *
     * @return the message identifier, can be null
     */
    public String getMessageId() {
        return this.messageId;
    }

    /**
     * Sets the role associated with this tool call result (e.g., "tool", "function").
     *
     * @param role the role identifier. Can be null.
     */
    public void setRole(final Role role) {
        this.role = role;
    }

    /**
     * Returns the role associated with this tool call result.
     *
     * @return the role identifier, can be null
     */
    public Role getRole() {
        return this.role;
    }
}