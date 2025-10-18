package com.agui.json.mixins;

import com.fasterxml.jackson.annotation.JsonSubTypes;
import com.fasterxml.jackson.annotation.JsonTypeInfo;
import com.agui.core.event.*;

/**
 * Jackson mixin interface for configuring JSON serialization of BaseEvent and its subclasses.
 * <p>
 * EventMixin provides Jackson annotations to enable proper polymorphic serialization and
 * deserialization of the entire agui event hierarchy. This mixin uses type information
 * based on the event's "type" property to maintain type safety during JSON processing.
 * <p>
 * The mixin configures Jackson to:
 * <ul>
 * <li>Use the "type" property as the type discriminator</li>
 * <li>Map each event type name to its corresponding Java class</li>
 * <li>Preserve complete type information during serialization</li>
 * <li>Reconstruct the correct event subclass during deserialization</li>
 * </ul>
 * <p>
 * Supported event types and their mappings:
 * <ul>
 * <li>Run lifecycle: RUN_STARTED, RUN_FINISHED, RUN_ERROR</li>
 * <li>Step management: STEP_STARTED, STEP_FINISHED</li>
 * <li>Message events: TEXT_MESSAGE_START, TEXT_MESSAGE_CONTENT, TEXT_MESSAGE_CHUNK, TEXT_MESSAGE_END</li>
 * <li>Tool execution: TOOL_CALL_START, TOOL_CALL_ARGS, TOOL_CALL_CHUNK, TOOL_CALL_END, TOOL_CALL_RESULT</li>
 * <li>Thinking process: THINKING_START, THINKING_END, THINKING_TEXT_MESSAGE_START, THINKING_TEXT_MESSAGE_CONTENT, THINKING_TEXT_MESSAGE_END</li>
 * <li>State management: STATE_SNAPSHOT, STATE_DELTA, MESSAGES_SNAPSHOT</li>
 * <li>Generic: CUSTOM, RAW</li>
 * </ul>
 * <p>
 * This mixin enables seamless JSON serialization of event objects regardless of their
 * specific subclass, making it possible to serialize mixed collections of events and
 * deserialize them back to their original types correctly.
 * <p>
 * The mixin is applied to BaseEvent and affects all its subclasses through Jackson's
 * inheritance mechanism, providing consistent JSON handling across the entire event
 * hierarchy without requiring modifications to the core event classes.
 * <p>
 * Example JSON output:
 * <pre>{@code
 * {
 *   "type": "TEXT_MESSAGE_START",
 *   "messageId": "msg-123",
 *   "role": "assistant",
 *   "timestamp": "2023-12-01T10:30:00Z"
 * }
 * }</pre>
 *
 * @author Pascal Wilbrink
 */
@JsonTypeInfo(
    use = JsonTypeInfo.Id.NAME,
    property = "type"
)
@JsonSubTypes({
    @JsonSubTypes.Type(value = CustomEvent.class, name = "CUSTOM"),
    @JsonSubTypes.Type(value = MessagesSnapshotEvent.class, name = "MESSAGES_SNAPSHOT"),
    @JsonSubTypes.Type(value = RawEvent.class, name = "RAW"),
    @JsonSubTypes.Type(value = RunErrorEvent.class, name = "RUN_ERROR"),
    @JsonSubTypes.Type(value = RunFinishedEvent.class, name = "RUN_FINISHED"),
    @JsonSubTypes.Type(value = RunStartedEvent.class, name = "RUN_STARTED"),
    @JsonSubTypes.Type(value = StateDeltaEvent.class, name = "STATE_DELTA"),
    @JsonSubTypes.Type(value = StateSnapshotEvent.class, name = "STATE_SNAPSHOT"),
    @JsonSubTypes.Type(value = StepFinishedEvent.class, name = "STEP_FINISHED"),
    @JsonSubTypes.Type(value = StepStartedEvent.class, name = "STEP_STARTED"),
    @JsonSubTypes.Type(value = TextMessageChunkEvent.class, name = "TEXT_MESSAGE_CHUNK"),
    @JsonSubTypes.Type(value = TextMessageContentEvent.class, name = "TEXT_MESSAGE_CONTENT"),
    @JsonSubTypes.Type(value = TextMessageEndEvent.class, name = "TEXT_MESSAGE_END"),
    @JsonSubTypes.Type(value = TextMessageStartEvent.class, name = "TEXT_MESSAGE_START"),
    @JsonSubTypes.Type(value = ThinkingEndEvent.class, name = "THINKING_END"),
    @JsonSubTypes.Type(value = ThinkingStartEvent.class, name = "THINKING_START"),
    @JsonSubTypes.Type(value = ThinkingTextMessageContentEvent.class, name = "THINKING_TEXT_MESSAGE_CONTENT"),
    @JsonSubTypes.Type(value = ThinkingTextMessageEndEvent.class, name = "THINKING_TEXT_MESSAGE_END"),
    @JsonSubTypes.Type(value = ThinkingTextMessageStartEvent.class, name = "THINKING_TEXT_MESSAGE_START"),
    @JsonSubTypes.Type(value = ToolCallArgsEvent.class, name = "TOOL_CALL_ARGS"),
    @JsonSubTypes.Type(value = ToolCallChunkEvent.class, name = "TOOL_CALL_CHUNK"),
    @JsonSubTypes.Type(value = ToolCallEndEvent.class, name = "TOOL_CALL_END"),
    @JsonSubTypes.Type(value = ToolCallResultEvent.class, name = "TOOL_CALL_RESULT"),
    @JsonSubTypes.Type(value = ToolCallStartEvent.class, name = "TOOL_CALL_START")
})
public interface EventMixin {
}