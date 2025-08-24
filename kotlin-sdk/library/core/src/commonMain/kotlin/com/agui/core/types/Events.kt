package com.agui.core.types

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.Transient
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonClassDiscriminator
import kotlinx.serialization.json.JsonElement

/**
 * Enum defining all possible event types in the AG-UI protocol.
 * Exactly 16 event types as specified in the protocol.
 *
 * Events are grouped by category:
 * - Lifecycle Events (5): RUN_STARTED, RUN_FINISHED, RUN_ERROR, STEP_STARTED, STEP_FINISHED
 * - Text Message Events (3): TEXT_MESSAGE_START, TEXT_MESSAGE_CONTENT, TEXT_MESSAGE_END
 * - Tool Call Events (3): TOOL_CALL_START, TOOL_CALL_ARGS, TOOL_CALL_END
 * - State Management Events (3): STATE_SNAPSHOT, STATE_DELTA, MESSAGES_SNAPSHOT
 * - Special Events (2): RAW, CUSTOM
 *
 * Total: 16 events
 */

@Serializable
enum class EventType {
    // Lifecycle Events
    @SerialName("RUN_STARTED")
    RUN_STARTED,
    @SerialName("RUN_FINISHED")
    RUN_FINISHED,
    @SerialName("RUN_ERROR")
    RUN_ERROR,
    @SerialName("STEP_STARTED")
    STEP_STARTED,
    @SerialName("STEP_FINISHED")
    STEP_FINISHED,

    // Text Message Events
    @SerialName("TEXT_MESSAGE_START")
    TEXT_MESSAGE_START,
    @SerialName("TEXT_MESSAGE_CONTENT")
    TEXT_MESSAGE_CONTENT,
    @SerialName("TEXT_MESSAGE_END")
    TEXT_MESSAGE_END,

    // Tool Call Events
    @SerialName("TOOL_CALL_START")
    TOOL_CALL_START,
    @SerialName("TOOL_CALL_ARGS")
    TOOL_CALL_ARGS,
    @SerialName("TOOL_CALL_END")
    TOOL_CALL_END,

    // State Management Events
    @SerialName("STATE_SNAPSHOT")
    STATE_SNAPSHOT,
    @SerialName("STATE_DELTA")
    STATE_DELTA,
    @SerialName("MESSAGES_SNAPSHOT")
    MESSAGES_SNAPSHOT,

    // Special Events
    @SerialName("RAW")
    RAW,
    @SerialName("CUSTOM")
    CUSTOM

    // Note: The protocol definitions (i.e., events.py and  events.ts) in the current version of
    // the offical AG-UI Python and Typescript SDKs have several additional event types. Specifically
    //
    // TEXT_MESSAGE_CHUNK
    // TOOL_CALL_CHUNK
    // THINKING_TEXT_MESSAGE_START
    // THINKING_TEXT_MESSAGE_CONTENT
    // THINKING_TEXT_MESSAGE_END
    // THINKING_START
    // THINKING_END
    //
    // These are left out for now as they do not appear in the actual protocol documentation,
    // but could be added if needed.
}

/**
 * Base class for all events in the AG-UI protocol.
 * 
 * Events represent real-time notifications from agents about their execution state,
 * message generation, tool calls, and state changes. All events follow a common
 * structure with polymorphic serialization based on the "type" field.
 * 
 * Key Properties:
 * - eventType: The specific type of event (used for pattern matching)
 * - timestamp: Optional timestamp of when the event occurred
 * - rawEvent: Optional raw JSON representation for debugging/logging
 * 
 * Event Categories:
 * - Lifecycle Events: Run and step start/finish/error events
 * - Text Message Events: Streaming text message generation
 * - Tool Call Events: Tool invocation and argument streaming
 * - State Management Events: State snapshots and incremental updates
 * - Special Events: Raw and custom event types
 * 
 * Serialization:
 * Uses @JsonClassDiscriminator("type") for polymorphic serialization where
 * the "type" field determines which specific event class to deserialize to.
 * 
 * @see EventType
 */
