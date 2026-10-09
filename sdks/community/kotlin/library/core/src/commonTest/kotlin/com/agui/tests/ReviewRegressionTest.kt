@file:Suppress("DEPRECATION")
package com.agui.tests

import com.agui.core.types.*
import kotlinx.serialization.*
import kotlinx.serialization.json.*
import kotlin.test.*

class ReviewRegressionTest {
    private fun json(value: String) = AgUiJson.parseToJsonElement(value)

    @Test fun positionalRunInputRemainsCompatible() {
        val input = RunAgentInput("thread", "run", "parent", JsonNull, listOf(UserMessage("m", "hi")),
            emptyList(), emptyList(), JsonNull, emptyList())
        assertEquals("parent", input.parentRunId)
        assertEquals("1.0", input.protocolVersion)
        assertEquals(JsonNull, input.state)
        assertEquals("hi", input.messages.single().content)
    }

    @Test fun toolCallFieldsRoundTripIndependentlyAtEveryBoundary() {
        for (extra in listOf("\"metadata\":{\"a\":1}", "\"encryptedValue\":\"secret\"", "\"metadata\":{\"a\":1},\"encryptedValue\":\"secret\"")) {
            val call = """{"id":"c","type":"function","function":{"name":"f","arguments":"{}"},$extra}"""
            val message = """{"id":"m","role":"assistant","toolCalls":[$call]}"""
            val expected = AgUiJson.decodeFromJsonElement(ToolCall.serializer(), json(call))
            assertEquals(expected, AgUiV1.decode(ToolCall.serializer(), "ToolCall", json(call)))
            assertEquals(expected, (AgUiV1.decodeMessage(json(message)) as AssistantMessage).toolCalls!!.single())
            val input = """{"threadId":"t","runId":"r","messages":[$message]}"""
            assertEquals(expected, (AgUiV1.decodeRunAgentInput(json(input)).messages.single() as AssistantMessage).toolCalls!!.single())
            val event = AgUiV1.decodeEvent(json("""{"type":"MESSAGES_SNAPSHOT","messages":[$message]}""")) as MessagesSnapshotEvent
            assertEquals(expected, (event.messages.single() as AssistantMessage).toolCalls!!.single())
            assertEquals(expected, AgUiJson.decodeFromString<ToolCall>(AgUiJson.encodeToString(expected)))
        }
    }

    @Test fun toolCallDiscriminatorIsRequiredInNestedCalls() {
        for (tag in listOf("", "\"type\":\"invalid\",")) {
            val call = """{${tag}"id":"c","function":{"name":"f","arguments":"{}"}}"""
            val message = """{"id":"m","role":"assistant","toolCalls":[$call]}"""
            assertFails { AgUiV1.decode(ToolCall.serializer(), "ToolCall", json(call)) }
            assertFails { AgUiV1.decodeMessage(json(message)) }
            assertFails { AgUiV1.decodeRunAgentInput(json("""{"threadId":"t","runId":"r","messages":[$message]}""")) }
            assertFails { AgUiV1.decodeEvent(json("""{"type":"RUN_STARTED","threadId":"t","runId":"r","input":{"threadId":"t","runId":"r","messages":[$message]}}""")) }
        }
    }

    @Test fun deprecatedSuccessSupportsInferredSerialization() {
        assertEquals(json("""{"type":"success"}"""), json(AgUiJson.encodeToString(RunFinishedSuccessOutcome)))
        val value = RunFinishedSuccessOutcome(listOf("call"))
        assertEquals(value, AgUiJson.decodeFromString(RunFinishedSuccessOutcome.serializer(), AgUiJson.encodeToString(value)))
    }

    @Test fun customDecodersRejectCoercedStringsAndAcceptOptionalNulls() {
        for (id in listOf("12", "true")) {
            assertFails { AgUiV1.decodeMessage(json("""{"role":"user","id":$id,"content":"x"}""")) }
            assertFails { AgUiV1.decodeEvent(json("""{"type":"TOOL_CALL_RESULT","messageId":$id,"toolCallId":"c","content":"x"}""")) }
        }
        val message = AgUiJson.decodeFromJsonElement(Message.serializer(), json("""{"role":"user","id":"m","content":"x","name":null,"metadata":null,"encryptedValue":null,"subagentRunId":null}"""))
        assertNull(message.name); assertNull(message.metadata); assertNull(message.encryptedValue); assertNull(message.subagentRunId)
        val event = AgUiJson.decodeFromJsonElement(BaseEvent.serializer(), json("""{"type":"TOOL_CALL_RESULT","messageId":"m","toolCallId":"c","content":"x","role":null,"timestamp":null,"metadata":null,"subagentRunId":null}"""))
        assertNull(event.timestamp); assertNull(event.metadata); assertNull(event.subagentRunId)
    }

