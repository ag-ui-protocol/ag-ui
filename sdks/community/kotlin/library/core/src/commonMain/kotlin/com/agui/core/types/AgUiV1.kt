package com.agui.core.types

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.descriptors.*
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.serializer

/**
 * Strict AG-UI 1.0 decoding. [AgUiJson] remains the compatibility reader for
 * existing applications; new protocol boundaries should use this object.
 */
object AgUiV1 {
    fun decodeEvent(value: JsonElement): BaseEvent = decode(BaseEvent.serializer(), "event", value)
    fun decodeMessage(value: JsonElement): Message = decode(Message.serializer(), "message", value)
    fun decodeRunAgentInput(value: JsonElement): RunAgentInput =
        decode(RunAgentInput.serializer(), "RunAgentInput", value)

    fun <T> decode(serializer: KSerializer<T>, target: String, value: JsonElement): T {
        validate(target, value)
        val input = if (target == "FileSource") {
            JsonObject(value.jsonObject - "type")
        } else {
            normalizeUsage(target, value)
        }
        return AgUiStrictJson.decodeFromJsonElement(serializer, normalizePrimitives(serializer.descriptor, input))
    }

    /** Validate rules that Kotlin nullable/default properties cannot express. */
    fun validate(target: String, value: JsonElement) {
        // Opaque roots carry application keys, including nulls and protocol-looking names.
        if (target == "State" || target == "Metadata") return

        val obj = value as? JsonObject ?: return
        rejectExplicitNulls(obj)
        validateTimestamp(obj)

        when (target) {
            "event" -> validateEvent(obj)
            "RunAgentInput", "runAgentInput" -> validateRunInput(obj)
            "Message", "message", "UserMessage", "ToolMessage", "AssistantMessage",
            "SystemMessage", "DeveloperMessage", "ReasoningMessage", "ActivityMessage" -> {
                if (target.endsWith("Message") && target != "Message") {
                    requireLiteral(obj, "role", target.removeSuffix("Message").lowercase())
                }
                validateMessage(obj)
            }
            "FileSource" -> requireLiteral(obj, "type", "file")
            "ToolCall" -> validateToolCall(obj)
            "ContentPart" -> validateContentPart(obj)
            "RunFinishedOutcome", "runFinishedOutcome" -> validateRunOutcome(obj)
            "ResumeEntry", "resumeEntry" -> requireNonNull(obj, "payload")
            "Interrupt", "interrupt" -> validateInterrupt(obj)
            "TokenUsage", "tokenUsage" -> validateTokenUsage(obj)
            "AgentCapabilities" -> {
                rejectCapabilityNulls(obj)
                obj["tools"]?.let { validateToolsCapabilities(it.jsonObject) }
                obj["multiAgent"]?.let { validateMultiAgentCapabilities(it.jsonObject) }
            }
            "MultimodalCapabilities" -> rejectCapabilityNulls(obj)
            "ToolsCapabilities" -> validateToolsCapabilities(obj)
            "MultiAgentCapabilities" -> validateMultiAgentCapabilities(obj)
            "StateDeltaEvent" -> validatePatch(obj.getValue("delta").jsonArray)
            "ActivityDeltaEvent" -> validatePatch(obj.getValue("patch").jsonArray)
            "ReasoningMessageStartEvent" -> requireLiteral(obj, "role", "reasoning")
            "ToolCallResultEvent" -> validateToolResult(obj)
            "TextMessageStartEvent", "TextMessageChunkEvent" -> validateTextRole(obj)
            "SubagentFinishedEvent" -> obj["outcome"]?.let { validateSubagentOutcome(it.jsonObject) }
        }

        if (target.endsWith("Event")) validateEvent(obj)
        if (target == "UserMessage" || target == "ToolMessage") validateMessage(obj)
    }

