package com.agui.tests

import com.agui.core.types.AgUiJson
import com.agui.core.types.AgUiV1
import com.agui.core.types.AgentCapabilities
import com.agui.core.types.AudioPart
import com.agui.core.types.BinaryInputContent
import com.agui.core.types.ContentPart
import com.agui.core.types.CustomEvent
import com.agui.core.types.DataSource
import com.agui.core.types.DocumentPart
import com.agui.core.types.FileSource
import com.agui.core.types.ImagePart
import com.agui.core.types.Interrupt
import com.agui.core.types.Message
import com.agui.core.types.MultiAgentCapabilities
import com.agui.core.types.MultimodalCapabilities
import com.agui.core.types.MultimodalInputCapabilities
import com.agui.core.types.MultimodalOutputCapabilities
import com.agui.core.types.PartSource
import com.agui.core.types.ResumeStatus
import com.agui.core.types.RunErrorEvent
import com.agui.core.types.RunFinishedEvent
import com.agui.core.types.RunFinishedInterruptOutcome
import com.agui.core.types.RunFinishedOutcome
import com.agui.core.types.RunFinishedSuccessOutcome
import com.agui.core.types.RunStartedEvent
import com.agui.core.types.StateSnapshotEvent
import com.agui.core.types.SubagentFinishedEvent
import com.agui.core.types.SubagentFinishedOutcome
import com.agui.core.types.SubagentFinishedSuspendedOutcome
import com.agui.core.types.SubagentInfo
import com.agui.core.types.TextPart
import com.agui.core.types.TokenUsage
import com.agui.core.types.Tool
import com.agui.core.types.ToolCallResultEvent
import com.agui.core.types.ToolMessage
import com.agui.core.types.ToolsCapabilities
import com.agui.core.types.UrlSource
import com.agui.core.types.UserMessage
import com.agui.core.types.VideoPart
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFails
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlinx.serialization.KSerializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

class AgUiV1Test {
    @Test
    fun strictDecoderRejectsLegacyBinaryContentAtEachBoundary() {
        assertContentPartRejectedAtEachBoundary(
            """{"type":"binary","mimeType":"image/png","data":"AQID"}""",
        )
    }

    @Test
    fun compatibilityDecoderPreservesLegacyBinaryContentPart() {
        val part = AgUiJson.parseToJsonElement("""{"type":"binary","mimeType":"image/png","data":"AQID"}""")
        val expected = BinaryInputContent(mimeType = "image/png", data = "AQID")
        val user = jsonFixture("""{"id":"m","role":"user","content":[$part]}""")
        val tool = jsonFixture("""{"id":"m","role":"tool","toolCallId":"c","content":[$part]}""")

        assertEquals(expected, AgUiJson.decodeFromJsonElement(ContentPart.serializer(), part))
        assertEquals(listOf(expected), assertIs<UserMessage>(AgUiJson.decodeFromJsonElement(Message.serializer(), user)).contentParts)
        assertEquals(listOf(expected), assertIs<ToolMessage>(AgUiJson.decodeFromJsonElement(Message.serializer(), tool)).contentParts)
    }

    @Test
    fun strictDecoderAcceptsCanonicalContentPartsAtEachBoundary() {
        val cases = listOf(
            """{"type":"text","text":"Hello"}""" to TextPart("Hello"),
            """{"type":"image","source":{"type":"url","value":"https://example.com/image.png"}}""" to
                ImagePart(UrlSource("https://example.com/image.png")),
            """{"type":"audio","source":{"type":"data","value":"AQID","mimeType":"audio/wav"}}""" to
                AudioPart(DataSource("AQID", "audio/wav")),
            """{"type":"video","source":{"type":"url","value":"https://example.com/video.mp4","mimeType":"video/mp4"}}""" to
                VideoPart(UrlSource("https://example.com/video.mp4", mimeType = "video/mp4")),
            """{"type":"document","source":{"type":"file","value":"file-1","provider":"openai","mimeType":"application/pdf"}}""" to
                DocumentPart(FileSource("file-1", provider = "openai", mimeType = "application/pdf")),
            """{"type":"document","source":{"type":"file","value":"file-1"}}""" to
                DocumentPart(FileSource("file-1")),
        )

        for ((part, expected) in cases) assertContentPartDecodedAtEachBoundary(part, expected)
    }

    @Test
    fun strictDecoderRejectsContentPartNullIdAtEachBoundary() {
        assertContentPartRejectedAtEachBoundary("""{"type":"text","text":"Hello","id":null}""")
    }

    @Test
    fun strictDecoderRejectsContentPartNullMetadataAtEachBoundary() {
        assertContentPartRejectedAtEachBoundary("""{"type":"text","text":"Hello","metadata":null}""")
    }

    @Test
    fun strictDecoderRejectsContentPartNullSourceAtEachBoundary() {
        assertContentPartRejectedAtEachBoundary("""{"type":"image","source":null}""")
    }

    @Test
    fun strictDecoderRejectsContentPartSourceNullValueAtEachBoundary() {
        val sources = listOf(
            """{"type":"url","value":null}""",
            """{"type":"data","value":null,"mimeType":"image/png"}""",
            """{"type":"file","value":null}""",
        )
        for (source in sources) {
            assertContentPartRejectedAtEachBoundary("""{"type":"image","source":$source}""")
        }
    }

    @Test
    fun strictDecoderRejectsContentPartUrlSourceNullMimeTypeAtEachBoundary() {
        assertContentPartRejectedAtEachBoundary(
            """{"type":"image","source":{"type":"url","value":"https://example.com/image.png","mimeType":null}}""",
        )
    }

    @Test
    fun strictDecoderRejectsContentPartFileSourceNullMimeTypeAtEachBoundary() {
        assertContentPartRejectedAtEachBoundary(
            """{"type":"document","source":{"type":"file","value":"file-1","mimeType":null}}""",
        )
    }

    @Test
    fun strictDecoderRejectsContentPartFileSourceNullProviderAtEachBoundary() {
        assertContentPartRejectedAtEachBoundary(
            """{"type":"document","source":{"type":"file","value":"file-1","provider":null}}""",
        )
    }

    @Test
    fun strictDecoderPreservesContentPartOpaqueMetadataNullsAtEachBoundary() {
        val metadataValues = listOf(
            """{"caption":null,"source":{"mimeType":null}}""",
            """[null,{"source":null}]""",
        )
        for (metadata in metadataValues) {
            assertContentPartDecodedAtEachBoundary(
                """{"type":"text","text":"Hello","metadata":$metadata}""",
                TextPart("Hello", metadata = AgUiJson.parseToJsonElement(metadata)),
            )
            assertContentPartDecodedAtEachBoundary(
                """{"type":"image","source":{"type":"url","value":"https://example.com/image.png"},"metadata":$metadata}""",
                ImagePart(
                    UrlSource("https://example.com/image.png"),
                    metadata = AgUiJson.parseToJsonElement(metadata),
                ),
            )
        }
    }

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

    @Test
    fun strictDecoderRejectsSuccessOutcomeNullPendingToolCallIds() {
        val outcome = AgUiJson.parseToJsonElement("""{"type":"success","pendingToolCallIds":null}""")
        val event = AgUiJson.parseToJsonElement(
            """{"type":"RUN_FINISHED","threadId":"t","runId":"r","outcome":$outcome}""",
        )

        for (target in runFinishedOutcomeTargets) {
            assertFails("$target success outcome") {
                AgUiV1.decode(RunFinishedOutcome.serializer(), target, outcome)
            }
        }
        assertFails("success outcome in event") { AgUiV1.decodeEvent(event) }
        assertFails("success outcome in concrete event") {
            AgUiV1.validate("RunFinishedEvent", event)
        }
    }

    @Test
    fun strictDecoderRejectsUnsupportedSuccessFieldsForBothOutcomeNames() {
        val outcome = jsonFixture("""{"type":"success","interrupts":[]}""")
        for (target in runFinishedOutcomeTargets) {
            assertFails(target) { AgUiV1.decode(RunFinishedOutcome.serializer(), target, outcome) }
        }
    }

