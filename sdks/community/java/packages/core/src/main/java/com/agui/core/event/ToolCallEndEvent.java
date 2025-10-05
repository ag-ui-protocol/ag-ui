package com.agui.core.event;

import com.agui.core.type.EventType;

/**
 * An event that signals the completion of a tool call.
 * <p>
 * This event is fired when a tool call has finished executing, marking the
 * end of the tool invocation lifecycle. It serves as a completion marker
 * for tool call operations, allowing consumers to know when the tool has
 * finished processing and results are available.
 * </p>
 * <p>
 * The event automatically sets its type to {@link EventType#TOOL_CALL_END}
 * and identifies the completed tool call through its unique identifier.
 * </p>
 *
 * @see BaseEvent
 * @see EventType#TOOL_CALL_END
 * @see ToolCallStartEvent
 * @see ToolCallChunkEvent
 * @see ToolCallArgsEvent
 *
 * @author Pascal Wilbrink
 */
public class ToolCallEndEvent extends BaseEvent {

    private String toolCallId;

    /**
     * Creates a new ToolCallEndEvent with type set to {@link EventType#TOOL_CALL_END}.
     * <p>
     * The timestamp is automatically set to the current time and the tool call ID
     * is initialized as null.
     * </p>
     */
    public ToolCallEndEvent() {
        super(EventType.TOOL_CALL_END);
    }

    /**
     * Sets the unique identifier of the tool call that has completed.
     *
     * @param toolCallId the tool call identifier. Can be null.
     */
    public void setToolCallId(final String toolCallId) {
        this.toolCallId = toolCallId;
    }

    /**
     * Returns the unique identifier of the tool call that has completed.
     *
     * @return the tool call identifier, can be null
     */
    public String getToolCallId() {
        return this.toolCallId;
    }
}