package com.agui.tests

import com.agui.core.types.AgUiJson
import com.agui.core.types.AgUiV1
import com.agui.core.types.DocumentPart
import com.agui.core.types.RunFinishedEvent
import com.agui.core.types.RunFinishedSuccessOutcome
import com.agui.core.types.ToolCallResultEvent
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFails
import kotlin.test.assertIs
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

class AgUiV1Test {
    @Test
    fun strictDecoderSupportsV1MultimodalAndOutcomeFields() {
        val toolResult = AgUiV1.decodeEvent(
            AgUiJson.parseToJsonElement(
                """{"type":"TOOL_CALL_RESULT","messageId":"m","toolCallId":"c","content":[{"type":"document","source":{"type":"file","value":"file-1","provider":"openai"}}]}""",
            ),
        )
        val result = assertIs<ToolCallResultEvent>(toolResult)
        assertIs<DocumentPart>(result.contentParts?.single())

        val finished = AgUiV1.decodeEvent(
            AgUiJson.parseToJsonElement(
                """{"type":"RUN_FINISHED","threadId":"t","runId":"r","outcome":{"type":"success","pendingToolCallIds":["c"]}}""",
            ),
        )
        assertEquals(listOf("c"), assertIs<RunFinishedSuccessOutcome>(assertIs<RunFinishedEvent>(finished).outcome).pendingToolCallIds)
    }

    @Test
    fun strictDecoderRejectsMalformedPatchAndClosedOutcome() {
        assertFails {
            AgUiV1.decodeEvent(
                buildJsonObject {
                    put("type", "STATE_DELTA")
                    put("delta", buildJsonArray { add(buildJsonObject { put("op", "add") }) })
                },
            )
        }
        assertFails {
            AgUiV1.decodeEvent(
                AgUiJson.parseToJsonElement(
                    """{"type":"RUN_FINISHED","threadId":"t","runId":"r","outcome":{"type":"cancelled","interrupts":[]}}""",
                ),
            )
        }
    }
}