    @Test
    fun strictDecoderRejectsSuspendedOutcomeNullInterruptIds() {
        val outcome = AgUiJson.parseToJsonElement("""{"type":"suspended","interruptIds":null}""")
        val event = AgUiJson.parseToJsonElement(
            """{"type":"SUBAGENT_FINISHED","subagentRunId":"s","outcome":$outcome}""",
        )

        assertFails("root suspended outcome") {
            AgUiV1.decode(SubagentFinishedOutcome.serializer(), "SubagentFinishedOutcome", outcome)
        }
        assertFails("suspended outcome in event") { AgUiV1.decodeEvent(event) }
        assertFails("suspended outcome in concrete event") {
            AgUiV1.validate("SubagentFinishedEvent", event)
        }
    }

    @Test
    fun strictDecoderRejectsInterruptNullMessage() {
        assertInterruptNullRejected("message")
    }

    @Test
    fun strictDecoderRejectsInterruptNullToolCallId() {
        assertInterruptNullRejected("toolCallId")
    }

    @Test
    fun strictDecoderRejectsInterruptNullExpiresAt() {
        assertInterruptNullRejected("expiresAt")
    }

    @Test
    fun strictDecoderRejectsInterruptNullMetadata() {
        assertInterruptNullRejected("metadata")
    }

    @Test
    fun strictDecoderRejectsInterruptNullSubagentRunId() {
        assertInterruptNullRejected("subagentRunId")
    }

    @Test
    fun strictDecoderRejectsInterruptNullResponseSchema() {
        assertInterruptNullRejected("responseSchema")
    }

    @Test
    @Suppress("DEPRECATION")
    fun strictDecoderPreservesEmptySuccessOutcomeCompanion() {
        val outcome = AgUiJson.parseToJsonElement("""{"type":"success"}""")
        val event = AgUiJson.parseToJsonElement(
            """{"type":"RUN_FINISHED","threadId":"t","runId":"r","outcome":$outcome}""",
        )

        for (target in runFinishedOutcomeTargets) {
            assertSame(
                RunFinishedSuccessOutcome,
                AgUiV1.decode(RunFinishedOutcome.serializer(), target, outcome),
                target,
            )
        }
        assertSame(RunFinishedSuccessOutcome, assertIs<RunFinishedEvent>(AgUiV1.decodeEvent(event)).outcome)
        AgUiV1.validate("RunFinishedEvent", event)
    }

    @Test
    fun strictDecoderAcceptsSuspendedOutcomeOmittedInterruptIds() {
        val outcome = AgUiJson.parseToJsonElement("""{"type":"suspended"}""")
        val event = AgUiJson.parseToJsonElement(
            """{"type":"SUBAGENT_FINISHED","subagentRunId":"s","outcome":$outcome}""",
        )
        val expected = SubagentFinishedSuspendedOutcome()

        assertEquals(expected, AgUiV1.decode(SubagentFinishedOutcome.serializer(), "SubagentFinishedOutcome", outcome))
        assertEquals(expected, assertIs<SubagentFinishedEvent>(AgUiV1.decodeEvent(event)).outcome)
        AgUiV1.validate("SubagentFinishedEvent", event)
    }

    @Test
    fun strictDecoderAcceptsInterruptOmittedOptionalFields() {
        assertInterruptDecodedAtEachBoundary(
            """{"id":"i","reason":"tool_call"}""",
            Interrupt(id = "i", reason = "tool_call"),
        )
    }

    @Test
    fun strictDecoderPreservesInterruptOpaqueNulls() {
        assertInterruptDecodedAtEachBoundary(
            """{
                "id":"i",
                "reason":"tool_call",
                "metadata":{"hint":null,"details":{"message":null}},
                "responseSchema":{"default":null,"properties":{"answer":{"default":null}}}
            }""".trimIndent(),
            Interrupt(
                id = "i",
                reason = "tool_call",
                metadata = AgUiJson.parseToJsonElement("""{"hint":null,"details":{"message":null}}""").jsonObject,
                responseSchema = AgUiJson.parseToJsonElement(
                    """{"default":null,"properties":{"answer":{"default":null}}}""",
                ).jsonObject,
            ),
        )
    }

    @Test
    fun strictDecoderRejectsTerminalUsageExplicitNulls() {
        assertFails {
            AgUiV1.decodeEvent(
                AgUiJson.parseToJsonElement(
                    """{"type":"RUN_FINISHED","threadId":"t","runId":"r","usage":[{"provider":null}]}""",
                ),
            )
        }
    }

    @Test
    fun strictDecoderRejectsRunErrorUsageExplicitNulls() {
        assertFails {
            AgUiV1.decodeEvent(
                AgUiJson.parseToJsonElement(
                    """{"type":"RUN_ERROR","message":"failed","usage":[{"model":null}]}""",
                ),
            )
        }
    }

    @Test
    fun strictDecoderAcceptsTerminalUsageOmittedOptionalFields() {
        val finished = AgUiV1.decodeEvent(
            AgUiJson.parseToJsonElement(
                """{"type":"RUN_FINISHED","threadId":"t","runId":"r","usage":[{}]}""",
            ),
        )
        val error = AgUiV1.decodeEvent(
            AgUiJson.parseToJsonElement(
                """{"type":"RUN_ERROR","message":"failed","usage":[{}]}""",
            ),
        )

        assertEquals(listOf(TokenUsage()), assertIs<RunFinishedEvent>(finished).usage)
        assertEquals(listOf(TokenUsage()), assertIs<RunErrorEvent>(error).usage)
    }

    @Test
    fun strictDecoderAcceptsTerminalUsageLabelsAndSafeCounts() {
        val usage = """[
            {"provider":"provider-1","model":"model-1","inputTokens":9007199254740991,"outputTokens":0,"totalTokens":9007199254740991,"reasoningTokens":0,"cachedInputTokens":9007199254740991,"cacheWriteInputTokens":0},
            {"inputTokens":0,"outputTokens":9007199254740991,"totalTokens":9007199254740991,"reasoningTokens":9007199254740991,"cachedInputTokens":0,"cacheWriteInputTokens":0}
        ]""".trimIndent()
        val finished = AgUiV1.decodeEvent(
            AgUiJson.parseToJsonElement(
                """{"type":"RUN_FINISHED","threadId":"t","runId":"r","usage":$usage}""",
            ),
        )
        val error = AgUiV1.decodeEvent(
            AgUiJson.parseToJsonElement(
                """{"type":"RUN_ERROR","message":"failed","usage":$usage}""",
            ),
        )
        val expected = listOf(
            TokenUsage(
                provider = "provider-1",
                model = "model-1",
                inputTokens = 9007199254740991L,
                outputTokens = 0,
                totalTokens = 9007199254740991L,
                reasoningTokens = 0,
                cachedInputTokens = 9007199254740991L,
                cacheWriteInputTokens = 0,
            ),
            TokenUsage(
                inputTokens = 0,
                outputTokens = 9007199254740991L,
                totalTokens = 9007199254740991L,
                reasoningTokens = 9007199254740991L,
                cachedInputTokens = 0,
                cacheWriteInputTokens = 0,
            ),
        )

        assertEquals(expected, assertIs<RunFinishedEvent>(finished).usage)
        assertEquals(expected, assertIs<RunErrorEvent>(error).usage)
    }

    @Test
    fun strictDecoderRejectsTerminalUsageCountsOutsideSafeRange() {
        val countKeys = listOf(
            "inputTokens", "outputTokens", "totalTokens", "reasoningTokens",
            "cachedInputTokens", "cacheWriteInputTokens",
        )
        for (key in countKeys) {
            for (count in listOf(-1L, 9007199254740992L)) {
                val events = listOf(
                    """{"type":"RUN_FINISHED","threadId":"t","runId":"r","usage":[{"$key":$count}]}""",
                    """{"type":"RUN_ERROR","message":"failed","usage":[{"$key":$count}]}""",
                )
                for (event in events) {
                    assertFails(event) {
                        AgUiV1.decodeEvent(AgUiJson.parseToJsonElement(event))
                    }
                }
            }
        }
    }

    @Test
    fun strictDecoderPreservesGeneratedUsageDecoderIntegralExponentSupport() {
        val usage = AgUiJson.parseToJsonElement("""{"inputTokens":1e3}""")
        assertEquals(
            TokenUsage(inputTokens = 1000),
            AgUiJson.decodeFromJsonElement(TokenUsage.serializer(), usage),
        )

        assertUsageCountDecodes("1e3", 1000)
    }

