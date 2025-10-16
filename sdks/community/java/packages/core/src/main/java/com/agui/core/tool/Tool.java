package com.agui.core.tool;

import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * Represents a tool that can be invoked within the system.
 * <p>
 * This record provides an immutable data structure for storing tool metadata
 * including its name, description, and parameter schema. Tools are typically
 * functions or services that can be called by AI assistants or other system
 * components to perform specific actions or retrieve information.
 * </p>
 * <p>
 * The parameters field usually contains a schema definition (such as JSON Schema)
 * that describes the expected structure and types of arguments the tool accepts.
 * </p>
 *
 * @param name        the unique name identifier for the tool. Cannot be null.
 * @param description a human-readable description of what the tool does and
 *                    when it should be used. Cannot be null.
 * @param parameters  the parameter schema or definition for the tool, typically
 *                    a JSON Schema object or similar structure. Can be null if
 *                    the tool accepts no parameters.
 *
 * @see ToolCall
 *
 * @author Pascal Wilbrink
 */
public record Tool(String name, String description, ToolParameters parameters) {
    public Tool {
        Objects.requireNonNull(name, "name cannot be null");
    }

    public record ToolParameters(String type, Map<String, ToolProperty> properties, List<String> required) { }

    public record ToolProperty(String type, String description) { }
}

