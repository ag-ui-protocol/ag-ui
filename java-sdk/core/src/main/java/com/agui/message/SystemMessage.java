package com.agui.message;

public class SystemMessage extends BaseMessage {

    public SystemMessage(final String id, final String content, final String name) {
        super(id, content, name);
    }

    public String getRole() {
        return "system";
    }
}