    @Test
    fun strictDecoderAcceptsIntegralDecimalAndExponentUsageCounts() {
        val counts = listOf(
            "-0" to 0L,
            "0.0" to 0L,
            "-0.0e10" to 0L,
            "0e999999999999999999999999" to 0L,
            "0e-999999999999999999999999" to 0L,
            "1.0" to 1L,
            "1E+3" to 1000L,
            "1e+0000000000000000000003" to 1000L,
            "10e-1" to 1L,
            "1.20e2" to 120L,
            "100.0e-2" to 1L,
            "9007199254740991.0" to 9007199254740991L,
            "9.007199254740991e15" to 9007199254740991L,
            "90071992547409910e-1" to 9007199254740991L,
        )
        for ((count, expected) in counts) assertUsageCountDecodes(count, expected)
    }

    @Test
    fun strictDecoderRejectsQuotedUsageCounts() {
        for (count in listOf("\"1\"", "\"1.0\"", "\"1e3\"")) assertUsageCountRejected(count)
    }

    @Test
    fun strictDecoderRejectsUsageCountsWithoutAnExactNonNegativeSafeIntegerValue() {
        val counts = listOf(
            "true", "false", "null", "[]", "{}",
            "1.5", "1e-1", "9007199254740990.5", "9007199254740991.1",
            "9.0071992547409905e15", "1.0000000000000001",
            "-1", "-1.0", "-1e3", "-1e-999999999999999999999999",
            "9007199254740992", "9007199254740992.0", "9.007199254740992e15",
            "1e9223372036854775807", "1e-9223372036854775808",
            "1e999999999999999999999999", "1e-999999999999999999999999",
        )
        for (count in counts) assertUsageCountRejected(count)
    }

    @Test
    fun strictDecoderPreservesOpaqueJsonAlongsideUsageCounts() {
        val opaque = AgUiJson.parseToJsonElement(
            """{"usage":[{"inputTokens":"1","outputTokens":1.5,"totalTokens":null}],"inputTokens":1e3}""",
        )
        val finished = AgUiV1.decodeEvent(
            buildJsonObject {
                put("type", "RUN_FINISHED")
                put("threadId", "t")
                put("runId", "r")
                put("usage", buildJsonArray { add(AgUiJson.parseToJsonElement("""{"inputTokens":1e3}""")) })
                put("result", opaque)
                put("rawEvent", opaque)
                put("metadata", opaque)
            },
        )

        val event = assertIs<RunFinishedEvent>(finished)
        assertEquals(listOf(TokenUsage(inputTokens = 1000)), event.usage)
        assertEquals(opaque, event.result)
        assertEquals(opaque, event.rawEvent)
        assertEquals(opaque.jsonObject, event.metadata)
    }

    private fun assertUsageCountDecodes(count: String, expected: Long) {
        val usage = AgUiJson.parseToJsonElement(
            usageCountKeys.joinToString(prefix = "{", postfix = "}") { "\"$it\":$count" },
        ).jsonObject
        val expectedUsage = TokenUsage(
            inputTokens = expected,
            outputTokens = expected,
            totalTokens = expected,
            reasoningTokens = expected,
            cachedInputTokens = expected,
            cacheWriteInputTokens = expected,
        )
        for (target in listOf("TokenUsage", "tokenUsage")) {
            assertEquals(expectedUsage, AgUiV1.decode(TokenUsage.serializer(), target, usage), "$target: $count")
        }
        val (finished, error) = terminalUsageEvents(usage).map(AgUiV1::decodeEvent)
        assertEquals(listOf(expectedUsage), assertIs<RunFinishedEvent>(finished).usage, "RUN_FINISHED: $count")
        assertEquals(listOf(expectedUsage), assertIs<RunErrorEvent>(error).usage, "RUN_ERROR: $count")
    }

    private fun assertUsageCountRejected(count: String) {
        for (key in usageCountKeys) {
            val usage = AgUiJson.parseToJsonElement("""{"$key":$count}""").jsonObject
            for (target in listOf("TokenUsage", "tokenUsage")) {
                assertFails("$target.$key: $count") { AgUiV1.decode(TokenUsage.serializer(), target, usage) }
            }
            for (event in terminalUsageEvents(usage)) {
                assertFails(event.toString()) { AgUiV1.decodeEvent(event) }
            }
        }
    }

    private fun terminalUsageEvents(usage: JsonObject): List<JsonObject> = listOf(
        AgUiJson.parseToJsonElement(
            """{"type":"RUN_FINISHED","threadId":"t","runId":"r","usage":[$usage]}""",
        ).jsonObject,
        AgUiJson.parseToJsonElement(
            """{"type":"RUN_ERROR","message":"failed","usage":[$usage]}""",
        ).jsonObject,
    )

    private val usageCountKeys = listOf(
        "inputTokens", "outputTokens", "totalTokens", "reasoningTokens",
        "cachedInputTokens", "cacheWriteInputTokens",
    )

    @Test
    fun strictTypedRoutesRejectExplicitNulls() {
        val accepted = mutableListOf<String>()
        for (contract in typedRouteContracts()) {
            for (field in contract.forbiddenNullFields) {
                val value = JsonObject(jsonFixture(contract.omittedFields) + (field to JsonNull))
                for (route in contract.routes) {
                    if (runCatching { route.decode(value) }.isSuccess) {
                        accepted += "${contract.name}.$field via ${route.name}"
                    }
                }
            }
        }
        assertEquals(emptyList(), accepted, "Typed boundaries must reject explicit nulls on every declared route")
    }

    @Test
    fun strictTypedRoutesAcceptOmittedOptionalFields() {
        for (contract in typedRouteContracts()) {
            for (route in contract.routes) {
                assertEquals(
                    contract.expected,
                    route.decode(jsonFixture(contract.omittedFields)),
                    "${contract.name} via ${route.name}",
                )
            }
        }
    }

    @Test
    fun strictMultimodalRoutesPreserveTrueAndFalseFlags() {
        for (flag in listOf(true, false)) {
            val input = MultimodalInputCapabilities(flag, flag, flag, flag, flag)
            val output = MultimodalOutputCapabilities(flag, flag)
            for (contract in typedRouteContracts().filter { it.name in setOf("multimodal input", "multimodal output") }) {
                val value = buildJsonObject { contract.forbiddenNullFields.forEach { put(it, flag) } }
                val expected = if (contract.name == "multimodal input") input else output
                for (route in contract.routes) {
                    assertEquals(expected, route.decode(value), "${contract.name} via ${route.name}: $flag")
                }
            }
        }
    }

    private data class TypedRoute(val name: String, val decode: (JsonObject) -> Any?)

    private data class TypedRouteContract(
        val name: String,
        val omittedFields: String,
        val expected: Any,
        val forbiddenNullFields: List<String>,
        val routes: List<TypedRoute>,
    )

    private fun jsonFixture(value: String): JsonObject = AgUiJson.parseToJsonElement(value).jsonObject

    private fun <T> directTypedRoute(serializer: KSerializer<T>, target: String): TypedRoute =
        TypedRoute(target) { AgUiV1.decode(serializer, target, it) }

    private val runFinishedOutcomeTargets = listOf("RunFinishedOutcome", "runFinishedOutcome")

    private fun messageRoutes(): List<TypedRoute> = listOf(
        directTypedRoute(Message.serializer(), "Message"),
        directTypedRoute(Message.serializer(), "message"),
        TypedRoute("decodeMessage") { AgUiV1.decodeMessage(it) },
    )

