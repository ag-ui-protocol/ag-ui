package com.agui.core.event;

import com.agui.core.type.EventType;

/**
 * An event that signals the initiation of a tool call.
 * <p>
 * This event is fired when a tool call begins execution, marking the start
 * of the tool invocation lifecycle. It provides essential metadata about
 * the tool call including its identifier, the name of the tool being invoked,
 * and the parent message that triggered the tool call.
 * </p>
 * <p>
 * The event automatically sets its type to {@link EventType#TOOL_CALL_START}
 * and establishes the context for the tool call execution that will follow.
 * </p>
 *
 * @see BaseEvent
 * @see EventType#TOOL_CALL_START
 * @see ToolCallEndEvent
 * @see ToolCallChunkEvent
 * @see ToolCallResultEvent
 *
 * @author Pascal Wilbrink
 */
public class ToolCallStartEvent extends BaseEvent {

    private String toolCallId;
    private String toolCallName;
    private String parentMessageId;

    /**
     * Creates a new ToolCallStartEvent with type set to {@link EventType#TOOL_CALL_START}.
     * <p>
     * The timestamp is automatically set to the current time and all fields
     * are initialized as null.
     * </p>
     */
    public ToolCallStartEvent() {
        super(EventType.TOOL_CALL_START);
    }

    /**
     * Sets the unique identifier for the tool call being started.
     *
     * @param toolCallId the tool call identifier. Can be null.
     */
    public void setToolCallId(final String toolCallId) {
        this.toolCallId = toolCallId;
    }

    /**
     * Returns the unique identifier for the tool call being started.
     *
     * @return the tool call identifier, can be null
     */
    public String getToolCallId() {
        return this.toolCallId;
    }

    /**
     * Sets the name of the tool being called.
     *
     * @param toolCallName the name of the tool. Can be null.
     */
    public void setToolCallName(final String toolCallName) {
        this.toolCallName = toolCallName;
    }

    /**
     * Returns the name of the tool being called.
     *
     * @return the tool name, can be null
     */
    public String getToolCallName() {
        return this.toolCallName;
    }

    /**
     * Sets the identifier of the parent message that initiated this tool call.
     *
     * @param parentMessageId the parent message identifier. Can be null.
     */
    public void setParentMessageId(final String parentMessageId) {
        this.parentMessageId = parentMessageId;
    }

    /**
     * Returns the identifier of the parent message that initiated this tool call.
     *
     * @return the parent message identifier, can be null
     */
    public String getParentMessageId() {
        return this.parentMessageId;
    }
}