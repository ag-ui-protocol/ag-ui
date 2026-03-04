package com.agui.core.type;

/**
 * Enumeration of all supported event types in the AGUI system.
 * <p>
 * This enum defines the complete set of event types that can occur within
 * the application, covering various categories including text messages,
 * thinking processes, tool calls, state management, and execution lifecycle
 * events. Each event type represents a specific kind of system activity
 * or communication.
 * </p>
 * <p>
 * Event types are organized into logical groups:
 * </p>
 * <ul>
 * <li><strong>Text Messages:</strong> Standard message communication events</li>
 * <li><strong>Thinking Messages:</strong> AI reasoning and deliberation events</li>
 * <li><strong>Tool Calls:</strong> Function and tool invocation events</li>
 * <li><strong>Thinking Process:</strong> AI cognitive process lifecycle events</li>
 * <li><strong>State Management:</strong> Application state change events</li>
 * <li><strong>Execution Lifecycle:</strong> Run and step execution events</li>
 * <li><strong>General:</strong> Raw data and custom event types</li>
 * </ul>
 *
 * @see com.agui.core.event.BaseEvent
 *
 * @author Pascal Wilbrink
 */
public enum EventType {
    /** Signals the start of a text message stream */
    TEXT_MESSAGE_START("TEXT_MESSAGE_START"),

    /** Represents incremental text message content */
    TEXT_MESSAGE_CONTENT("TEXT_MESSAGE_CONTENT"),

    /** Signals the end of a text message stream */
    TEXT_MESSAGE_END("TEXT_MESSAGE_END"),

    /** Represents a chunk of text message data */
    TEXT_MESSAGE_CHUNK("TEXT_MESSAGE_CHUNK"),

    /** Signals the start of thinking text message content */
    THINKING_TEXT_MESSAGE_START("THINKING_TEXT_MESSAGE_START"),

    /** Represents thinking text message content */
    THINKING_TEXT_MESSAGE_CONTENT("THINKING_TEXT_MESSAGE_CONTENT"),

    /** Signals the end of thinking text message content */
    THINKING_TEXT_MESSAGE_END("THINKING_TEXT_MESSAGE_END"), // Fixed typo

    /** Signals the start of a tool call */
    TOOL_CALL_START("TOOL_CALL_START"),

    /** Represents tool call arguments being provided */
    TOOL_CALL_ARGS("TOOL_CALL_ARGS"),

    /** Signals the end of a tool call */
    TOOL_CALL_END("TOOL_CALL_END"),

    /** Represents a chunk of tool call data */
    TOOL_CALL_CHUNK("TOOL_CALL_CHUNK"),

    /** Represents the result of a tool call */
    TOOL_CALL_RESULT("TOOL_CALL_RESULT"),

    /** Signals the start of a thinking process */
    THINKING_START("THINKING_START"),

    /** Signals the end of a thinking process */
    THINKING_END("THINKING_END"),

    /** Represents a complete state snapshot */
    STATE_SNAPSHOT("STATE_SNAPSHOT"),

    /** Represents incremental state changes */
    STATE_DELTA("STATE_DELTA"),

    /** Represents a snapshot of messages */
    MESSAGES_SNAPSHOT("MESSAGES_SNAPSHOT"),

    /** Represents raw, unprocessed event data */
    RAW("RAW"),

    /** Represents custom, user-defined events */
    CUSTOM("CUSTOM"),

    /** Signals the start of a run execution */
    RUN_STARTED("RUN_STARTED"),

    /** Signals the completion of a run execution */
    RUN_FINISHED("RUN_FINISHED"),

    /** Represents an error during run execution */
    RUN_ERROR("RUN_ERROR"),

    /** Signals the start of a step execution */
    STEP_STARTED("STEP_STARTED"),

    /** Signals the completion of a step execution */
    STEP_FINISHED("STEP_FINISHED"); // Fixed inconsistent naming

    private final String name;

    /**
     * Creates an EventType with the specified name.
     *
     * @param name the string representation of the event type
     */
    EventType(String name) {
        this.name = name;
    }

    /**
     * Returns the string representation of this event type.
     *
     * @return the event type name
     */
    public String getName() {
        return this.name;
    }
}