    // Finite schema fixtures for supported routes; never inferred from the validator or serializer descriptors.
    @Suppress("DEPRECATION")
    private fun typedRouteContracts(): List<TypedRouteContract> = listOf(
        TypedRouteContract(
            "success outcome", """{"type":"success"}""", RunFinishedSuccessOutcome,
            listOf("pendingToolCallIds"),
            runFinishedOutcomeTargets.map { directTypedRoute(RunFinishedOutcome.serializer(), it) } + listOf(
                TypedRoute("RUN_FINISHED") {
                    assertIs<RunFinishedEvent>(AgUiV1.decodeEvent(jsonFixture(
                        """{"type":"RUN_FINISHED","threadId":"t","runId":"r","outcome":$it}""",
                    ))).outcome
                },
            ),
        ),
        TypedRouteContract(
            "suspended outcome", """{"type":"suspended"}""", SubagentFinishedSuspendedOutcome(),
            listOf("interruptIds"),
            listOf(
                directTypedRoute(SubagentFinishedOutcome.serializer(), "SubagentFinishedOutcome"),
                TypedRoute("SUBAGENT_FINISHED") {
                    assertIs<SubagentFinishedEvent>(AgUiV1.decodeEvent(jsonFixture(
                        """{"type":"SUBAGENT_FINISHED","subagentRunId":"s","outcome":$it}""",
                    ))).outcome
                },
            ),
        ),
        TypedRouteContract(
            "interrupt", """{"id":"i","reason":"tool_call"}""", Interrupt("i", "tool_call"),
            listOf("message", "toolCallId", "expiresAt", "metadata", "subagentRunId", "responseSchema"),
            listOf(
                directTypedRoute(Interrupt.serializer(), "Interrupt"),
            ) + runFinishedOutcomeTargets.map { target ->
                TypedRoute("$target.interrupts") {
                    assertIs<RunFinishedInterruptOutcome>(AgUiV1.decode(
                        RunFinishedOutcome.serializer(), target,
                        jsonFixture("""{"type":"interrupt","interrupts":[$it]}"""),
                    )).interrupts.single()
                }
            } + listOf(
                TypedRoute("RUN_FINISHED.outcome.interrupts") {
                    val event = AgUiV1.decodeEvent(jsonFixture(
                        """{"type":"RUN_FINISHED","threadId":"t","runId":"r","outcome":{"type":"interrupt","interrupts":[$it]}}""",
                    ))
                    assertIs<RunFinishedInterruptOutcome>(assertIs<RunFinishedEvent>(event).outcome).interrupts.single()
                },
            ),
        ),
        TypedRouteContract(
            "capability tool item", """{"name":"search","description":"Search"}""", Tool("search", "Search"),
            listOf("parameters", "metadata"),
            listOf(
                directTypedRoute(Tool.serializer(), "Tool"),
                TypedRoute("ToolsCapabilities.items") {
                    val tools = AgUiV1.decode(ToolsCapabilities.serializer(), "ToolsCapabilities",
                        jsonFixture("""{"items":[$it]}"""))
                    requireNotNull(tools.items).single()
                },
                TypedRoute("AgentCapabilities.tools.items") {
                    val agent = AgUiV1.decode(AgentCapabilities.serializer(), "AgentCapabilities",
                        jsonFixture("""{"tools":{"items":[$it]}}"""))
                    requireNotNull(requireNotNull(agent.tools).items).single()
                },
            ),
        ),
        TypedRouteContract(
            "capability subagent item", """{"name":"researcher"}""", SubagentInfo("researcher"),
            listOf("description"),
            listOf(
                directTypedRoute(SubagentInfo.serializer(), "SubagentInfo"),
                TypedRoute("MultiAgentCapabilities.subagents") {
                    val multiAgent = AgUiV1.decode(MultiAgentCapabilities.serializer(), "MultiAgentCapabilities",
                        jsonFixture("""{"subagents":[$it]}"""))
                    requireNotNull(multiAgent.subagents).single()
                },
                TypedRoute("AgentCapabilities.multiAgent.subagents") {
                    val agent = AgUiV1.decode(AgentCapabilities.serializer(), "AgentCapabilities",
                        jsonFixture("""{"multiAgent":{"subagents":[$it]}}"""))
                    requireNotNull(requireNotNull(agent.multiAgent).subagents).single()
                },
            ),
        ),
        TypedRouteContract(
            "content part", """{"type":"text","text":"Hello"}""", TextPart("Hello"),
            listOf("id", "metadata"),
            listOf(
                directTypedRoute(ContentPart.serializer(), "ContentPart"),
                TypedRoute("UserMessage.content") {
                    requireNotNull(assertIs<UserMessage>(AgUiV1.decodeMessage(jsonFixture(
                        """{"id":"m","role":"user","content":[$it]}""",
                    ))).contentParts).single()
                },
                TypedRoute("TOOL_CALL_RESULT.content") {
                    requireNotNull(assertIs<ToolCallResultEvent>(AgUiV1.decodeEvent(jsonFixture(
                        """{"type":"TOOL_CALL_RESULT","messageId":"m","toolCallId":"c","content":[$it]}""",
                    ))).contentParts).single()
                },
            ),
        ),
        TypedRouteContract(
            "content source", """{"type":"file","value":"file-1"}""", FileSource("file-1"),
            listOf("value", "provider", "mimeType"),
            listOf(
                directTypedRoute(FileSource.serializer(), "FileSource"),
                directTypedRoute(PartSource.serializer(), "PartSource"),
                TypedRoute("ContentPart.source") {
                    assertIs<DocumentPart>(AgUiV1.decode(ContentPart.serializer(), "ContentPart",
                        jsonFixture("""{"type":"document","source":$it}"""))).source
                },
            ),
        ),
        TypedRouteContract(
            "multimodal sections", "{}", MultimodalCapabilities(), listOf("input", "output"),
            listOf(
                directTypedRoute(MultimodalCapabilities.serializer(), "MultimodalCapabilities"),
                TypedRoute("AgentCapabilities.multimodal") {
                    AgUiV1.decode(AgentCapabilities.serializer(), "AgentCapabilities",
                        jsonFixture("""{"multimodal":$it}""")).multimodal
                },
            ),
        ),
        TypedRouteContract(
            "multimodal input", "{}", MultimodalInputCapabilities(), listOf("image", "audio", "video", "pdf", "file"),
            listOf(
                directTypedRoute(MultimodalInputCapabilities.serializer(), "MultimodalInputCapabilities"),
                TypedRoute("MultimodalCapabilities.input") {
                    AgUiV1.decode(MultimodalCapabilities.serializer(), "MultimodalCapabilities",
                        jsonFixture("""{"input":$it}""")).input
                },
                TypedRoute("AgentCapabilities.multimodal.input") {
                    AgUiV1.decode(AgentCapabilities.serializer(), "AgentCapabilities",
                        jsonFixture("""{"multimodal":{"input":$it}}""")).multimodal?.input
                },
            ),
        ),
        TypedRouteContract(
            "multimodal output", "{}", MultimodalOutputCapabilities(), listOf("image", "audio"),
            listOf(
                directTypedRoute(MultimodalOutputCapabilities.serializer(), "MultimodalOutputCapabilities"),
                TypedRoute("MultimodalCapabilities.output") {
                    AgUiV1.decode(MultimodalCapabilities.serializer(), "MultimodalCapabilities",
                        jsonFixture("""{"output":$it}""")).output
                },
                TypedRoute("AgentCapabilities.multimodal.output") {
                    AgUiV1.decode(AgentCapabilities.serializer(), "AgentCapabilities",
                        jsonFixture("""{"multimodal":{"output":$it}}""")).multimodal?.output
                },
            ),
        ),
    )

    @Test
    fun strictDecoderRejectsCapabilityToolNullParameters() {
        assertFails {
            AgUiV1.decode(
                AgentCapabilities.serializer(),
                "AgentCapabilities",
                AgUiJson.parseToJsonElement(
                    """{"tools":{"items":[{"name":"search","description":"Search","parameters":null}]}}""",
                ),
            )
        }
    }

    @Test
    fun strictDecoderRejectsCapabilityToolNullMetadata() {
        assertFails {
            AgUiV1.decode(
                AgentCapabilities.serializer(),
                "AgentCapabilities",
                AgUiJson.parseToJsonElement(
                    """{"tools":{"items":[{"name":"search","description":"Search","metadata":null}]}}""",
                ),
            )
        }
    }

    @Test
    fun strictDecoderRejectsCapabilitySubagentNullDescription() {
        assertFails {
            AgUiV1.decode(
                AgentCapabilities.serializer(),
                "AgentCapabilities",
                AgUiJson.parseToJsonElement(
                    """{"multiAgent":{"subagents":[{"name":"researcher","description":null}]}}""",
                ),
            )
        }
    }

    @Test
    fun strictDecoderRejectsStandaloneToolsCapabilitiesNullParameters() {
        assertFails {
            AgUiV1.decode(
                ToolsCapabilities.serializer(),
                "ToolsCapabilities",
                AgUiJson.parseToJsonElement(
                    """{"items":[{"name":"search","description":"Search","parameters":null}]}""",
                ),
            )
        }
    }

