package com.agui.core.types

import kotlinx.serialization.*
import kotlinx.serialization.json.*

internal fun JsonObject.optionalString(key: String): String? {
    val value = get(key)?.takeUnless { it is JsonNull } ?: return null
    require(value is JsonPrimitive && value.isString) { "$key must be a string" }
    return value.content
}

object RunStartedEventSerializer : KSerializer<RunStartedEvent> {
    private val wire = RunStartedWire.serializer()
    override val descriptor = wire.descriptor
    override fun serialize(encoder: kotlinx.serialization.encoding.Encoder, value: RunStartedEvent) =
        encoder.encodeSerializableValue(wire, RunStartedWire(value.threadId, value.runId,
            value.protocolVersion, value.parentRunId, value.input, value.timestamp, value.rawEvent, value.metadata))
    override fun deserialize(decoder: kotlinx.serialization.encoding.Decoder): RunStartedEvent {
        val v = decoder.decodeSerializableValue(wire)
        return RunStartedEvent(v.threadId, v.runId, v.protocolVersion, v.parentRunId, v.input, v.timestamp, v.rawEvent, v.metadata)
    }
}

@OptIn(ExperimentalSerializationApi::class)
@Serializable
@SerialName("RUN_STARTED")
private data class RunStartedWire(
    val threadId: String,
    val runId: String,
    @EncodeDefault(EncodeDefault.Mode.NEVER) val protocolVersion: String? = null,
    val parentRunId: String? = null,
    val input: RunAgentInput? = null,
    val timestamp: Long? = null,
    val rawEvent: JsonElement? = null,
    val metadata: Metadata? = null,
)
