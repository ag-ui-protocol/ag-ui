package com.agui.core.types

import kotlinx.serialization.EncodeDefault
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** Keeps legacy binary payloads intact without declaring them to be AG-UI 1.0. */
object RunAgentInputSerializer : KSerializer<RunAgentInput> {
    private val wireSerializer = RunAgentInputWire.serializer()

    override val descriptor: SerialDescriptor = wireSerializer.descriptor

    override fun serialize(encoder: Encoder, value: RunAgentInput) {
        val protocolVersion = if (value.protocolVersion == AG_UI_PROTOCOL_VERSION && value.hasLegacyBinaryParts()) {
            null
        } else {
            value.protocolVersion
        }
        encoder.encodeSerializableValue(
            wireSerializer,
            RunAgentInputWire(
                threadId = value.threadId,
                runId = value.runId,
                protocolVersion = protocolVersion,
                parentRunId = value.parentRunId,
                state = value.state,
                messages = value.messages,
                tools = value.tools,
                context = value.context,
                forwardedProps = value.forwardedProps,
                resume = value.resume,
            ),
        )
    }

    override fun deserialize(decoder: Decoder): RunAgentInput {
        val wire = decoder.decodeSerializableValue(wireSerializer)
        return RunAgentInput(
            threadId = wire.threadId,
            runId = wire.runId,
            protocolVersion = wire.protocolVersion,
            parentRunId = wire.parentRunId,
            state = wire.state,
            messages = wire.messages,
            tools = wire.tools,
            context = wire.context,
            forwardedProps = wire.forwardedProps,
            resume = wire.resume,
        )
    }
}

private fun RunAgentInput.hasLegacyBinaryParts(): Boolean = messages.any { message ->
    val parts = when (message) {
        is UserMessage -> message.contentParts
        is ToolMessage -> message.contentParts
        else -> null
    }
    parts?.any { it is BinaryInputContent } == true
}

// A generated serializer retains the caller's strict/tolerant unknown-key policy.
// An absent version must remain absent when a pre-version input is re-encoded.
@OptIn(ExperimentalSerializationApi::class)
@Serializable
@SerialName("com.agui.core.types.RunAgentInput")
private data class RunAgentInputWire(
    val threadId: String,
    val runId: String,
    @EncodeDefault(EncodeDefault.Mode.NEVER)
    val protocolVersion: String? = null,
    val parentRunId: String? = null,
    val state: JsonElement = JsonObject(emptyMap()),
    @EncodeDefault(EncodeDefault.Mode.ALWAYS)
    val messages: List<Message> = emptyList(),
    val tools: List<Tool> = emptyList(),
    val context: List<Context> = emptyList(),
    val forwardedProps: JsonElement = JsonObject(emptyMap()),
    val resume: List<ResumeEntry>? = null,
)