@OptIn(ExperimentalSerializationApi::class)
@Serializable
@JsonClassDiscriminator("type")
sealed class BaseEvent {
    /**
     * The type of this event.
     * 
     * This property is used for pattern matching and event handling logic.
     * It is marked as @Transient in implementations because the actual "type"
     * field in JSON comes from the @JsonClassDiscriminator annotation.
     * 
     * @see EventType
     */
    abstract val eventType: EventType
    /**
     * Optional timestamp indicating when this event occurred.
     * 
     * The timestamp is represented as milliseconds since epoch (Unix timestamp).
     * This field may be null if timing information is not available or relevant.
     * 
     * Note: The protocol specification varies between implementations regarding
     * timestamp format, but Long (milliseconds) is used here for consistency
     * with standard timestamp conventions.
     */
    abstract val timestamp: Long?
    /**
     * Optional raw JSON representation of the original event.
     * 
     * This field preserves the original JSON structure of the event as received
     * from the agent. It can be useful for debugging, logging, or handling
     * protocol extensions that aren't yet supported by the typed event classes.
     * 
     * @see JsonElement
     */
    abstract val rawEvent: JsonElement?
}

// ============== Lifecycle Events (5) ==============

/**
 * Event indicating that a new agent run has started.
 * 
 * This event is emitted when an agent begins processing a new run request.
 * It provides the thread and run identifiers that will be used throughout
 * the execution lifecycle.
 * 
 * @param threadId The identifier for the conversation thread
 * @param runId The unique identifier for this specific run
 * @param timestamp Optional timestamp when the run started
 * @param rawEvent Optional raw JSON representation of the event
 */
@Serializable
@SerialName("RUN_STARTED")
data class RunStartedEvent(
    val threadId: String,
    val runId: String,
    override val timestamp: Long? = null,
    override val rawEvent: JsonElement? = null
) : BaseEvent () {
    @Transient
    override val eventType: EventType = EventType.RUN_STARTED
}

/**
 * Event indicating that an agent run has completed successfully.
 * 
 * This event is emitted when an agent has finished processing a run request
 * and has generated all output. It signals the end of the execution lifecycle.
 * 
 * @param threadId The identifier for the conversation thread
 * @param runId The unique identifier for the completed run
 * @param timestamp Optional timestamp when the run finished
 * @param rawEvent Optional raw JSON representation of the event
 */
@Serializable
@SerialName("RUN_FINISHED")
data class RunFinishedEvent(
    val threadId: String,
    val runId: String,
    override val timestamp: Long? = null,
    override val rawEvent: JsonElement? = null
) : BaseEvent () {
    @Transient
    override val eventType: EventType = EventType.RUN_FINISHED
}

/**
 * Event indicating that an agent run has encountered an error.
 * 
 * This event is emitted when an agent run fails due to an unrecoverable error.
 * It provides error details and optional error codes for debugging and handling.
 * 
 * @param message Human-readable error message describing what went wrong
 * @param code Optional error code for programmatic error handling
 * @param timestamp Optional timestamp when the error occurred
 * @param rawEvent Optional raw JSON representation of the event
 */
@Serializable
@SerialName("RUN_ERROR")
data class RunErrorEvent(
    val message: String,
    val code: String? = null,
    override val timestamp: Long? = null,
    override val rawEvent: JsonElement? = null
) : BaseEvent () {
    @Transient
    override val eventType: EventType = EventType.RUN_ERROR
}

/**
 * Event indicating that a new execution step has started.
 * 
 * Steps represent discrete phases of agent execution, such as reasoning,
 * tool calling, or response generation. This event marks the beginning
 * of a named step in the agent's workflow.
 * 
 * @param stepName The name of the step that has started
 * @param timestamp Optional timestamp when the step started
 * @param rawEvent Optional raw JSON representation of the event
 */
@Serializable
@SerialName("STEP_STARTED")
data class StepStartedEvent(
    val stepName: String,
    override val timestamp: Long? = null,
    override val rawEvent: JsonElement? = null
) : BaseEvent () {
    @Transient
    override val eventType: EventType = EventType.STEP_STARTED
}

/**
 * Event indicating that an execution step has completed.
 * 
 * This event marks the end of a named step in the agent's workflow.
 * It can be used to track progress and measure step execution times.
 * 
 * @param stepName The name of the step that has finished
 * @param timestamp Optional timestamp when the step finished
 * @param rawEvent Optional raw JSON representation of the event
 */
@Serializable
@SerialName("STEP_FINISHED")
data class StepFinishedEvent(
    val stepName: String,
    override val timestamp: Long? = null,
    override val rawEvent: JsonElement? = null
) : BaseEvent () {
    @Transient
    override val eventType: EventType = EventType.STEP_FINISHED
}

// ============== Text Message Events (3) ==============

