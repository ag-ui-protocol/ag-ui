package com.agui.tests

import com.agui.core.types.*
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.*
import kotlin.test.*

/**
 * Coverage for the AG-UI interrupt protocol additions:
 * - [Interrupt], [ResumeStatus], [ResumeEntry]
 * - [RunAgentInput.resume]
 * - [RunFinishedEvent.outcome] / [RunFinishedEvent.result]
 * - [RunFinishedOutcome] discriminated union ([RunFinishedSuccessOutcome] / [RunFinishedInterruptOutcome])
 *
 * Mirrors TS (`sdks/typescript/packages/core/src/__tests__/interrupts.test.ts`)
 * and Python interrupt tests.
 *
 * @see <a href="https://docs.ag-ui.com/concepts/interrupts">AG-UI Interrupts</a>
 */
class InterruptSerializationTest {

    private val json = AgUiJson

    // ========== Interrupt ==========

    @Test
    fun testInterruptMinimalRoundTrip() {
        val interrupt = Interrupt(id = "int-1", reason = "tool_call")

        val jsonString = json.encodeToString(Interrupt.serializer(), interrupt)
        val jsonObj = json.parseToJsonElement(jsonString).jsonObject

        assertEquals("int-1", jsonObj["id"]?.jsonPrimitive?.content)
        assertEquals("tool_call", jsonObj["reason"]?.jsonPrimitive?.content)
        // explicitNulls = false → optional null fields must be omitted
        assertFalse(jsonObj.containsKey("message"))
        assertFalse(jsonObj.containsKey("toolCallId"))
        assertFalse(jsonObj.containsKey("responseSchema"))
        assertFalse(jsonObj.containsKey("expiresAt"))
        assertFalse(jsonObj.containsKey("metadata"))

        val decoded = json.decodeFromString(Interrupt.serializer(), jsonString)
        assertEquals(interrupt, decoded)
    }

    @Test
    fun testInterruptFullRoundTrip() {
        val schema = buildJsonObject {
            put("type", "object")
            put("properties", buildJsonObject {
                put("approved", buildJsonObject { put("type", "boolean") })
            })
        }
        val metadata = buildJsonObject {
            put("priority", "high")
            put("retries", 0)
        }
        val interrupt = Interrupt(
            id = "int-1",
            reason = "human_approval",
            message = "Please confirm before sending the email.",
            toolCallId = "call-42",
            responseSchema = schema,
            expiresAt = "2026-05-27T12:00:00Z",
            metadata = metadata
        )

        val jsonString = json.encodeToString(Interrupt.serializer(), interrupt)
        val decoded = json.decodeFromString(Interrupt.serializer(), jsonString)
        assertEquals(interrupt, decoded)
    }

    // ========== ResumeEntry / ResumeStatus ==========

    @Test
    fun testResumeEntryResolvedRoundTrip() {
        val entry = ResumeEntry(
            interruptId = "int-1",
            status = ResumeStatus.RESOLVED,
            payload = JsonPrimitive("ok")
        )

        val jsonString = json.encodeToString(ResumeEntry.serializer(), entry)
        val jsonObj = json.parseToJsonElement(jsonString).jsonObject

        assertEquals("int-1", jsonObj["interruptId"]?.jsonPrimitive?.content)
        assertEquals("resolved", jsonObj["status"]?.jsonPrimitive?.content)
        assertEquals("ok", jsonObj["payload"]?.jsonPrimitive?.content)

        val decoded = json.decodeFromString(ResumeEntry.serializer(), jsonString)
        assertEquals(entry, decoded)
    }

    @Test
    fun testResumeEntryCancelledRoundTrip() {
        val entry = ResumeEntry(
            interruptId = "int-1",
            status = ResumeStatus.CANCELLED
        )

        val jsonString = json.encodeToString(ResumeEntry.serializer(), entry)
        val jsonObj = json.parseToJsonElement(jsonString).jsonObject

        assertEquals("cancelled", jsonObj["status"]?.jsonPrimitive?.content)
        assertFalse(jsonObj.containsKey("payload"))

        val decoded = json.decodeFromString(ResumeEntry.serializer(), jsonString)
        assertEquals(entry, decoded)
    }