    @Test
    fun strictDecoderRejectsStandaloneToolsCapabilitiesNullMetadata() {
        assertFails {
            AgUiV1.decode(
                ToolsCapabilities.serializer(),
                "ToolsCapabilities",
                AgUiJson.parseToJsonElement(
                    """{"items":[{"name":"search","description":"Search","metadata":null}]}""",
                ),
            )
        }
    }

    @Test
    fun strictDecoderRejectsStandaloneMultiAgentCapabilitiesNullDescription() {
        assertFails {
            AgUiV1.decode(
                MultiAgentCapabilities.serializer(),
                "MultiAgentCapabilities",
                AgUiJson.parseToJsonElement(
                    """{"subagents":[{"name":"researcher","description":null}]}""",
                ),
            )
        }
    }

    @Test
    fun strictDecoderAcceptsCapabilityArrayItemsWithOmittedOptionals() {
        val decoded = AgUiV1.decode(
            AgentCapabilities.serializer(),
            "AgentCapabilities",
            AgUiJson.parseToJsonElement(
                """{"tools":{"items":[{"name":"search","description":"Search"}]},"multiAgent":{"subagents":[{"name":"researcher"},{"name":"writer","description":"Writes reports"}]}}""",
            ),
        )

        assertEquals(listOf(Tool("search", "Search")), requireNotNull(decoded.tools).items)
        assertEquals(
            listOf(SubagentInfo("researcher"), SubagentInfo("writer", "Writes reports")),
            requireNotNull(decoded.multiAgent).subagents,
        )
    }

    @Test
    fun strictDecoderAcceptsStandaloneTypedCapabilitiesWithOmittedOptionals() {
        val tools = AgUiV1.decode(
            ToolsCapabilities.serializer(),
            "ToolsCapabilities",
            AgUiJson.parseToJsonElement("""{"items":[{"name":"search","description":"Search"}]}"""),
        )
        val multiAgent = AgUiV1.decode(
            MultiAgentCapabilities.serializer(),
            "MultiAgentCapabilities",
            AgUiJson.parseToJsonElement("""{"subagents":[{"name":"researcher"}]}"""),
        )

        assertEquals(ToolsCapabilities(items = listOf(Tool("search", "Search"))), tools)
        assertEquals(MultiAgentCapabilities(subagents = listOf(SubagentInfo("researcher"))), multiAgent)
    }

    @Test
    fun strictDecoderPreservesCapabilityOpaqueNulls() {
        val opaque = AgUiJson.parseToJsonElement(
            """{"default":null,"properties":{"query":{"default":null}},"items":[null,{"metadata":null}],"tools":{"items":[{"parameters":null}]},"multiAgent":{"subagents":[{"description":null}]}}""",
        ).jsonObject
        val decoded = AgUiV1.decode(
            AgentCapabilities.serializer(),
            "AgentCapabilities",
            AgUiJson.parseToJsonElement(
                """{"identity":{"metadata":$opaque},"tools":{"items":[{"name":"search","description":"Search","parameters":$opaque,"metadata":$opaque}]},"custom":$opaque}""",
            ),
        )

        val tool = requireNotNull(requireNotNull(decoded.tools).items).single()
        assertEquals(opaque, tool.parameters)
        assertEquals(opaque, tool.metadata)
        assertEquals(opaque, requireNotNull(decoded.identity).metadata)
        assertEquals(opaque, decoded.custom)
    }

    @Test
    fun strictDecoderPreservesStandaloneCapabilityToolOpaqueNulls() {
        val decoded = AgUiV1.decode(
            ToolsCapabilities.serializer(),
            "ToolsCapabilities",
            AgUiJson.parseToJsonElement(
                """{"items":[{"name":"search","description":"Search","parameters":[null,{"default":null}],"metadata":{"hint":null,"subagents":[{"description":null}]}}]}""",
            ),
        )

        val tool = requireNotNull(decoded.items).single()
        assertEquals(AgUiJson.parseToJsonElement("""[null,{"default":null}]"""), tool.parameters)
        assertEquals(
            AgUiJson.parseToJsonElement("""{"hint":null,"subagents":[{"description":null}]}""").jsonObject,
            tool.metadata,
        )
    }

    @Test
    fun strictDecoderRejectsRunInputToolNullParameters() {
        assertFails {
            AgUiV1.decodeRunAgentInput(
                AgUiJson.parseToJsonElement(
                    """{"threadId":"t","runId":"r","messages":[],"tools":[{"name":"search","description":"Search","parameters":null}]}""",
                ),
            )
        }
    }

    @Test
    fun strictDecoderRejectsRunStartedInputToolNullParameters() {
        assertFails {
            AgUiV1.decodeEvent(
                AgUiJson.parseToJsonElement(
                    """{"type":"RUN_STARTED","threadId":"t","runId":"r","input":{"threadId":"t","runId":"r","messages":[],"tools":[{"name":"search","description":"Search","parameters":null}]}}""",
                ),
            )
        }
    }

    @Test
    fun strictDecoderRejectsRunStartedInputResumeNullPayload() {
        assertFails {
            AgUiV1.decodeEvent(
                AgUiJson.parseToJsonElement(
                    """{"type":"RUN_STARTED","threadId":"t","runId":"r","input":{"threadId":"t","runId":"r","messages":[],"resume":[{"interruptId":"i","status":"resolved","payload":null}]}}""",
                ),
            )
        }
    }

    @Test
    fun strictDecoderRejectsRunStartedInputContentPartNullMetadata() {
        assertFails {
            AgUiV1.decodeEvent(
                AgUiJson.parseToJsonElement(
                    """{"type":"RUN_STARTED","threadId":"t","runId":"r","input":{"threadId":"t","runId":"r","messages":[{"id":"m","role":"user","content":[{"type":"image","source":{"type":"url","value":"https://example.com/image.png"},"metadata":null}]}]}}""",
                ),
            )
        }
    }

    @Test
    fun strictDecoderRejectsRunStartedInputUrlSourceNullMimeType() {
        assertFails {
            AgUiV1.decodeEvent(
                AgUiJson.parseToJsonElement(
                    """{"type":"RUN_STARTED","threadId":"t","runId":"r","input":{"threadId":"t","runId":"r","messages":[{"id":"m","role":"user","content":[{"type":"image","source":{"type":"url","value":"https://example.com/image.png","mimeType":null}}]}]}}""",
                ),
            )
        }
    }

    @Test
    fun strictDecoderRejectsRunStartedInputFileSourceNullMimeType() {
        assertFails {
            AgUiV1.decodeEvent(
                AgUiJson.parseToJsonElement(
                    """{"type":"RUN_STARTED","threadId":"t","runId":"r","input":{"threadId":"t","runId":"r","messages":[{"id":"m","role":"user","content":[{"type":"document","source":{"type":"file","value":"file-1","provider":"openai","mimeType":null}}]}]}}""",
                ),
            )
        }
    }

    @Test
    fun strictDecoderRejectsRunStartedInputFileSourceNullProvider() {
        assertFails {
            AgUiV1.decodeEvent(
                AgUiJson.parseToJsonElement(
                    """{"type":"RUN_STARTED","threadId":"t","runId":"r","input":{"threadId":"t","runId":"r","messages":[{"id":"m","role":"user","content":[{"type":"document","source":{"type":"file","value":"file-1","provider":null,"mimeType":"application/pdf"},"metadata":{"label":"invoice"}}]}]}}""",
                ),
            )
        }
    }

    @Test
    fun strictDecoderRejectsRunStartedInputNullParentRunId() {
        assertFails {
            AgUiV1.decodeEvent(
                AgUiJson.parseToJsonElement(
                    """{"type":"RUN_STARTED","threadId":"t","runId":"r","input":{"threadId":"t","runId":"r","parentRunId":null,"messages":[]}}""",
                ),
            )
        }
    }

    @Test
    fun strictDecoderRejectsRunInputNullParentRunId() {
        assertFails {
            AgUiV1.decodeRunAgentInput(
                AgUiJson.parseToJsonElement(
                    """{"threadId":"t","runId":"r","parentRunId":null,"messages":[]}""",
                ),
            )
        }
    }

