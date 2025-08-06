package com.agui.message;

public class DeveloperMessage extends BaseMessage {

    public DeveloperMessage(final String id, final String content, final String name) {
        super(id, content, name);
    }

    public String getRole() {
        return "developer";
    }
}