    @Test
    fun testResumeEntryRejectsUnknownStatus() {
        val malformed = """{"interruptId":"int-1","status":"denied"}"""
        assertFailsWith<SerializationException> {
            json.decodeFromString(ResumeEntry.serializer(), malformed)
        }
    }

    @Test
    fun testResumeEntryAcceptsObjectPayload() {
        val payload = buildJsonObject {
            put("approved", true)
            put("note", "looks good")
        }
        val entry = ResumeEntry(
            interruptId = "int-1",
            status = ResumeStatus.RESOLVED,
            payload = payload
        )

        val jsonString = json.encodeToString(ResumeEntry.serializer(), entry)
        val decoded = json.decodeFromString(ResumeEntry.serializer(), jsonString)
        assertEquals(payload, decoded.payload)
    }

    // ========== RunAgentInput.resume ==========

    @Test
    fun testRunAgentInputResumeOmittedWhenNull() {
        val input = RunAgentInput(threadId = "t", runId = "r")

        val jsonString = json.encodeToString(input)
        val jsonObj = json.parseToJsonElement(jsonString).jsonObject

        // explicitNulls = false → resume must not appear when null
        assertFalse(jsonObj.containsKey("resume"))

        val decoded = json.decodeFromString<RunAgentInput>(jsonString)
        assertNull(decoded.resume)
    }

    @Test
    fun testRunAgentInputResumeRoundTrip() {
        val input = RunAgentInput(
            threadId = "t",
            runId = "r",
            resume = listOf(
                ResumeEntry("int-1", ResumeStatus.RESOLVED, JsonPrimitive("yes")),
                ResumeEntry("int-2", ResumeStatus.CANCELLED)
            )
        )

        val jsonString = json.encodeToString(input)
        val jsonObj = json.parseToJsonElement(jsonString).jsonObject
        val resumeArr = jsonObj["resume"]?.jsonArray
        assertNotNull(resumeArr)
        assertEquals(2, resumeArr.size)
        assertEquals("int-1", resumeArr[0].jsonObject["interruptId"]?.jsonPrimitive?.content)
        assertEquals("resolved", resumeArr[0].jsonObject["status"]?.jsonPrimitive?.content)
        assertEquals("cancelled", resumeArr[1].jsonObject["status"]?.jsonPrimitive?.content)

        val decoded = json.decodeFromString<RunAgentInput>(jsonString)
        assertEquals(input, decoded)
    }

    // ========== RunFinishedOutcome ==========

    @Test
    fun testRunFinishedInterruptOutcomeRejectsEmptyList() {
        assertFailsWith<IllegalArgumentException> {
            RunFinishedInterruptOutcome(interrupts = emptyList())
        }
    }

    // ========== RunFinishedEvent.outcome ==========

    @Test
    fun testRunFinishedEventLegacyShapeRoundTrip() {
        // Legacy producer: no result, no outcome.
        val event = RunFinishedEvent(threadId = "t", runId = "r")

        val jsonString = json.encodeToString<BaseEvent>(event)
        val jsonObj = json.parseToJsonElement(jsonString).jsonObject

        assertEquals("RUN_FINISHED", jsonObj["type"]?.jsonPrimitive?.content)
        assertFalse(jsonObj.containsKey("outcome"))
        assertFalse(jsonObj.containsKey("result"))

        val decoded = json.decodeFromString<BaseEvent>(jsonString)
        assertTrue(decoded is RunFinishedEvent)
        assertNull(decoded.outcome)
        assertNull(decoded.result)
    }