    @Test
    fun strictDecoderAcceptsRunStartedInputWithoutParentRunId() {
        val input = AgUiJson.parseToJsonElement("""{"threadId":"t","runId":"r","messages":[]}""")
        val standalone = AgUiV1.decodeRunAgentInput(input)
        val started = AgUiV1.decodeEvent(
            buildJsonObject {
                put("type", "RUN_STARTED")
                put("threadId", "t")
                put("runId", "r")
                put("input", input)
            },
        )

        assertNull(standalone.parentRunId)
        assertEquals(standalone, assertIs<RunStartedEvent>(started).input)
    }

    @Test
    fun strictDecoderPreservesRunStartedInputOpaqueNulls() {
        val started = AgUiV1.decodeEvent(
            AgUiJson.parseToJsonElement(
                """{
                    "type":"RUN_STARTED",
                    "threadId":"t",
                    "runId":"r",
                    "input":{
                        "threadId":"t",
                        "runId":"r",
                        "messages":[{"id":"m","role":"user","content":[
                            {"type":"image","source":{"type":"url","value":"https://example.com/image.png"},"metadata":{"caption":null,"details":{"source":null}}}
                        ]}],
                        "tools":[{"name":"search","description":"Search","parameters":{"default":null,"properties":{"query":{"default":null}}},"metadata":{"hint":null}}],
                        "resume":[{"interruptId":"i","status":"resolved","payload":{"answer":null,"options":{"value":null}},"metadata":{"hint":null}}],
                        "forwardedProps":{"flag":null,"options":{"value":null}}
                    }
                }""".trimIndent(),
            ),
        )

        val input = requireNotNull(assertIs<RunStartedEvent>(started).input)
        val tool = input.tools.single()
        assertEquals(
            AgUiJson.parseToJsonElement("""{"default":null,"properties":{"query":{"default":null}}}"""),
            tool.parameters,
        )
        assertEquals(AgUiJson.parseToJsonElement("""{"hint":null}""").jsonObject, tool.metadata)
        val resume = requireNotNull(input.resume).single()
        assertEquals(
            AgUiJson.parseToJsonElement("""{"answer":null,"options":{"value":null}}"""),
            resume.payload,
        )
        assertEquals(AgUiJson.parseToJsonElement("""{"hint":null}""").jsonObject, resume.metadata)
        val part = assertIs<ImagePart>(requireNotNull(assertIs<UserMessage>(input.messages.single()).contentParts).single())
        assertEquals(
            AgUiJson.parseToJsonElement("""{"caption":null,"details":{"source":null}}"""),
            part.metadata,
        )
        assertEquals(
            AgUiJson.parseToJsonElement("""{"flag":null,"options":{"value":null}}"""),
            input.forwardedProps,
        )
    }

    @Test
    fun strictDecoderRejectsRunInputToolNullMetadata() {
        assertFails {
            AgUiV1.decodeRunAgentInput(
                AgUiJson.parseToJsonElement(
                    """{"threadId":"t","runId":"r","messages":[],"tools":[{"name":"search","description":"Search","metadata":null}]}""",
                ),
            )
        }
    }

    @Test
    fun strictDecoderAcceptsRunInputToolOmittedOptionalFields() {
        val decoded = AgUiV1.decodeRunAgentInput(
            AgUiJson.parseToJsonElement(
                """{"threadId":"t","runId":"r","messages":[],"tools":[{"name":"search","description":"Search"}]}""",
            ),
        )

        val tool = decoded.tools.single()
        assertEquals("search", tool.name)
        assertEquals("Search", tool.description)
        assertNull(tool.parameters)
        assertNull(tool.metadata)
    }

    @Test
    fun strictDecoderPreservesRunInputToolAndForwardedApplicationNulls() {
        val decoded = AgUiV1.decodeRunAgentInput(
            AgUiJson.parseToJsonElement(
                """{"threadId":"t","runId":"r","messages":[],"tools":[{"name":"search","description":"Search","parameters":{"default":null,"properties":{"query":{"default":null}}},"metadata":{"hint":null}}],"forwardedProps":{"flag":null,"options":{"value":null}}}""",
            ),
        )

        val tool = decoded.tools.single()
        assertEquals(
            AgUiJson.parseToJsonElement("""{"default":null,"properties":{"query":{"default":null}}}"""),
            tool.parameters,
        )
        assertEquals(AgUiJson.parseToJsonElement("""{"hint":null}""").jsonObject, tool.metadata)
        assertEquals(
            AgUiJson.parseToJsonElement("""{"flag":null,"options":{"value":null}}"""),
            decoded.forwardedProps,
        )
    }

    @Test
    fun strictDecoderRejectsRunInputResumeNullPayload() {
        assertFails {
            AgUiV1.decodeRunAgentInput(
                AgUiJson.parseToJsonElement(
                    """{"threadId":"t","runId":"r","messages":[],"resume":[{"interruptId":"i","status":"resolved","payload":null}]}""",
                ),
            )
        }
    }

    @Test
    fun strictDecoderRejectsRunInputResumeNullMetadata() {
        assertFails {
            AgUiV1.decodeRunAgentInput(
                AgUiJson.parseToJsonElement(
                    """{"threadId":"t","runId":"r","messages":[],"resume":[{"interruptId":"i","status":"cancelled","metadata":null}]}""",
                ),
            )
        }
    }

    @Test
    fun strictDecoderAcceptsRunInputResumeOmittedOptionalFields() {
        val decoded = AgUiV1.decodeRunAgentInput(
            AgUiJson.parseToJsonElement(
                """{"threadId":"t","runId":"r","messages":[],"resume":[{"interruptId":"resolved","status":"resolved"},{"interruptId":"cancelled","status":"cancelled"}]}""",
            ),
        )

        val entries = requireNotNull(decoded.resume)
        assertEquals(listOf("resolved", "cancelled"), entries.map { it.interruptId })
        assertEquals(listOf(ResumeStatus.RESOLVED, ResumeStatus.CANCELLED), entries.map { it.status })
        entries.forEach {
            assertNull(it.payload)
            assertNull(it.metadata)
        }
    }

    @Test
    fun strictDecoderPreservesRunInputResumeApplicationNulls() {
        val decoded = AgUiV1.decodeRunAgentInput(
            AgUiJson.parseToJsonElement(
                """{"threadId":"t","runId":"r","messages":[],"resume":[{"interruptId":"i","status":"resolved","payload":{"answer":null,"options":{"value":null}},"metadata":{"hint":null}}]}""",
            ),
        )

        val entry = requireNotNull(decoded.resume).single()
        assertEquals(ResumeStatus.RESOLVED, entry.status)
        assertEquals(
            AgUiJson.parseToJsonElement("""{"answer":null,"options":{"value":null}}"""),
            entry.payload,
        )
        assertEquals(AgUiJson.parseToJsonElement("""{"hint":null}""").jsonObject, entry.metadata)
    }

    @Test
    fun strictDecoderRejectsRunInputContentPartNullMetadata() {
        assertFails {
            AgUiV1.decodeRunAgentInput(
                AgUiJson.parseToJsonElement(
                    """{"threadId":"t","runId":"r","messages":[{"id":"m","role":"user","content":[{"type":"image","source":{"type":"url","value":"https://example.com/image.png"},"metadata":null}]}]}""",
                ),
            )
        }
    }

    @Test
    fun strictDecoderAcceptsRunInputContentPartsWithoutMetadata() {
        val decoded = AgUiV1.decodeRunAgentInput(
            AgUiJson.parseToJsonElement(
                """{
                    "threadId":"t",
                    "runId":"r",
                    "messages":[{"id":"m","role":"user","content":[
                        {"type":"text","text":"Hello"},
                        {"type":"image","source":{"type":"url","value":"https://example.com/image.png"}},
                        {"type":"audio","source":{"type":"data","value":"AQID","mimeType":"audio/wav"}},
                        {"type":"video","source":{"type":"url","value":"https://example.com/video.mp4"}},
                        {"type":"document","source":{"type":"file","value":"file-1","provider":"openai"}}
                    ]}]
                }""".trimIndent(),
            ),
        )

        val parts = requireNotNull(assertIs<UserMessage>(decoded.messages.single()).contentParts)
        assertEquals(
            listOf<ContentPart>(
                TextPart("Hello"),
                ImagePart(UrlSource("https://example.com/image.png")),
                AudioPart(DataSource("AQID", "audio/wav")),
                VideoPart(UrlSource("https://example.com/video.mp4")),
                DocumentPart(FileSource("file-1", provider = "openai")),
            ),
            parts,
        )
    }