    private fun validateEvent(obj: JsonObject) {
        val type = obj["type"]?.jsonPrimitive?.contentOrNull ?: error("Event type is required")
        require(!type.startsWith("THINKING")) { "Retired event type: $type" }
        validateTimestamp(obj)
        when (type) {
            "STATE_DELTA" -> validatePatch(obj.getValue("delta").jsonArray)
            "ACTIVITY_DELTA" -> validatePatch(obj.getValue("patch").jsonArray)
            "REASONING_MESSAGE_START" -> requireLiteral(obj, "role", "reasoning")
            "TEXT_MESSAGE_START", "TEXT_MESSAGE_CHUNK" -> validateTextRole(obj)
            "TOOL_CALL_RESULT" -> validateToolResult(obj)
            "RUN_STARTED" -> obj["input"]?.let { validateRunInput(it.jsonObject) }
            "RUN_FINISHED" -> {
                obj["outcome"]?.let { validateRunOutcome(it.jsonObject) }
                validateUsage(obj)
            }
            "RUN_ERROR" -> validateUsage(obj)
            "SUBAGENT_FINISHED" -> obj["outcome"]?.let { validateSubagentOutcome(it.jsonObject) }
            "MESSAGES_SNAPSHOT" -> obj["messages"]?.jsonArray?.forEach { validateMessage(it.jsonObject) }
        }
    }

    private fun validateRunInput(obj: JsonObject) {
        rejectExplicitNulls(obj)
        require("messages" in obj) { "RunAgentInput.messages is required" }
        obj["messages"]?.jsonArray?.forEach { validateMessage(it.jsonObject) }
        obj["tools"]?.jsonArray?.forEach { validateTool(it.jsonObject) }
        obj["resume"]?.jsonArray?.forEach { validateResumeEntry(it.jsonObject) }
    }

    private fun validateMessage(obj: JsonObject) {
        rejectExplicitNulls(obj)
        val role = obj["role"]?.jsonPrimitive?.contentOrNull ?: error("Message role is required")
        obj["toolCalls"]?.jsonArray?.forEach { validateToolCall(it.jsonObject) }
        val content = obj["content"]
        if ((role == "user" || role == "tool") && content is JsonArray) {
            content.forEach(::validateContentPart)
        }
    }

    private fun validateToolCall(obj: JsonObject) {
        rejectExplicitNulls(obj)
        requireLiteral(obj, "type", "function")
        obj["function"]?.let { rejectExplicitNulls(it.jsonObject) }
    }

    private fun validateContentPart(value: JsonElement) {
        val obj = value.jsonObject
        val type = obj["type"]?.jsonPrimitive?.contentOrNull ?: error("Content part type is required")
        require(type in setOf("text", "image", "audio", "video", "document")) {
            "Unknown AG-UI 1.0 content part: $type"
        }
        rejectExplicitNulls(obj)
        obj["source"]?.let { validatePartSource(it.jsonObject) }
    }

    private fun validatePartSource(obj: JsonObject) {
        rejectExplicitNulls(obj)
    }

    private fun validateTool(obj: JsonObject) {
        rejectExplicitNulls(obj)
    }

    private fun validateResumeEntry(obj: JsonObject) {
        rejectExplicitNulls(obj)
    }

    private fun validateToolResult(obj: JsonObject) {
        obj["role"]?.let { require(it.jsonPrimitive.content == "tool") { "Tool result role must be tool" } }
        (obj["content"] as? JsonArray)?.forEach(::validateContentPart)
    }

    private fun validateTextRole(obj: JsonObject) {
        obj["role"]?.let {
            require(it.jsonPrimitive.content in setOf("developer", "system", "assistant", "user")) {
                "Invalid streamed text role"
            }
        }
    }

    private fun validateRunOutcome(obj: JsonObject) {
        rejectExplicitNulls(obj)
        when (obj["type"]?.jsonPrimitive?.contentOrNull ?: error("Outcome type is required")) {
            "success" -> require((obj.keys - setOf("type", "pendingToolCallIds")).isEmpty()) {
                "Success outcome has unsupported fields"
            }
            "interrupt" -> {
                require((obj.keys - setOf("type", "interrupts")).isEmpty()) {
                    "Interrupt outcome has unsupported fields"
                }
                val interrupts = obj["interrupts"]?.jsonArray ?: error("Interrupts are required")
                require(interrupts.isNotEmpty()) { "Interrupt outcome must contain an interrupt" }
                interrupts.forEach { validateInterrupt(it.jsonObject) }
            }
            "cancelled" -> require(obj.keys == setOf("type")) { "Cancelled outcome has unsupported fields" }
            else -> error("Unknown run outcome")
        }
    }

