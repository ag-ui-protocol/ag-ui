package com.agui.core.types

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
            value
        }
        return AgUiStrictJson.decodeFromJsonElement(serializer, input)
    }

    /** Validate rules that Kotlin nullable/default properties cannot express. */
    fun validate(target: String, value: JsonElement) {
        val obj = value as? JsonObject ?: return
        rejectExplicitNulls(obj)
        validateTimestamp(obj)

        when (target) {
            "event" -> validateEvent(obj)
            "RunAgentInput", "runAgentInput" -> validateRunInput(obj)
            "message", "UserMessage", "ToolMessage" -> validateMessage(obj)
            "runFinishedOutcome" -> validateRunOutcome(obj)
            "ResumeEntry", "resumeEntry" -> requireNonNull(obj, "payload")
            "Interrupt", "interrupt" -> validateInterrupt(obj)
            "TokenUsage", "tokenUsage" -> validateTokenUsage(obj)
            "AgentCapabilities" -> rejectCapabilityNulls(obj)
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
        validateTimestamp(obj)
        when (type) {
            "STATE_DELTA" -> validatePatch(obj.getValue("delta").jsonArray)
            "ACTIVITY_DELTA" -> validatePatch(obj.getValue("patch").jsonArray)
            "REASONING_MESSAGE_START" -> requireLiteral(obj, "role", "reasoning")
            "TEXT_MESSAGE_START", "TEXT_MESSAGE_CHUNK" -> validateTextRole(obj)
            "TOOL_CALL_RESULT" -> validateToolResult(obj)
            "RUN_FINISHED" -> obj["outcome"]?.let { validateRunOutcome(it.jsonObject) }
            "SUBAGENT_FINISHED" -> obj["outcome"]?.let { validateSubagentOutcome(it.jsonObject) }
            "MESSAGES_SNAPSHOT" -> obj["messages"]?.jsonArray?.forEach { validateMessage(it.jsonObject) }
        }
    }

    private fun validateRunInput(obj: JsonObject) {
        require("messages" in obj) { "RunAgentInput.messages is required" }
        obj["messages"]?.jsonArray?.forEach { validateMessage(it.jsonObject) }
    }

    private fun validateMessage(obj: JsonObject) {
        rejectExplicitNulls(obj)
        val role = obj["role"]?.jsonPrimitive?.contentOrNull ?: error("Message role is required")
        val content = obj["content"]
        if ((role == "user" || role == "tool") && content is JsonArray) {
            content.forEach(::validateContentPart)
        }
    }

    private fun validateContentPart(value: JsonElement) {
        val obj = value.jsonObject
        val type = obj["type"]?.jsonPrimitive?.contentOrNull ?: error("Content part type is required")
        require(type in setOf("text", "image", "audio", "video", "document")) {
            "Unknown AG-UI 1.0 content part: $type"
        }
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
        when (obj["type"]?.jsonPrimitive?.contentOrNull ?: error("Outcome type is required")) {
            "success" -> require(obj.keys == setOf("type")) { "Success outcome has unsupported fields" }
            "suspended" -> require((obj.keys - setOf("type", "interruptIds")).isEmpty()) {
                "Suspended outcome has unsupported fields"
            }
            else -> error("Unknown subagent outcome")
        }
    }

    private fun validateInterrupt(obj: JsonObject) {
        obj["responseSchema"]?.let { require(it is JsonObject) { "responseSchema must be an object" } }
    }

    private fun validateTokenUsage(obj: JsonObject) {
        val countKeys = setOf(
            "inputTokens", "outputTokens", "totalTokens", "reasoningTokens",
            "cachedInputTokens", "cacheWriteInputTokens",
        )
        for (key in countKeys) obj[key]?.let {
            val value = it.jsonPrimitive.content.toLongOrNull() ?: error("$key must be an integer")
            require(value in 0..MAX_SAFE_JSON_INTEGER) { "$key must be a non-negative JSON safe integer" }
        }
    }

    private fun validateTimestamp(obj: JsonObject) {
        obj["timestamp"]?.let {
            val value = it.jsonPrimitive.content.toLongOrNull() ?: error("timestamp must be an integer")
            require(value in -MAX_SAFE_JSON_INTEGER..MAX_SAFE_JSON_INTEGER) {
                "timestamp must be a JSON safe integer"
            }
        }
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

    private fun requireNonNull(obj: JsonObject, key: String) {
        require(obj[key] !== JsonNull) { "$key cannot be null" }
    }

    private fun requireLiteral(obj: JsonObject, key: String, expected: String) {
        require(obj[key]?.jsonPrimitive?.contentOrNull == expected) { "$key must be $expected" }
    }
}
