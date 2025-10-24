package com.agui.core.event;

import com.agui.core.type.EventType;

/**
 * An event that represents a chunk of data in a streaming tool call.
 * <p>
 * This event is fired when tool call information is being delivered incrementally
 * in chunks, typically during streaming scenarios where tool calls are being
 * constructed progressively. It provides comprehensive metadata about the tool
 * call including its identifier, name, parent message context, and incremental
 * content data.
 * </p>
 * <p>
 * The event automatically sets its type to {@link EventType#TOOL_CALL_CHUNK}
 * and enables detailed tracking of tool call construction with full context
 * information for correlation and debugging purposes.
 * </p>
 *
 * @see BaseEvent
 * @see EventType#TOOL_CALL_CHUNK
 * @see ToolCallArgsEvent
 * @see ToolCallStartEvent
 * @see ToolCallEndEvent
 *
 * @author Pascal Wilbrink
 */
public class ToolCallChunkEvent extends BaseEvent {

    private String toolCallId;
    private String toolCallName;
    private String parentMessageId;
    private String delta;

    /**
     * Creates a new ToolCallChunkEvent with type set to {@link EventType#TOOL_CALL_CHUNK}.
     * <p>
     * The timestamp is automatically set to the current time and all fields
     * are initialized as null.
     * </p>
     */
    public ToolCallChunkEvent() {
        super(EventType.TOOL_CALL_CHUNK);
    }

    /**
     * Sets the unique identifier of the tool call this chunk belongs to.
     *
     * @param toolCallId the tool call identifier. Can be null.
     */
    public void setToolCallId(final String toolCallId) {
        this.toolCallId = toolCallId;
    }

    /**
     * Returns the unique identifier of the tool call this chunk belongs to.
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

    /**
     * Sets the incremental content data for this tool call chunk.
     *
     * @param delta the content delta. Can be null.
     */
    public void setDelta(final String delta) {
        this.delta = delta;
    }

    /**
     * Returns the incremental content data for this tool call chunk.
     *
     * @return the content delta, can be null
     */
    public String getDelta() {
        return this.delta;
    }
}