    @Test
    fun strictDecoderPreservesRunInputContentPartOpaqueMetadata() {
        val decoded = AgUiV1.decodeRunAgentInput(
            AgUiJson.parseToJsonElement(
                """{
                    "threadId":"t",
                    "runId":"r",
                    "messages":[{"id":"m","role":"user","content":[
                        {"type":"text","text":"Hello","metadata":"caption"},
                        {"type":"image","source":{"type":"url","value":"https://example.com/image.png"},"metadata":42},
                        {"type":"audio","source":{"type":"data","value":"AQID","mimeType":"audio/wav"},"metadata":true},
                        {"type":"video","source":{"type":"url","value":"https://example.com/video.mp4"},"metadata":["chapter",null,{"title":null}]},
                        {"type":"document","source":{"type":"file","value":"file-1","provider":"openai"},"metadata":{"caption":null,"details":{"source":null}}}
                    ]}]
                }""".trimIndent(),
            ),
        )

        val parts = requireNotNull(assertIs<UserMessage>(decoded.messages.single()).contentParts)
        assertEquals(AgUiJson.parseToJsonElement("\"caption\""), assertIs<TextPart>(parts[0]).metadata)
        assertEquals(AgUiJson.parseToJsonElement("42"), assertIs<ImagePart>(parts[1]).metadata)
        assertEquals(AgUiJson.parseToJsonElement("true"), assertIs<AudioPart>(parts[2]).metadata)
        assertEquals(
            AgUiJson.parseToJsonElement("""["chapter",null,{"title":null}]"""),
            assertIs<VideoPart>(parts[3]).metadata,
        )
        assertEquals(
            AgUiJson.parseToJsonElement("""{"caption":null,"details":{"source":null}}"""),
            assertIs<DocumentPart>(parts[4]).metadata,
        )
    }

    @Test
    fun strictDecoderRejectsRunInputUrlSourceNullMimeType() {
        assertFails {
            AgUiV1.decodeRunAgentInput(
                AgUiJson.parseToJsonElement(
                    """{"threadId":"t","runId":"r","messages":[{"id":"m","role":"user","content":[{"type":"image","source":{"type":"url","value":"https://example.com/image.png","mimeType":null}}]}]}""",
                ),
            )
        }
    }

    @Test
    fun strictDecoderRejectsRunInputFileSourceNullMimeType() {
        assertFails {
            AgUiV1.decodeRunAgentInput(
                AgUiJson.parseToJsonElement(
                    """{"threadId":"t","runId":"r","messages":[{"id":"m","role":"user","content":[{"type":"document","source":{"type":"file","value":"file-1","provider":"openai","mimeType":null}}]}]}""",
                ),
            )
        }
    }

    @Test
    fun strictDecoderRejectsRunInputFileSourceNullProvider() {
        assertFails {
            AgUiV1.decodeRunAgentInput(
                AgUiJson.parseToJsonElement(
                    """{"threadId":"t","runId":"r","messages":[{"id":"m","role":"user","content":[{"type":"document","source":{"type":"file","value":"file-1","provider":null,"mimeType":"application/pdf"},"metadata":{"label":"invoice"}}]}]}""",
                ),
            )
        }
    }

    @Test
    fun strictDecoderAcceptsRunInputSourcesWithoutOptionalFields() {
        val decoded = AgUiV1.decodeRunAgentInput(
            AgUiJson.parseToJsonElement(
                """{
                    "threadId":"t",
                    "runId":"r",
                    "messages":[{"id":"m","role":"user","content":[
                        {"type":"image","source":{"type":"url","value":"https://example.com/image.png"}},
                        {"type":"document","source":{"type":"file","value":"file-1"}},
                        {"type":"audio","source":{"type":"data","value":"AQID","mimeType":"audio/wav"}}
                    ]}]
                }""".trimIndent(),
            ),
        )

        val parts = requireNotNull(assertIs<UserMessage>(decoded.messages.single()).contentParts)
        assertEquals(
            listOf<ContentPart>(
                ImagePart(UrlSource("https://example.com/image.png")),
                DocumentPart(FileSource("file-1")),
                AudioPart(DataSource("AQID", "audio/wav")),
            ),
            parts,
        )
    }

    @Test
    fun strictDecoderAcceptsRunInputSourcesWithOptionalFieldsAndPartMetadata() {
        val decoded = AgUiV1.decodeRunAgentInput(
            AgUiJson.parseToJsonElement(
                """{
                    "threadId":"t",
                    "runId":"r",
                    "messages":[{"id":"m","role":"user","content":[
                        {"type":"image","source":{"type":"url","value":"https://example.com/image.png","mimeType":"image/png"},"metadata":{"caption":null}},
                        {"type":"document","source":{"type":"file","value":"file-1","provider":"openai","mimeType":"application/pdf"},"metadata":"invoice"},
                        {"type":"audio","source":{"type":"data","value":"AQID","mimeType":"audio/wav"},"metadata":["chapter",null]}
                    ]}]
                }""".trimIndent(),
            ),
        )

        val parts = requireNotNull(assertIs<UserMessage>(decoded.messages.single()).contentParts)
        assertEquals(
            listOf<ContentPart>(
                ImagePart(
                    UrlSource("https://example.com/image.png", mimeType = "image/png"),
                    metadata = AgUiJson.parseToJsonElement("""{"caption":null}"""),
                ),
                DocumentPart(
                    FileSource("file-1", provider = "openai", mimeType = "application/pdf"),
                    metadata = AgUiJson.parseToJsonElement("\"invoice\""),
                ),
                AudioPart(
                    DataSource("AQID", "audio/wav"),
                    metadata = AgUiJson.parseToJsonElement("""["chapter",null]"""),
                ),
            ),
            parts,
        )
    }

    @Test
    fun strictDecoderPreservesOpaqueMetadataRootMembers() {
        for (value in opaqueObjectContractFixtures) {
            assertEquals(value, AgUiV1.decode(JsonObject.serializer(), "Metadata", value), "Metadata: $value")
        }
    }

    @Test
    fun strictDecoderPreservesOpaqueStateApplicationTimestamp() {
        val value = AgUiJson.parseToJsonElement("""{"timestamp":"application clock"}""")

        assertEquals(value, AgUiV1.decode(JsonElement.serializer(), "State", value))
    }

    @Test
    fun strictDecoderPreservesAllStateJsonFormsAtRootAndSnapshot() {
        val values = opaqueObjectContractFixtures + listOf(
            "null", "[]", """[null,{"timestamp":"application clock"}]""", "\"state\"", "42.5", "true", "false",
        ).map { AgUiJson.parseToJsonElement(it) }

        for (value in values) {
            assertEquals(value, AgUiV1.decode(JsonElement.serializer(), "State", value), "State: $value")
            val snapshot = AgUiV1.decodeEvent(
                AgUiJson.parseToJsonElement("""{"type":"STATE_SNAPSHOT","snapshot":$value}"""),
            )
            assertEquals(value, assertIs<StateSnapshotEvent>(snapshot).snapshot, "STATE_SNAPSHOT.snapshot: $value")
        }
    }

    @Test
    fun strictDecoderPreservesOpaqueObjectsAtDeclaredCarriers() {
        for (value in opaqueObjectContractFixtures) {
            val snapshot = assertIs<StateSnapshotEvent>(AgUiV1.decodeEvent(
                AgUiJson.parseToJsonElement("""{"type":"STATE_SNAPSHOT","snapshot":$value,"metadata":$value}"""),
            ))
            val input = AgUiV1.decodeRunAgentInput(
                AgUiJson.parseToJsonElement("""{"threadId":"t","runId":"r","messages":[],"state":$value,"forwardedProps":$value}"""),
            )
            val interrupt = AgUiV1.decode(Interrupt.serializer(), "Interrupt", AgUiJson.parseToJsonElement(
                """{"id":"i","reason":"tool_call","metadata":$value,"responseSchema":$value}""",
            ))
            val capabilities = AgUiV1.decode(AgentCapabilities.serializer(), "AgentCapabilities", AgUiJson.parseToJsonElement(
                """{"tools":{"items":[{"name":"search","description":"Search","parameters":$value,"metadata":$value}]},"custom":$value}""",
            ))
            val tool = requireNotNull(requireNotNull(capabilities.tools).items).single()
            val part = AgUiV1.decode(ContentPart.serializer(), "ContentPart", AgUiJson.parseToJsonElement(
                """{"type":"text","text":"Hello","metadata":$value}""",
            ))
            val custom = assertIs<CustomEvent>(AgUiV1.decodeEvent(
                AgUiJson.parseToJsonElement("""{"type":"CUSTOM","name":"application","value":$value}"""),
            ))

            val carriers = mapOf(
                "StateSnapshotEvent.snapshot" to snapshot.snapshot,
                "StateSnapshotEvent.metadata" to snapshot.metadata,
                "RunAgentInput.state" to input.state,
                "RunAgentInput.forwardedProps" to input.forwardedProps,
                "Interrupt.metadata" to interrupt.metadata,
                "Interrupt.responseSchema" to interrupt.responseSchema,
                "AgentCapabilities.tools.items.parameters" to tool.parameters,
                "AgentCapabilities.tools.items.metadata" to tool.metadata,
                "AgentCapabilities.custom" to capabilities.custom,
                "ContentPart.metadata" to part.metadata,
                "CustomEvent.value" to custom.value,
            )
            for ((route, actual) in carriers) assertEquals(value, actual, "$route: $value")
        }
    }

