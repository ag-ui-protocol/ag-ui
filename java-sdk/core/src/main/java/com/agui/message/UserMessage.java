package com.agui.message;

public class UserMessage extends BaseMessage {

    public UserMessage(final String id, final String content, final String name) {
        super(id, content, name);
    }

    public String getRole() {
        return "user";
    }
}
