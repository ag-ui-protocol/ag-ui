package com.agui.message;

public class AssistantMessage extends BaseMessage {

    public AssistantMessage(final String id, final String content, final String name) {
        super(id, content, name);
    }

    public String getRole() {
        return "assistant";
    }
}
