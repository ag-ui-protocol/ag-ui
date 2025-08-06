package com.agui.types;

public class Context {

    private final String description;
    private final String value;

    public Context(final String description, final String value) {
        this.description = description;
        this.value = value;
    }

    public String getDescription() { return this.description; }
    public String getValue() { return this.value; }
}
