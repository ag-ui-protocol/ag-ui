package io.workm8.agui4j.core.message;

public enum Role {
    Assistant("Assistant"),
    Developer("Developer"),
    System("System"),
    Tool("Tool"),
    User("User")
    ;

    private String name;

    Role(final String name) {
        this.name = name;
    }

}
