package com.agui.core.function;

import java.util.Objects;

/**
 * Represents a function call with its name and arguments.
 * <p>
 * This record provides an immutable data structure for storing information
 * about a function invocation, including the function name and its arguments
 * in string format. It is typically used in scenarios where function calls
 * need to be captured, transmitted, or processed programmatically.
 * </p>
 *
 * @param name      the name of the function to be called. Cannot be null.
 * @param arguments the arguments for the function call, typically in JSON
 *                  or serialized format. Cannot be null.
 *
 * @author Pascal Wilbrink
 */
public record FunctionCall(String name, String arguments) {
    public FunctionCall {
        Objects.requireNonNull(name, "name cannot be null");
    }
}