/**
 * Event indicating the start of a streaming text message.
 * 
 * This event is emitted when an agent begins generating a text message response.
 * It provides the message ID that will be used in subsequent content events
 * to build the complete message incrementally.
 * 
 * @param messageId Unique identifier for the message being generated
 * @param timestamp Optional timestamp when message generation started
 * @param rawEvent Optional raw JSON representation of the event
 */
@Serializable
@SerialName("TEXT_MESSAGE_START")
data class TextMessageStartEvent(
    val messageId: String,
    override val timestamp: Long? = null,
    override val rawEvent: JsonElement? = null
) : BaseEvent () {
    @Transient
    override val eventType: EventType = EventType.TEXT_MESSAGE_START
    // Needed for serialization/deserialization for protocol correctness
    val role : String = "assistant"
}

/**
 * Event containing incremental content for a streaming text message.
 * 
 * This event is emitted multiple times during message generation to provide
 * chunks of text content. The delta field contains the new text to append
 * to the message identified by messageId.
 * 
 * @param messageId Unique identifier for the message being updated
 * @param delta The text content to append to the message (must not be empty)
 * @param timestamp Optional timestamp when this content was generated
 * @param rawEvent Optional raw JSON representation of the event
 */
@Serializable
@SerialName("TEXT_MESSAGE_CONTENT")
data class TextMessageContentEvent(
    val messageId: String,
    val delta: String,
    override val timestamp: Long? = null,
    override val rawEvent: JsonElement? = null
) : BaseEvent () {
    @Transient
    override val eventType: EventType = EventType.TEXT_MESSAGE_CONTENT
    init {
        require(delta.isNotEmpty()) { "Text message content delta cannot be empty" }
    }
}

/**
 * Event indicating the completion of a streaming text message.
 * 
 * This event is emitted when an agent has finished generating a text message.
 * No more content events will be sent for the message identified by messageId.
 * 
 * @param messageId Unique identifier for the completed message
 * @param timestamp Optional timestamp when message generation completed
 * @param rawEvent Optional raw JSON representation of the event
 */
@Serializable
@SerialName("TEXT_MESSAGE_END")
data class TextMessageEndEvent(
    val messageId: String,
    override val timestamp: Long? = null,
    override val rawEvent: JsonElement? = null
) : BaseEvent () {
    @Transient
    override val eventType: EventType = EventType.TEXT_MESSAGE_END
}

// ============== Tool Call Events (3) ==============

/**
 * Event indicating the start of a tool call.
 * 
 * This event is emitted when an agent begins invoking a tool. It provides
 * the tool call ID and name, along with an optional parent message ID
 * that indicates which message contains this tool call.
 * 
 * @param toolCallId Unique identifier for this tool call
 * @param toolCallName The name of the tool being called
 * @param parentMessageId Optional ID of the message containing this tool call
 * @param timestamp Optional timestamp when the tool call started
 * @param rawEvent Optional raw JSON representation of the event
 */
@Serializable
@SerialName("TOOL_CALL_START")
data class ToolCallStartEvent(
    val toolCallId: String,
    val toolCallName: String,
    val parentMessageId: String? = null,
    override val timestamp: Long? = null,
    override val rawEvent: JsonElement? = null
) : BaseEvent () {
    @Transient
    override val eventType: EventType = EventType.TOOL_CALL_START
}

/**
 * Event containing incremental arguments for a streaming tool call.
 * 
 * This event is emitted multiple times during tool call generation to provide
 * chunks of the JSON arguments string. The delta field contains additional
 * argument text to append to the tool call identified by toolCallId.
 * 
 * @param toolCallId Unique identifier for the tool call being updated
 * @param delta The argument text to append (may be partial JSON)
 * @param timestamp Optional timestamp when this argument content was generated
 * @param rawEvent Optional raw JSON representation of the event
 */
@Serializable
@SerialName("TOOL_CALL_ARGS")
data class ToolCallArgsEvent(
    val toolCallId: String,
    val delta: String,
    override val timestamp: Long? = null,
    override val rawEvent: JsonElement? = null
) : BaseEvent () {
    @Transient
    override val eventType: EventType = EventType.TOOL_CALL_ARGS
}

/**
 * Event indicating the completion of a tool call's argument generation.
 * 
 * This event is emitted when an agent has finished generating the arguments
 * for a tool call. The arguments should now be complete and valid JSON.
 * This does not indicate that the tool has been executed, only that the
 * agent has finished specifying how to call it.
 * 
 * @param toolCallId Unique identifier for the completed tool call
 * @param timestamp Optional timestamp when argument generation completed
 * @param rawEvent Optional raw JSON representation of the event
 */