    @Test fun concreteRoutesEnforceDiscriminators() {
        for (type in listOf("url", "wrong")) assertFails {
            AgUiV1.decode(FileSource.serializer(), "FileSource", json("""{"type":"$type","value":"x"}"""))
        }
        assertEquals(FileSource("x"), AgUiV1.decode(FileSource.serializer(), "FileSource", json("""{"type":"file","value":"x"}""")))
        assertFails { AgUiV1.decode(UserMessage.serializer(), "UserMessage", json("""{"id":"m","role":"assistant","content":[{"type":"binary","mimeType":"x","data":"x"}]}""")) }
        assertFails { AgUiV1.decode(ToolMessage.serializer(), "ToolMessage", json("""{"id":"m","role":"user","toolCallId":"c","content":"x"}""")) }
        assertFails { AgUiV1.decodeEvent(json("""{"type":"THINKING_START"}""")) }
        assertIs<ThinkingStartEvent>(AgUiJson.decodeFromJsonElement(BaseEvent.serializer(), json("""{"type":"THINKING_START"}""")))
    }

    @Test fun strictIntegersUseExactJsonNumberSemantics() {
        for ((spelling, expected) in listOf("1.0" to 1L, "1e2" to 100L, "-1e2" to -100L, "9007199254740991" to MAX_SAFE_JSON_INTEGER)) {
            val event = AgUiV1.decodeEvent(json("""{"type":"CUSTOM","name":"x","value":null,"timestamp":$spelling}"""))
            assertEquals(expected, event.timestamp)
        }
        for (value in listOf("\"1\"", "true", "0.1", "9007199254740991.1", "9007199254740992")) {
            assertFails { AgUiV1.decodeEvent(json("""{"type":"CUSTOM","name":"x","value":null,"timestamp":$value}""")) }
            assertFails { AgUiV1.decode(ExecutionCapabilities.serializer(), "ExecutionCapabilities", json("""{"maxIterations":$value}""")) }
            assertFails { AgUiV1.decode(AgentCapabilities.serializer(), "AgentCapabilities", json("""{"execution":{"maxExecutionTime":$value}}""")) }
        }
        assertEquals(100, AgUiV1.decode(ExecutionCapabilities.serializer(), "ExecutionCapabilities", json("""{"maxIterations":1e2}""")).maxIterations)
    }

    @Test fun strictBooleansDoNotAcceptStrings() {
        assertFails { AgUiV1.decode(AgentCapabilities.serializer(), "AgentCapabilities", json("""{"transport":{"streaming":"true"}}""")) }
        assertFails { AgUiV1.decodeEvent(json("""{"type":"ACTIVITY_SNAPSHOT","messageId":"m","activityType":"x","content":{},"replace":"false"}""")) }
        assertEquals(true, AgUiV1.decode(TransportCapabilities.serializer(), "TransportCapabilities", json("""{"streaming":true}""")).streaming)
    }

    @Test fun unversionedStartReplaysWithoutInventingVersion() {
        val wire = json("""{"type":"RUN_STARTED","threadId":"t","runId":"r"}""")
        for (event in listOf(AgUiV1.decodeEvent(wire), AgUiJson.decodeFromJsonElement(BaseEvent.serializer(), wire))) {
            assertNull((event as RunStartedEvent).protocolVersion)
            assertFalse("protocolVersion" in AgUiJson.encodeToJsonElement(BaseEvent.serializer(), event).jsonObject)
        }
        assertEquals("1.0", RunStartedEvent("t", "r").protocolVersion)
    }

    @Test fun malformedMultimodalResultRoleIsNotRepaired() {
        assertFails { AgUiJson.decodeFromJsonElement(BaseEvent.serializer(), json("""{"type":"TOOL_CALL_RESULT","messageId":"m","toolCallId":"c","content":[],"role":"user"}""")) }
    }

    @Test fun outcomeCustomSerializerHonorsUnknownKeyPolicy() {
        val strict = Json { ignoreUnknownKeys = false }
        for (type in listOf("success", "cancelled")) {
            val wire = """{"type":"$type","extra":1}"""
            assertFails { strict.decodeFromString(RunFinishedOutcome.serializer(), wire) }
            AgUiJson.decodeFromString(RunFinishedOutcome.serializer(), wire)
        }
    }
}
