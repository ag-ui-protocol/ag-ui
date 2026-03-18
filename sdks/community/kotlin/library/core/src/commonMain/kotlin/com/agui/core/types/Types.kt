package com.agui.core.types

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.Transient
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.descriptors.element
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonClassDiscriminator
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/**
 * Custom serializer for UserMessage that handles both string and multimodal content.
 *
 * This serializer enables Union-type behavior similar to Python's Union[str, List[InputContent]]:
 * - When serializing: Uses contentParts array if present, otherwise uses content string
 * - When deserializing: Detects if content is a string or array and constructs appropriately
 *
 * Note: The "role" field is handled by the polymorphic serialization mechanism via
 * @JsonClassDiscriminator on the Message sealed class - we don't include it here.
 */
object UserMessageSerializer : KSerializer<UserMessage> {
    // Use "user" as the serial name to match the @SerialName annotation on UserMessage
    // This is used by the polymorphic discriminator
    override val descriptor: SerialDescriptor = buildClassSerialDescriptor("user") {
        element<String>("id")
        element<JsonElement>("content")
        element<String?>("name", isOptional = true)
    }

    override fun serialize(encoder: Encoder, value: UserMessage) {
        val jsonEncoder = encoder as JsonEncoder
        // Don't include "role" - it's added by the polymorphic discriminator
        val jsonObject = buildJsonObject {
            put("id", value.id)
            if (value.contentParts != null) {
                // Multimodal: serialize as array
                put("content", AgUiJson.encodeToJsonElement(
                    ListSerializer(InputContent.serializer()),
                    value.contentParts
                ))
            } else {
                // Text-only: serialize as string
                put("content", value.content)
            }
            value.name?.let { put("name", it) }
        }
        jsonEncoder.encodeJsonElement(jsonObject)
    }

    override fun deserialize(decoder: Decoder): UserMessage {
        val jsonDecoder = decoder as JsonDecoder
        val jsonObject = jsonDecoder.decodeJsonElement().jsonObject

        val id = jsonObject["id"]?.jsonPrimitive?.content ?: error("Missing id")
        val name = jsonObject["name"]?.jsonPrimitive?.content
        val contentElement = jsonObject["content"] ?: error("Missing content")

        return when (contentElement) {
            is JsonArray -> {
                // Multimodal content
                val parts = AgUiJson.decodeFromJsonElement(
                    ListSerializer(InputContent.serializer()),
                    contentElement
                )
                UserMessage.multimodal(id, parts, name)
            }
            is JsonPrimitive -> {
                // Text content
                UserMessage(id, contentElement.content, name)
            }
            else -> error("Unexpected content type: ${contentElement::class}")
        }
    }
}

/**
 * Base interface for all message types in the AG-UI protocol.
 * The @JsonClassDiscriminator tells the library to use the "role" property
 * to identify which subclass to serialize to or deserialize from.
 */
@OptIn(ExperimentalSerializationApi::class)
@Serializable
@JsonClassDiscriminator("role")
sealed class Message {
    abstract val id: String
    // Necessary to deal with Kotlinx polymorphic serialization; without this, there's a conflict.
    // Note: This property is not serialized due to @Transient on implementations - the "role" field comes from @JsonClassDiscriminator
    abstract val messageRole: Role
    abstract val content: String?
    abstract val name: String?
}


/**
 * Enum representing the possible roles a message sender can have.
 */
@Serializable
enum class Role {
    @SerialName("developer")
    DEVELOPER,
    @SerialName("system")
    SYSTEM,
    @SerialName("assistant")
    ASSISTANT,
    @SerialName("user")
    USER,
    @SerialName("tool")
    TOOL,
    @SerialName("activity")
    ACTIVITY
}

/**
 * Represents a message from a developer/system administrator.
 * 
 * Developer messages are used for system-level instructions, configuration,
 * and administrative communication that differs from regular system prompts.
 * They typically contain meta-instructions about how the agent should behave
 * or technical configuration details.
 * 
 * @param id Unique identifier for this message
 * @param content The developer's message content
 * @param name Optional name/identifier for the developer or system
 */