    @Test
    fun testRunFinishedEventSuccessOutcomeSerialization() {
        val event = RunFinishedEvent(
            threadId = "t",
            runId = "r",
            outcome = RunFinishedSuccessOutcome
        )

        val jsonString = json.encodeToString<BaseEvent>(event)
        val outcomeObj = json.parseToJsonElement(jsonString).jsonObject["outcome"]?.jsonObject
        assertNotNull(outcomeObj)
        // Schema is exactly `{ type: "success" }` — discriminator only, no extra keys.
        assertEquals(setOf("type"), outcomeObj.keys)
        assertEquals("success", outcomeObj["type"]?.jsonPrimitive?.content)

        val decoded = json.decodeFromString<BaseEvent>(jsonString)
        assertTrue(decoded is RunFinishedEvent)
        assertEquals(RunFinishedSuccessOutcome, decoded.outcome)
    }

    @Test
    fun testRunFinishedEventInterruptOutcomeSerialization() {
        val interrupts = listOf(
            Interrupt(id = "int-1", reason = "tool_call"),
            Interrupt(id = "int-2", reason = "human_approval", message = "ok?")
        )
        val event = RunFinishedEvent(
            threadId = "t",
            runId = "r",
            outcome = RunFinishedInterruptOutcome(interrupts)
        )

        val jsonString = json.encodeToString<BaseEvent>(event)
        val outcomeObj = json.parseToJsonElement(jsonString).jsonObject["outcome"]?.jsonObject
        assertNotNull(outcomeObj)
        assertEquals("interrupt", outcomeObj["type"]?.jsonPrimitive?.content)
        val emittedInterrupts = outcomeObj["interrupts"]?.jsonArray
        assertNotNull(emittedInterrupts)
        assertEquals(2, emittedInterrupts.size)
        assertEquals("int-1", emittedInterrupts[0].jsonObject["id"]?.jsonPrimitive?.content)

        val decoded = json.decodeFromString<BaseEvent>(jsonString)
        assertTrue(decoded is RunFinishedEvent)
        val outcome = decoded.outcome
        assertTrue(outcome is RunFinishedInterruptOutcome)
        assertEquals(interrupts, outcome.interrupts)
    }

    @Test
    fun testRunFinishedEventWithResultRoundTrip() {
        val result = buildJsonObject {
            put("answer", 42)
            put("note", "ok")
        }
        val event = RunFinishedEvent(
            threadId = "t",
            runId = "r",
            result = result,
            outcome = RunFinishedSuccessOutcome
        )

        val jsonString = json.encodeToString<BaseEvent>(event)
        val decoded = json.decodeFromString<BaseEvent>(jsonString)
        assertTrue(decoded is RunFinishedEvent)
        assertEquals(result, decoded.result)
        assertEquals(RunFinishedSuccessOutcome, decoded.outcome)
    }

    @Test
    fun testRunFinishedEventAcceptsExplicitNullOutcome() {
        // Python `exclude_none=False` callers serialize the optional outcome as
        // JSON `null`. The Kotlin SDK must accept that and normalize to null.
        val rawJson = """{
            "type":"RUN_FINISHED",
            "threadId":"t",
            "runId":"r",
            "outcome":null,
            "result":null
        }""".trimIndent()

        val decoded = json.decodeFromString<BaseEvent>(rawJson)
        assertTrue(decoded is RunFinishedEvent)
        assertNull(decoded.outcome)
        assertNull(decoded.result)
    }

    @Test
    fun testRunFinishedEventDecodesServerProducedInterruptShape() {
        // Sanity check that the JSON shape a TS/Python server emits decodes
        // cleanly through the polymorphic BaseEvent dispatch.
        val rawJson = """{
            "type":"RUN_FINISHED",
            "threadId":"t",
            "runId":"r",
            "outcome":{
                "type":"interrupt",
                "interrupts":[
                    {"id":"i1","reason":"tool_call"}
                ]
            }
        }""".trimIndent()

        val decoded = json.decodeFromString<BaseEvent>(rawJson)
        assertTrue(decoded is RunFinishedEvent)
        val outcome = decoded.outcome
        assertTrue(outcome is RunFinishedInterruptOutcome)
        assertEquals(1, outcome.interrupts.size)
        assertEquals("i1", outcome.interrupts[0].id)
        assertEquals("tool_call", outcome.interrupts[0].reason)
    }
}
