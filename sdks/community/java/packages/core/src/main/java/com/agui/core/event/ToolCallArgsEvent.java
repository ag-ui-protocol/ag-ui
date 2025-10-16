package com.agui.core.event;

import com.agui.core.type.EventType;

/**
 * An event that represents incremental arguments being provided to a tool call.
 * <p>
 * This event is fired when arguments for a tool call are being streamed or
 * built incrementally. It allows for real-time tracking of tool call argument
 * construction, particularly useful in scenarios where complex arguments are
 * being generated progressively by an AI system.
 * </p>
 * <p>
 * The event automatically sets its type to {@link EventType#TOOL_CALL_ARGS}
 * and provides fields to identify the specific tool call and deliver argument
 * content incrementally through deltas.
 * </p>
 *
 * @see BaseEvent
 * @see EventType#TOOL_CALL_ARGS
 * @see ToolCallStartEvent
 * @see ToolCallEndEvent
 *
 * @author Pascal Wilbrink
 */
public class ToolCallArgsEvent extends BaseEvent {

    private String toolCallId;
    private String delta;

    /**
     * Creates a new ToolCallArgsEvent with type set to {@link EventType#TOOL_CALL_ARGS}.
     * <p>
     * The timestamp is automatically set to the current time and both fields
     * are initialized as null.
     * </p>
     */
    public ToolCallArgsEvent() {
        super(EventType.TOOL_CALL_ARGS);
    }

    /**
     * Sets the unique identifier of the tool call these arguments belong to.
     *
     * @param toolCallId the tool call identifier. Can be null.
     */
    public void setToolCallId(final String toolCallId) {
        this.toolCallId = toolCallId;
    }

    /**
     * Returns the unique identifier of the tool call these arguments belong to.
     *
     * @return the tool call identifier, can be null
     */
    public String getToolCallId() {
        return this.toolCallId;
    }

    /**
     * Sets the incremental argument content for this tool call.
     *
     * @param delta the argument content delta. Can be null.
     */
    public void setDelta(final String delta) {
        this.delta = delta;
    }

    /**
     * Returns the incremental argument content for this tool call.
     *
     * @return the argument content delta, can be null
     */
    public String getDelta() {
        return this.delta;
    }
}