    private fun validateSubagentOutcome(obj: JsonObject) {
        rejectExplicitNulls(obj)
        when (obj["type"]?.jsonPrimitive?.contentOrNull ?: error("Outcome type is required")) {
            "success" -> require(obj.keys == setOf("type")) { "Success outcome has unsupported fields" }
            "suspended" -> require((obj.keys - setOf("type", "interruptIds")).isEmpty()) {
                "Suspended outcome has unsupported fields"
            }
            else -> error("Unknown subagent outcome")
        }
    }

    private fun validateInterrupt(obj: JsonObject) {
        rejectExplicitNulls(obj)
        obj["responseSchema"]?.let { require(it is JsonObject) { "responseSchema must be an object" } }
    }

    private fun validateTokenUsage(obj: JsonObject) {
        rejectExplicitNulls(obj)
        for (key in tokenCountKeys) obj[key]?.let { parseTokenCount(key, it) }
    }

    private val tokenCountKeys = setOf(
        "inputTokens", "outputTokens", "totalTokens", "reasoningTokens",
        "cachedInputTokens", "cacheWriteInputTokens",
    )

    private val tokenCountNumber = Regex("(-?)(0|[1-9][0-9]*)(?:\\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?")

    private fun parseTokenCount(key: String, value: JsonElement): Long {
        val number = value as? JsonPrimitive ?: error("$key must be a JSON number")
        require(!number.isString) { "$key must be a JSON number" }
        val match = tokenCountNumber.matchEntire(number.content) ?: error("$key must be a JSON number")
        val fraction = match.groupValues[3]
        val digits = (match.groupValues[2] + fraction).trimStart('0')
        if (digits.isEmpty()) return 0

        val rangeError = "$key must be a non-negative JSON safe integer"
        require(match.groupValues[1].isEmpty()) { rangeError }
        val exponent = match.groupValues[4].ifEmpty { "0" }.toLongOrNull() ?: error(rangeError)
        val decimalPoint = digits.length.toLong() - fraction.length
        val maxDigits = MAX_SAFE_JSON_INTEGER.toString().length
        require(exponent in (1 - decimalPoint)..(maxDigits - decimalPoint)) { rangeError }
        val integerLength = (decimalPoint + exponent).toInt()

        // Check the decimal spelling exactly; Double can round near-limit fractions to integers.
        require(digits.drop(integerLength).all { it == '0' }) {
            "$key must be an integer"
        }
        val count = digits.take(integerLength).padEnd(integerLength, '0').toLong()
        require(count <= MAX_SAFE_JSON_INTEGER) { rangeError }
        return count
    }

    private fun parseInteger(key: String, value: JsonElement, signed: Boolean = false): Long {
        val primitive = value as? JsonPrimitive ?: error("$key must be a number")
        if (signed && !primitive.isString && primitive.content.startsWith("-")) {
            return -parseTokenCount(key, AgUiJson.parseToJsonElement(primitive.content.drop(1)))
        }
        return parseTokenCount(key, value)
    }

    // Walk the serializer's declared fields only. Opaque JSON (state, metadata,
    // schemas and custom payloads) is left untouched, including nested nulls.
    @OptIn(ExperimentalSerializationApi::class)
    private fun normalizePrimitives(descriptor: SerialDescriptor, value: JsonElement): JsonElement {
        if (descriptor.serialName.startsWith("kotlinx.serialization.json.")) return value
        if (value is JsonNull) return value
        when (descriptor.kind) {
            PrimitiveKind.STRING, SerialKind.ENUM -> require(value is JsonPrimitive && value.isString) {
                "${descriptor.serialName} must be a JSON string"
            }
            PrimitiveKind.BOOLEAN -> require(value is JsonPrimitive && !value.isString && value.content in setOf("true", "false")) {
                "${descriptor.serialName} must be a JSON boolean"
            }
            PrimitiveKind.LONG -> return JsonPrimitive(parseInteger(descriptor.serialName, value, signed = true))
            StructureKind.LIST -> return JsonArray(value.jsonArray.map { normalizePrimitives(descriptor.getElementDescriptor(0), it) })
            PolymorphicKind.SEALED -> {
                val obj = value.jsonObject
                val discriminator = if (descriptor.serialName.endsWith("Message")) "role" else "type"
                val tag = obj.optionalString(discriminator) ?: error("Missing $discriminator")
                val variants = descriptor.getElementDescriptor(1)
                val index = variants.getElementIndex(tag)
                require(index >= 0) { "Unknown $discriminator: $tag" }
                return normalizePrimitives(variants.getElementDescriptor(index), value)
            }
            StructureKind.CLASS, StructureKind.OBJECT -> {
                val obj = value.jsonObject
                return JsonObject(obj.mapValues { (key, item) ->
                    val index = descriptor.getElementIndex(key)
                    if (index >= 0) normalizePrimitives(descriptor.getElementDescriptor(index), item) else item
                })
            }
            else -> Unit
        }
        return value
    }

