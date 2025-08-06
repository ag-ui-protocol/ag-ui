package com.agui.message;

public abstract class BaseMessage {

    private final String id;
    private final String content;
    private final String name;

    public BaseMessage(
        final String id,
        final String content,
        final String name
    ) {
        this.id = id;
        this.content = content;
        this.name = name;
    }

    public abstract String getRole();
}


