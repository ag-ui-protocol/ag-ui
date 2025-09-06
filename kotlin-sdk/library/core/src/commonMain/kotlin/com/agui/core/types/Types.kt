package com.agui.core.types

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.Transient
import kotlinx.serialization.json.JsonClassDiscriminator
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

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
    TOOL
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
 * @param id Unique identifier for this message
 * @param content The user's message content
 * @param name Optional name/identifier for the user
 */
@Serializable
@SerialName("user")
data class UserMessage(
    override val id: String,
    override val content: String,
    override val name: String? = null
) : Message () {
    @Transient
    override val messageRole: Role = Role.USER
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
 */
@Serializable
@SerialName("tool")
data class ToolMessage(
    override val id: String,
    override val content: String,
    val toolCallId: String,
    override val name: String? = null
) : Message () {
    @Transient
    override val messageRole: Role = Role.TOOL
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
 */
@Serializable
data class RunAgentInput(
    val threadId: String,
    // Not that, while runId is typically generated by the Agent, it is still required by
    // the protocol.  We should therefore respect whatever the agent sends back in the run
    // started event.
    val runId: String,
    val state: JsonElement = JsonObject(emptyMap()),
    val messages: List<Message> = emptyList(),
    val tools: List<Tool> = emptyList(),
    val context: List<Context> = emptyList(),
    val forwardedProps: JsonElement = JsonObject(emptyMap())
)