@Serializable
@SerialName("TOOL_CALL_END")
data class ToolCallEndEvent(
    val toolCallId: String,
    override val timestamp: Long? = null,
    override val rawEvent: JsonElement? = null
) : BaseEvent () {
    @Transient
    override val eventType: EventType = EventType.TOOL_CALL_END
}

// ============== State Management Events (3) ==============

/**
 * Event containing a complete state snapshot.
 * 
 * This event provides a full replacement of the current agent state.
 * It's typically used for initial state setup or after significant
 * state changes that are easier to represent as a complete replacement
 * rather than incremental updates.
 * 
 * @param snapshot The complete new state as a JSON element
 * @param timestamp Optional timestamp when the snapshot was created
 * @param rawEvent Optional raw JSON representation of the event
 */
@Serializable
@SerialName("STATE_SNAPSHOT")
data class StateSnapshotEvent(
    val snapshot: State,
    override val timestamp: Long? = null,
    override val rawEvent: JsonElement? = null
) : BaseEvent () {
    @Transient
    override val eventType: EventType = EventType.STATE_SNAPSHOT
}

/**
 * Event containing incremental state changes as JSON Patch operations.
 * 
 * This event provides efficient state updates using RFC 6902 JSON Patch format.
 * The delta field contains an array of patch operations (add, remove, replace, etc.)
 * that should be applied to the current state to produce the new state.
 * 
 * @param delta JSON Patch operations array as defined in RFC 6902
 * @param timestamp Optional timestamp when the delta was created
 * @param rawEvent Optional raw JSON representation of the event
 * 
 * @see <a href="https://tools.ietf.org/html/rfc6902">RFC 6902 - JSON Patch</a>
 */
@Serializable
@SerialName("STATE_DELTA")
data class StateDeltaEvent(
    val delta: JsonArray,  // JSON Patch array as defined in RFC 6902
    override val timestamp: Long? = null,
    override val rawEvent: JsonElement? = null
) : BaseEvent () {
    @Transient
    override val eventType: EventType = EventType.STATE_DELTA
}

/**
 * Event containing a complete snapshot of the conversation messages.
 * 
 * This event provides a full replacement of the current message history.
 * It's used when the agent wants to modify the conversation history
 * or when a complete refresh is more efficient than incremental updates.
 * 
 * @param messages The complete list of messages in the conversation
 * @param timestamp Optional timestamp when the snapshot was created
 * @param rawEvent Optional raw JSON representation of the event
 */
@Serializable
@SerialName("MESSAGES_SNAPSHOT")
data class MessagesSnapshotEvent(
    val messages: List<Message>,
    override val timestamp: Long? = null,
    override val rawEvent: JsonElement? = null
) : BaseEvent () {
    @Transient
    override val eventType: EventType = EventType.MESSAGES_SNAPSHOT
}

// ============== Special Events (2) ==============

/**
 * Event containing raw, unprocessed event data.
 * 
 * This event type is used to pass through events that don't fit into
 * the standard event categories or for debugging purposes. The event
 * field contains the original JSON structure, and source provides
 * optional information about where the event originated.
 * 
 * @param event The raw JSON event data
 * @param source Optional identifier for the event source
 * @param timestamp Optional timestamp when the event was created
 * @param rawEvent Optional raw JSON representation of the event
 */
@Serializable
@SerialName("RAW")
data class RawEvent(
    val event: JsonElement,
    val source: String? = null,
    override val timestamp: Long? = null,
    override val rawEvent: JsonElement? = null
) : BaseEvent () {
    @Transient
    override val eventType: EventType = EventType.RAW
}

/**
 * Event for custom, application-specific event types.
 * 
 * This event type allows agents to send custom events that extend
 * the standard protocol. The name field identifies the custom event type,
 * and value contains the event-specific data.
 * 
 * Examples of custom events:
 * - Progress indicators
 * - Debug information
 * - Application-specific notifications
 * - Extension protocol events
 * 
 * @param name The name/type of the custom event
 * @param value The custom event data as JSON
 * @param timestamp Optional timestamp when the event was created
 * @param rawEvent Optional raw JSON representation of the event
 */
@Serializable
@SerialName("CUSTOM")
data class CustomEvent(
    val name: String,
    val value: JsonElement,
    override val timestamp: Long? = null,
    override val rawEvent: JsonElement? = null
) : BaseEvent () {
    @Transient
    override val eventType: EventType = EventType.CUSTOM
}