    private fun normalizeUsage(target: String, value: JsonElement): JsonElement {
        val obj = value as? JsonObject ?: return value
        if (target == "TokenUsage" || target == "tokenUsage") return normalizeTokenUsage(obj)
        if (target != "event" && !target.endsWith("Event")) return value
        if (obj["type"]?.jsonPrimitive?.contentOrNull !in setOf("RUN_FINISHED", "RUN_ERROR")) return value
        val usage = obj["usage"]?.jsonArray ?: return value
        return JsonObject(obj + ("usage" to JsonArray(usage.map { normalizeTokenUsage(it.jsonObject) })))
    }

    // Generated Long decoding consumes the same canonical literals for every accepted numeric spelling.
    private fun normalizeTokenUsage(obj: JsonObject): JsonObject = JsonObject(
        obj.mapValues { (key, value) ->
            if (key in tokenCountKeys) JsonPrimitive(parseTokenCount(key, value)) else value
        },
    )

    private fun validateUsage(obj: JsonObject) {
        obj["usage"]?.jsonArray?.forEach { validateTokenUsage(it.jsonObject) }
    }

    private fun validateTimestamp(obj: JsonObject) {
        obj["timestamp"]?.let { parseInteger("timestamp", it, signed = true) }
    }

    private fun validatePatch(patch: JsonArray) {
        val pointer = Regex("(?:/(?:[^~/]|~[01])*)*")
        patch.forEach { value ->
            val op = value.jsonObject
            val name = op["op"]?.jsonPrimitive?.contentOrNull ?: error("Patch op is required")
            require(name in setOf("add", "remove", "replace", "move", "copy", "test")) { "Unknown patch op" }
            val path = op["path"]?.jsonPrimitive?.contentOrNull ?: error("Patch path is required")
            require(pointer.matches(path)) { "Invalid JSON Pointer" }
            if (name in setOf("add", "replace", "test")) require("value" in op) { "$name requires value" }
            if (name in setOf("move", "copy")) {
                val from = op["from"]?.jsonPrimitive?.contentOrNull ?: error("$name requires from")
                require(pointer.matches(from)) { "Invalid JSON Pointer" }
            }
        }
    }

    private fun rejectExplicitNulls(obj: JsonObject) {
        obj.forEach { (key, value) ->
            if (value is JsonNull && key !in setOf("value", "event", "snapshot")) {
                error("$key cannot be null")
            }
        }
    }

    private fun rejectCapabilityNulls(obj: JsonObject) {
        obj.forEach { (key, value) ->
            require(value !is JsonNull) { "$key cannot be null" }
            if (value is JsonObject && key !in setOf("metadata", "custom")) rejectCapabilityNulls(value)
        }
    }

    private fun validateToolsCapabilities(obj: JsonObject) {
        rejectExplicitNulls(obj)
        obj["items"]?.jsonArray?.forEach { validateTool(it.jsonObject) }
    }

    private fun validateMultiAgentCapabilities(obj: JsonObject) {
        rejectExplicitNulls(obj)
        obj["subagents"]?.jsonArray?.forEach { rejectExplicitNulls(it.jsonObject) }
    }

    private fun requireNonNull(obj: JsonObject, key: String) {
        require(obj[key] !== JsonNull) { "$key cannot be null" }
    }

    private fun requireLiteral(obj: JsonObject, key: String, expected: String) {
        require(obj[key]?.jsonPrimitive?.contentOrNull == expected) { "$key must be $expected" }
    }
}
