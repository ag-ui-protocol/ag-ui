package com.agui.core.tool;

import com.agui.core.function.FunctionCall;

import java.util.Objects;

/**
 * Represents an invocation of a tool with its execution details.
 * <p>
 * This record provides an immutable data structure for storing information
 * about a specific tool call, including its unique identifier, type, and
 * the function call details. It represents the actual invocation of a tool,
 * as opposed to the tool definition itself.
 * </p>
 * <p>
 * Tool calls are typically generated when an AI assistant or system component
 * decides to invoke a specific tool to accomplish a task. The function call
 * contains the specific method name and arguments for the invocation.
 * </p>
 *
 * @param id       the unique identifier for this specific tool call instance.
 *                 Cannot be null.
 * @param type     the type or category of the tool call (e.g., "function").
 *                 Cannot be null.
 * @param function the function call details including name and arguments.
 *                 Cannot be null.
 *
 * @see Tool
 * @see FunctionCall
 *
 * @author Pascal Wilbrink
 */
public record ToolCall(String id, String type, FunctionCall function) {
    public ToolCall {
        Objects.requireNonNull(id, "id cannot be null");
        Objects.requireNonNull(type, "type cannot be null");
    }
}