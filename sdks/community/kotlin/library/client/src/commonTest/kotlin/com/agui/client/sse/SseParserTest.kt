package com.agui.client.sse

import com.agui.core.types.BaseEvent
import com.agui.core.types.Role
import com.agui.core.types.TextMessageStartEvent
import com.agui.core.types.AgUiJson
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest

class SseParserTest {

    @Test
    fun parseFlow_filtersMalformedEvents() = runTest {
        val parser = SseParser()
        val validEvent = TextMessageStartEvent(messageId = "stream-1", role = Role.ASSISTANT)
        val serialized = AgUiJson.encodeToString(BaseEvent.serializer(), validEvent)
        val payloads = flowOf(
            "not-json",
            serialized,
            "{ \"event\": \"missing \"",
            "  $serialized   "
        )

        val parsed = parser.parseFlow(payloads).toList()

        assertEquals(2, parsed.size)
        parsed.forEach { event ->
            val start = assertIs<TextMessageStartEvent>(event)
            assertEquals("stream-1", start.messageId)
        }
    }
}
