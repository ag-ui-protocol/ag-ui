package com.agui.core.context;

import javax.validation.constraints.NotNull;
import java.util.Objects;

/**
 *
 * Represents a context entry containing a description and associated value.
 *
 * @param description a human-readable description of what this context represents.
 *                   Cannot be null.
 * @param value      the actual value or data associated with this context.
 *                   Cannot be null.
 *
 *
 * @author Pascal Wilbrink
 */
public record Context(@NotNull String description, @NotNull String value) {
    /**
     * @throws NullPointerException if description or value is null
     */
    public Context {
        Objects.requireNonNull(description, "description cannot be null");
        Objects.requireNonNull(value, "value cannot be null");
    }

    public String toString() {
        return "%s: %s".formatted(description, value);
    }
}