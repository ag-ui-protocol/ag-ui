package io.workm8.agui.message;

import java.util.UUID;

public abstract class BaseMessage {

    private String id;
    private String content;
    private String name;

    public BaseMessage() {
        this(UUID.randomUUID().toString(), "", "");
    }

    public BaseMessage(final String id, final String content, final String name) {
        this.id = id;
        this.content = content;
        this.name = name;
    }

    public abstract String getRole();

    public void setId(final String id) {
        this.id = id;
    }

    public String getId() {
        return this.id;
    }

    public void setContent(final String content) {
        this.content = content;
    }

    public String getContent() {
        return this.content;
    }

    public void setName(final String name) {
        this.name = name;
    }

    public String getName() {
        return this.name;
    }
}