@Serializable
@SerialName("developer")
data class DeveloperMessage(
    override val id: String,
    override val content: String,
    override val name: String? = null
) : Message() {
    @Transient
    override val messageRole: Role = Role.DEVELOPER
}

/**
 * Represents a system message containing instructions or context.
 * 
 * System messages provide high-level instructions, personality traits,
 * behavioral guidelines, and context that shape how the agent responds.
 * They are typically set at the beginning of a conversation and remain
 * active throughout the interaction.
 * 
 * @param id Unique identifier for this message
 * @param content The system instructions or context (may be null for certain configurations)
 * @param name Optional name/identifier for the system or instruction set
 */
@Serializable
@SerialName("system")
data class SystemMessage(
    override val id: String,
    override val content: String?,
    override val name: String? = null
) : Message() {
    @Transient
    override val messageRole: Role = Role.SYSTEM
}

/**
 * Represents a message from the AI assistant.
 * 
 * Assistant messages contain the agent's responses, which can include:
 * - Text content (responses, explanations, questions)
 * - Tool calls (requests to execute external functions)
 * - Mixed content combining text and tool calls
 * 
 * The message may be built incrementally through streaming events,
 * starting with basic structure and adding content/tool calls over time.
 * 
 * @param id Unique identifier for this message
 * @param content The assistant's text content (may be null if only tool calls)
 * @param name Optional name/identifier for the assistant
 * @param toolCalls Optional list of tool calls made by the assistant
 */
@Serializable
@SerialName("assistant")
data class AssistantMessage(
    override val id: String,
    override val content: String? = null,
    override val name: String? = null,
    val toolCalls: List<ToolCall>? = null
) : Message() {
    @Transient
    override val messageRole: Role = Role.ASSISTANT
}

/**
 * Represents a message from the user/human.
 *
 * User messages contain input from the person interacting with the agent.
 * This includes questions, requests, instructions, and any other human
 * communication that the agent should respond to.
 *
 * The content can be either:
 * - A simple string for text-only messages (use primary constructor)
 * - A list of InputContent parts for multimodal messages (use [multimodal] factory)
 *
 * @param id Unique identifier for this message
 * @param content The user's message content as text
 * @param name Optional name/identifier for the user
 */
@Serializable(with = UserMessageSerializer::class)
@SerialName("user")
data class UserMessage(
    override val id: String,
    override val content: String,
    override val name: String? = null,
    /**
     * Multimodal content parts. When present, [content] is ignored during serialization.
     * Use [multimodal] factory to create multimodal messages.
     */
    @Transient
    val contentParts: List<InputContent>? = null
) : Message() {
    @Transient
    override val messageRole: Role = Role.USER

    /**
     * Returns true if this is a multimodal message.
     */
    val isMultimodal: Boolean
        get() = contentParts != null

    companion object {
        /**
         * Creates a UserMessage with multimodal content parts.
         */
        fun multimodal(id: String, parts: List<InputContent>, name: String? = null): UserMessage =
            UserMessage(id = id, content = "", name = name, contentParts = parts)
    }
}

/**
 * Represents a message containing the result of a tool execution.
 *
 * Tool messages are created after an assistant requests a tool call
 * and the tool has been executed. They contain the results, output,
 * or response from the tool execution, which the assistant can then
 * use to continue the conversation or complete its task.
 *
 * @param id Unique identifier for this message
 * @param content The tool's output or result as text
 * @param toolCallId The ID of the tool call this message responds to
 * @param name Optional name of the tool that generated this message
 * @param error Optional error message if the tool execution failed
 */
@Serializable
@SerialName("tool")
data class ToolMessage(
    override val id: String,
    override val content: String,
    val toolCallId: String,
    override val name: String? = null,
    val error: String? = null
) : Message () {
    @Transient
    override val messageRole: Role = Role.TOOL
}

