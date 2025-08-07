package io.workm8.agui.message;

public class ToolMessage extends BaseMessage {

    private String toolCallId;
    private String error;

    public String getRole() {
        return "tool";
    }

    public void setToolCallId(final String toolCallId) {
        this.toolCallId = toolCallId;
    }

    public String getToolCallId() {
        return this.toolCallId;
    }

    public void setError(final String error) {
        this.error = error;
    }

    public String getError() {
        return this.error;
    }
}

