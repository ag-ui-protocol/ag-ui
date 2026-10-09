package com.agui.encoder

import com.agui.core.types.AgUiJson
import com.agui.core.types.BaseEvent
import com.agui.core.types.CustomEvent
import com.agui.core.types.RunStartedEvent
import com.agui.core.types.TextMessageContentEvent
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class EventEncoderTest {

    private val event = RunStartedEvent(threadId = "t1", runId = "r1")
    // Compact JSON with the "type" discriminator first, then declaration order;
    // null timestamp/rawEvent omitted (AgUiJson has explicitNulls = false).
    private val expectedJson = """{"type":"RUN_STARTED","threadId":"t1","runId":"r1"}"""

    @Test
    fun getContentTypeIsEventStreamByDefault() {
        assertEquals("text/event-stream", EventEncoder().getContentType())
        assertEquals("text/event-stream", EventEncoder.SSE_CONTENT_TYPE)
    }

    @Test
    fun getContentTypeStaysSseEvenWhenProtobufRequested() {
        // No Kotlin proto codec yet — proto Accept still yields SSE (matches Python).
        val encoder = EventEncoder(accept = EventEncoder.AGUI_MEDIA_TYPE)
        assertEquals("text/event-stream", encoder.getContentType())
    }

    @Test
    fun encodeProducesCanonicalSseFraming() {
        // Exact bytes: "data: " prefix (one space), compact JSON, trailing blank line.
        assertEquals("data: $expectedJson\n\n", EventEncoder().encode(event))
    }

    @Test
    fun encodeSseMatchesEncode() {
        val encoder = EventEncoder()
        assertEquals(encoder.encode(event), encoder.encodeSSE(event))
    }

    @Test
    fun encodeStartsWithDataPrefixAndEndsWithBlankLine() {
        val encoded = EventEncoder().encode(event)
        assertTrue(encoded.startsWith("data: "), "must start with 'data: '")
        assertTrue(encoded.endsWith("\n\n"), "must end with a blank line")
    }

    @Test
    fun encodeToJsonProducesUnframedBody() {
        // No "data: " prefix and no trailing blank line — just the compact JSON body.
        assertEquals(expectedJson, EventEncoder().encodeToJson(event))
    }

    @Test
    fun encodeSseWrapsEncodeToJson() {
        // encodeSSE is exactly the framed form of encodeToJson (for self-framing transports the
        // body-only path must yield the same JSON the SSE path carries).
        val encoder = EventEncoder()
        assertEquals("data: ${encoder.encodeToJson(event)}\n\n", encoder.encodeSSE(event))
    }

    @Test
    fun encodeEscapesNewlinesQuotesAndUnicodeInTextContent() {
        val event = TextMessageContentEvent(
            messageId = "m1",
            delta = "line one\nline \"two\"\r\nkia ora — Māori 🐦",
        )
        val encoded = EventEncoder().encode(event)

        // Payload line breaks are escaped, so the frame is a single data line plus the
        // terminating blank line — a raw newline would split the SSE event.
        assertEquals(
            "data: {\"type\":\"TEXT_MESSAGE_CONTENT\",\"messageId\":\"m1\"," +
                "\"delta\":\"line one\\nline \\\"two\\\"\\r\\nkia ora — Māori 🐦\"}\n\n",
            encoded,
        )
        assertEquals(2, encoded.count { it == '\r' || it == '\n' }, "only the frame's own two line breaks")
        assertTrue(encoded.endsWith("}\n\n") && !encoded.endsWith("\n\n\n"), "exactly one terminating blank line")

        // Round-trips back to the same event, discriminator included.
        val decoded = AgUiJson.decodeFromString<BaseEvent>(EventEncoder().encodeToJson(event))
        assertEquals(event, decoded)
    }

    @Test
    fun encodePreservesNestedJsonInCustomEvent() {
        val value = buildJsonObject {
            put("label", "multi\nline")
            putJsonObject("nested") {
                put("count", 2)
                putJsonArray("items") {
                    add("a")
                    add(JsonPrimitive(true))
                    add(JsonNull)
                }
            }
        }
        val event = CustomEvent(name = "progress", value = value)
        val encoded = EventEncoder().encode(event)

        assertEquals(
            "data: {\"type\":\"CUSTOM\",\"name\":\"progress\",\"value\":" +
                "{\"label\":\"multi\\nline\",\"nested\":{\"count\":2,\"items\":[\"a\",true,null]}}}\n\n",
            encoded,
        )
        assertTrue(encoded.endsWith("}\n\n") && !encoded.endsWith("\n\n\n"), "exactly one terminating blank line")

        val decoded = AgUiJson.decodeFromString<BaseEvent>(EventEncoder().encodeToJson(event))
        assertEquals(event, decoded)
    }
}