    @Test
    fun strictDecoderKeepsOpaqueMetadataRootObjectShaped() {
        for (value in listOf("null", "[]", "\"metadata\"", "42", "true")) {
            assertFails("Metadata: $value") {
                AgUiV1.decode(JsonObject.serializer(), "Metadata", AgUiJson.parseToJsonElement(value))
            }
        }
    }

    @Test
    fun strictDecoderRejectsEnvelopeNullsAroundOpaqueState() {
        for (key in listOf("timestamp", "metadata", "rawEvent", "subagentRunId")) {
            val event = AgUiJson.parseToJsonElement(
                """{"type":"STATE_SNAPSHOT","snapshot":{"timestamp":"application clock","answer":null},"$key":null}""",
            )
            assertFails("event.$key") { AgUiV1.decodeEvent(event) }
            assertFails("StateSnapshotEvent.$key") {
                AgUiV1.decode(StateSnapshotEvent.serializer(), "StateSnapshotEvent", event)
            }
        }
    }

    @Test
    fun strictDecoderRejectsEnvelopeTimestampsAroundOpaqueState() {
        for (timestamp in listOf("\"application clock\"", "1.5", "9007199254740992", "-9007199254740992")) {
            val event = AgUiJson.parseToJsonElement(
                """{"type":"STATE_SNAPSHOT","snapshot":{"timestamp":"application clock","answer":null},"timestamp":$timestamp}""",
            )
            assertFails("event.timestamp: $timestamp") { AgUiV1.decodeEvent(event) }
            assertFails("StateSnapshotEvent.timestamp: $timestamp") {
                AgUiV1.decode(StateSnapshotEvent.serializer(), "StateSnapshotEvent", event)
            }
        }
    }

    @Test
    fun strictDecoderRetainsUnknownTargetValidation() {
        for (target in listOf("UnknownOpaqueTarget", "state", "metadata")) {
            for (value in listOf("""{"answer":null}""", """{"timestamp":"application clock"}""")) {
                assertFails("$target: $value") {
                    AgUiV1.decode(JsonElement.serializer(), target, AgUiJson.parseToJsonElement(value))
                }
            }
            val value = AgUiJson.parseToJsonElement("""{"application":{"answer":null}}""")
            assertEquals(value, AgUiV1.decode(JsonElement.serializer(), target, value), target)
        }
    }

    private val opaqueObjectContractFixtures = listOf(
        """{}""",
        """{"answer":null,"nested":{"required":null},"items":[null,{"value":null}]}""",
        """{"timestamp":"application clock"}""",
        """{"timestamp":null}""",
        """{"timestamp":{"seconds":null}}""",
        """{"timestamp":1.5}""",
        """{"timestamp":9007199254740992}""",
        """{"type":"RUN_FINISHED","role":null,"usage":[{"inputTokens":1e3,"totalTokens":null}],"outcome":{"type":"success","pendingToolCallIds":null},"tools":{"items":[{"parameters":null}]},"source":null}""",
    ).map { AgUiJson.parseToJsonElement(it) }

    private fun assertContentPartRejectedAtEachBoundary(input: String) {
        val part = AgUiJson.parseToJsonElement(input)
        val user = jsonFixture("""{"id":"m","role":"user","content":[$part]}""")
        val tool = jsonFixture("""{"id":"m","role":"tool","toolCallId":"c","content":[$part]}""")
        val result = AgUiJson.parseToJsonElement(
            """{"type":"TOOL_CALL_RESULT","messageId":"m","toolCallId":"c","content":[$part]}""",
        )

        val accepted = mutableListOf<String>()
        for ((role, message) in listOf("user" to user, "tool" to tool)) {
            for (route in messageRoutes()) {
                if (runCatching { route.decode(message) }.isSuccess) accepted += "$role via ${route.name}"
            }
        }
        assertEquals(emptyList(), accepted, "Content part must be rejected by every message route: $input")
        assertFails("content part in tool result: $input") { AgUiV1.decodeEvent(result) }
        assertFails("root content part: $input") { AgUiV1.decode(ContentPart.serializer(), "ContentPart", part) }
    }

    private fun assertContentPartDecodedAtEachBoundary(input: String, expected: ContentPart) {
        val part = AgUiJson.parseToJsonElement(input)
        val user = jsonFixture("""{"id":"m","role":"user","content":[$part]}""")
        val tool = jsonFixture("""{"id":"m","role":"tool","toolCallId":"c","content":[$part]}""")
        val result = AgUiJson.parseToJsonElement(
            """{"type":"TOOL_CALL_RESULT","messageId":"m","toolCallId":"c","content":[$part]}""",
        )

        assertEquals(expected, AgUiV1.decode(ContentPart.serializer(), "ContentPart", part), "root content part: $input")
        for (route in messageRoutes()) {
            assertEquals(listOf(expected), assertIs<UserMessage>(route.decode(user)).contentParts, "user via ${route.name}: $input")
            assertEquals(listOf(expected), assertIs<ToolMessage>(route.decode(tool)).contentParts, "tool via ${route.name}: $input")
        }
        assertEquals(listOf(expected), assertIs<ToolCallResultEvent>(AgUiV1.decodeEvent(result)).contentParts, "tool result: $input")
    }

    private fun assertInterruptNullRejected(key: String) {
        val interrupt = AgUiJson.parseToJsonElement("""{"id":"i","reason":"tool_call","$key":null}""")
        val outcome = AgUiJson.parseToJsonElement("""{"type":"interrupt","interrupts":[$interrupt]}""")
        val event = AgUiJson.parseToJsonElement(
            """{"type":"RUN_FINISHED","threadId":"t","runId":"r","outcome":$outcome}""",
        )

        assertFails("root interrupt.$key") { AgUiV1.decode(Interrupt.serializer(), "Interrupt", interrupt) }
        assertFails("interrupt.$key in event") { AgUiV1.decodeEvent(event) }
        for (target in runFinishedOutcomeTargets) {
            assertFails("interrupt.$key in $target") {
                AgUiV1.decode(RunFinishedOutcome.serializer(), target, outcome)
            }
        }
        assertFails("interrupt.$key in concrete event") {
            AgUiV1.validate("RunFinishedEvent", event)
        }
    }

    private fun assertInterruptDecodedAtEachBoundary(input: String, expected: Interrupt) {
        val interrupt = AgUiJson.parseToJsonElement(input)
        val outcome = AgUiJson.parseToJsonElement("""{"type":"interrupt","interrupts":[$interrupt]}""")
        val event = AgUiJson.parseToJsonElement(
            """{"type":"RUN_FINISHED","threadId":"t","runId":"r","outcome":$outcome}""",
        )

        assertEquals(expected, AgUiV1.decode(Interrupt.serializer(), "Interrupt", interrupt))
        for (target in runFinishedOutcomeTargets) {
            assertEquals(
                RunFinishedInterruptOutcome(listOf(expected)),
                AgUiV1.decode(RunFinishedOutcome.serializer(), target, outcome),
                target,
            )
        }
        assertEquals(
            RunFinishedInterruptOutcome(listOf(expected)),
            assertIs<RunFinishedEvent>(AgUiV1.decodeEvent(event)).outcome,
        )
        AgUiV1.validate("RunFinishedEvent", event)
    }
}