/**
 * Represents an activity progress message emitted between chat messages.
 *
 * Activity messages are used for streaming structured content that doesn't fit
 * the standard text/tool paradigm, such as A2UI surfaces, progress indicators,
 * or other dynamic UI elements.
 *
 * @param id Unique identifier for this message
 * @param activityType The type of activity (e.g., "a2ui-surface")
 * @param activityContent The activity-specific content as a JSON object
 */
@Serializable
@SerialName("activity")
data class ActivityMessage(
    override val id: String,
    val activityType: String,
    val activityContent: JsonObject
) : Message() {
    @Transient
    override val messageRole: Role = Role.ACTIVITY

    // Activity messages don't have traditional content or name fields
    @Transient
    override val content: String? = null
    @Transient
    override val name: String? = null
}


// ============== Multimodal Input Content Types ==============

/**
 * Base class for multimodal input content in user messages.
 * Uses polymorphic serialization based on the "type" field.
 */
@OptIn(ExperimentalSerializationApi::class)
@Serializable
@JsonClassDiscriminator("type")
sealed class InputContent

/**
 * A text fragment in a multimodal user message.
 *
 * @param text The text content
 */
@Serializable
@SerialName("text")
data class TextInputContent(
    val text: String
) : InputContent()

/**
 * A binary payload reference in a multimodal user message.
 *
 * At least one of id, url, or data must be provided to specify the binary content source.
 *
 * @param mimeType The MIME type of the binary content (e.g., "image/png")
 * @param id Optional identifier for retrieving the binary content
 * @param url Optional URL to fetch the binary content from
 * @param data Optional base64-encoded binary data
 * @param filename Optional original filename of the binary content
 */
@Serializable
@SerialName("binary")
data class BinaryInputContent(
    val mimeType: String,
    val id: String? = null,
    val url: String? = null,
    val data: String? = null,
    val filename: String? = null
) : InputContent() {
    init {
        require(id != null || url != null || data != null) {
            "BinaryInputContent requires id, url, or data to be provided"
        }
    }
}


/**
 * Represents a State - just a simple type alias at least for now
 */

typealias State = JsonElement

/**
 * Represents a tool call made by an agent.
 */
@Serializable
data class ToolCall(
    val id: String,
    val function: FunctionCall
) {
    // We need to rename this field in order for the kotlinx.serialization to work. This
    // insures that it does not clash with the "type" discriminator used in the Events.
    @SerialName("type")
    val callType: String = "function"
}

/**
 * Represents function name and arguments in a tool call.
 */
@Serializable
data class FunctionCall(
    val name: String,
    val arguments: String // JSON-encoded string
)

/**
 * Defines a tool that can be called by an agent.
 *
 * Tools are functions that agents can call to request specific information,
 * perform actions in external systems, ask for human input or confirmation,
 * or access specialized capabilities.
 */

@Serializable
data class Tool(
    val name: String,
    val description: String,
    val parameters: JsonElement // JSON Schema defining the parameters
)

/**
 * Represents a piece of contextual information provided to an agent.
 *
 * Context provides additional information that helps the agent understand
 * the current situation and make better decisions.
 */
@Serializable
data class Context(
    val description: String,
    val value: String
)

/**
 * Input parameters for connecting to an agent.
 * This is the body of the POST request sent to the agent's HTTP endpoint.
 *
 * @param threadId The conversation thread identifier
 * @param runId The unique identifier for this run (may be generated by client or agent)
 * @param parentRunId Optional parent run ID for nested/sub-runs
 * @param state The current state to pass to the agent
 * @param messages The conversation history
 * @param tools Available tools the agent can call
 * @param context Additional context for the agent
 * @param forwardedProps Additional properties to forward to the agent
 */
@Serializable
data class RunAgentInput(
    val threadId: String,
    // Note that, while runId is typically generated by the Agent, it is still required by
    // the protocol. We should therefore respect whatever the agent sends back in the run
    // started event.
    val runId: String,
    val parentRunId: String? = null,
    val state: JsonElement = JsonObject(emptyMap()),
    val messages: List<Message> = emptyList(),
    val tools: List<Tool> = emptyList(),
    val context: List<Context> = emptyList(),
    val forwardedProps: JsonElement = JsonObject(emptyMap())
)
