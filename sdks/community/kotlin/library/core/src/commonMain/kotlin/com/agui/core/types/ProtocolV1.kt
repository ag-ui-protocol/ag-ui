package com.agui.core.types

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonClassDiscriminator
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

const val AG_UI_PROTOCOL_VERSION: String = "1.0"
const val MAX_SAFE_JSON_INTEGER: Long = 9_007_199_254_740_991L

typealias Metadata = JsonObject

@Serializable
data class TokenUsage(
    val provider: String? = null,
    val model: String? = null,
    val inputTokens: Long? = null,
    val outputTokens: Long? = null,
    val totalTokens: Long? = null,
    val reasoningTokens: Long? = null,
    val cachedInputTokens: Long? = null,
    val cacheWriteInputTokens: Long? = null,
) {
    init {
        listOfNotNull(
            inputTokens,
            outputTokens,
            totalTokens,
            reasoningTokens,
            cachedInputTokens,
            cacheWriteInputTokens,
        ).forEach { count ->
            require(count in 0..MAX_SAFE_JSON_INTEGER) {
                "Token counts must be non-negative JSON safe integers"
            }
        }
    }
}

@OptIn(ExperimentalSerializationApi::class)
@Serializable
@JsonClassDiscriminator("type")
sealed class PartSource

@Serializable
@SerialName("data")
data class DataSource(
    val value: String,
    val mimeType: String,
) : PartSource()

@Serializable
@SerialName("url")
data class UrlSource(
    val value: String,
    val mimeType: String? = null,
) : PartSource()

@Serializable
@SerialName("file")
data class FileSource(
    val value: String,
    val provider: String? = null,
    val mimeType: String? = null,
) : PartSource()

@OptIn(ExperimentalSerializationApi::class)
@Serializable
@JsonClassDiscriminator("type")
sealed class ContentPart {
    abstract val id: String?
    abstract val metadata: JsonElement?
}

@Serializable
@SerialName("text")
data class TextPart(
    val text: String,
    override val id: String? = null,
    override val metadata: JsonElement? = null,
) : ContentPart()

@Serializable
@SerialName("image")
data class ImagePart(
    val source: PartSource,
    override val id: String? = null,
    override val metadata: JsonElement? = null,
) : ContentPart()

@Serializable
@SerialName("audio")
data class AudioPart(
    val source: PartSource,
    override val id: String? = null,
    override val metadata: JsonElement? = null,
) : ContentPart()

@Serializable
@SerialName("video")
data class VideoPart(
    val source: PartSource,
    override val id: String? = null,
    override val metadata: JsonElement? = null,
) : ContentPart()

@Serializable
@SerialName("document")
data class DocumentPart(
    val source: PartSource,
    override val id: String? = null,
    override val metadata: JsonElement? = null,
) : ContentPart()

@Serializable
data class SubagentInfo(
    val name: String,
    val description: String? = null,
)

@Serializable
data class IdentityCapabilities(
    val name: String? = null,
    val type: String? = null,
    val description: String? = null,
    val version: String? = null,
    val provider: String? = null,
    val documentationUrl: String? = null,
    val metadata: Metadata? = null,
)

@Serializable
data class TransportCapabilities(
    val streaming: Boolean? = null,
    val websocket: Boolean? = null,
    val httpBinary: Boolean? = null,
    val pushNotifications: Boolean? = null,
    val resumable: Boolean? = null,
)

@Serializable
data class ToolsCapabilities(
    val supported: Boolean? = null,
    val items: List<Tool>? = null,
    val parallelCalls: Boolean? = null,
    val clientProvided: Boolean? = null,
)

@Serializable
data class OutputCapabilities(
    val structuredOutput: Boolean? = null,
    val supportedMimeTypes: List<String>? = null,
)

@Serializable
data class StateCapabilities(
    val snapshots: Boolean? = null,
    val deltas: Boolean? = null,
    val memory: Boolean? = null,
    val persistentState: Boolean? = null,
)

@Serializable
data class MultiAgentCapabilities(
    val supported: Boolean? = null,
    val delegation: Boolean? = null,
    val handoffs: Boolean? = null,
    val subagents: List<SubagentInfo>? = null,
)

@Serializable
data class ReasoningCapabilities(
    val supported: Boolean? = null,
    val streaming: Boolean? = null,
    val encrypted: Boolean? = null,
)

@Serializable
data class MultimodalInputCapabilities(
    val image: Boolean? = null,
    val audio: Boolean? = null,
    val video: Boolean? = null,
    val pdf: Boolean? = null,
    val file: Boolean? = null,
)

@Serializable
data class MultimodalOutputCapabilities(
    val image: Boolean? = null,
    val audio: Boolean? = null,
)

@Serializable
data class MultimodalCapabilities(
    val input: MultimodalInputCapabilities? = null,
    val output: MultimodalOutputCapabilities? = null,
)

@Serializable
data class ExecutionCapabilities(
    val codeExecution: Boolean? = null,
    val sandboxed: Boolean? = null,
    val maxIterations: Long? = null,
    val maxExecutionTime: Long? = null,
) {
    init {
        listOfNotNull(maxIterations, maxExecutionTime).forEach { value ->
            require(value in 0..MAX_SAFE_JSON_INTEGER) {
                "Execution limits must be non-negative JSON safe integers"
            }
        }
    }
}

@Serializable
data class HumanInTheLoopCapabilities(
    val supported: Boolean? = null,
    val approvals: Boolean? = null,
    val interventions: Boolean? = null,
    val feedback: Boolean? = null,
    val interrupts: Boolean? = null,
    val approveWithEdits: Boolean? = null,
)

@Serializable
data class AgentCapabilities(
    val identity: IdentityCapabilities? = null,
    val transport: TransportCapabilities? = null,
    val tools: ToolsCapabilities? = null,
    val output: OutputCapabilities? = null,
    val state: StateCapabilities? = null,
    val multiAgent: MultiAgentCapabilities? = null,
    val reasoning: ReasoningCapabilities? = null,
    val multimodal: MultimodalCapabilities? = null,
    val execution: ExecutionCapabilities? = null,
    val humanInTheLoop: HumanInTheLoopCapabilities? = null,
    val custom: JsonObject? = null,
)
