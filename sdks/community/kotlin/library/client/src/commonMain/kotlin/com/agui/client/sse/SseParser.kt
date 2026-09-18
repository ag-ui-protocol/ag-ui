package com.agui.client.sse

import com.agui.core.types.BaseEvent
import com.agui.core.types.AgUiJson
import com.agui.core.types.AgUiV1
import kotlinx.coroutines.flow.*
import kotlinx.serialization.json.Json
import co.touchlab.kermit.Logger

private val logger = Logger.withTag("SseParser")

/**
 * Parses a stream of SSE data into AG-UI events.
 * Each chunk received is already a complete JSON event from the SSE client.
 * Handles JSON deserialization and error recovery for malformed events.
 * 
 * @property json The JSON serializer instance used for parsing events
 */
class SseParser(
    private val json: Json = AgUiJson,
    private val strictV1: Boolean = false,
) {
    /**
     * Transform raw JSON strings into parsed events.
     * Filters out malformed JSON events and logs parsing errors for debugging.
     * 
     * @param source Flow of raw JSON strings from the SSE stream
     * @return Flow<BaseEvent> stream of successfully parsed AG-UI events
     */
    fun parseFlow(source: Flow<String>): Flow<BaseEvent> = source.mapNotNull { jsonStr ->
        try {
            val input = json.parseToJsonElement(jsonStr.trim())
            val event = if (strictV1) {
                AgUiV1.decodeEvent(input)
            } else {
                json.decodeFromJsonElement(BaseEvent.serializer(), input)
            }
            logger.d { "Successfully parsed event: ${event.eventType}" }
            event
        } catch (e: Exception) {
            logger.e(e) { "Failed to parse JSON event: $jsonStr" }
            if (strictV1) throw e else null
        }
    }
}
