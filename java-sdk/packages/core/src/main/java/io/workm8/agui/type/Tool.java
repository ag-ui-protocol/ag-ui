package io.workm8.agui.type;

public class Tool {
    private final String name;
    private final String description;
    private final Object parameters;

    public Tool(
        final String name,
        final String description,
        final Object parameters
    ) {
        this.name = name;
        this.description = description;
        this.parameters = parameters;
    }
}