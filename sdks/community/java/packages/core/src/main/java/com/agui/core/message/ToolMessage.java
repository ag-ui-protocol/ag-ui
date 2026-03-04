package com.agui.core.message;

/**
 * A message representing the result or response from a tool execution.
 * <p>
 * This message type is used to communicate the results of tool calls back
 * to the system. It contains the output from tool executions, whether
 * successful results or error information. The tool call identifier links
 * this message back to the original tool invocation for proper correlation.
 * </p>
 * <p>
 * Tool messages can contain either successful execution results in the
 * inherited content field, or error information when tool execution fails.
 * This allows for comprehensive tool execution feedback within the system.
 * </p>
 *
 * @see BaseMessage
 * @see com.agui.core.tool.ToolCall
 *
 * @author Pascal Wilbrink
 */
public class ToolMessage extends BaseMessage {

    private String toolCallId;
    private String error;

    /**
     * Returns the role of this message as "tool".
     * <p>
     * This implementation fulfills the abstract contract from {@link BaseMessage}
     * and identifies this message as originating from a tool execution.
     * </p>
     *
     * @return "tool" - the fixed role for tool messages
     */
    public Role getRole() {
        return Role.tool;
    }

    /**
     * Sets the identifier of the tool call that produced this message.
     *
     * @param toolCallId the tool call identifier for correlation. Can be null.
     */
    public void setToolCallId(final String toolCallId) {
        this.toolCallId = toolCallId;
    }

    /**
     * Returns the identifier of the tool call that produced this message.
     *
     * @return the tool call identifier, can be null
     */
    public String getToolCallId() {
        return this.toolCallId;
    }

    /**
     * Sets the error message if the tool execution failed.
     *
     * @param error the error description. Can be null if execution was successful.
     */
    public void setError(final String error) {
        this.error = error;
    }

    /**
     * Returns the error message if the tool execution failed.
     *
     * @return the error description, null if execution was successful
     */
    public String getError() {
        return this.error;
    }
}