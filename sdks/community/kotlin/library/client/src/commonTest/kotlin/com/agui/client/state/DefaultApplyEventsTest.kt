@file:Suppress("DEPRECATION")

package com.agui.client.state

import com.agui.client.agent.AbstractAgent
import com.agui.client.agent.AgentEventParams
import com.agui.client.agent.AgentStateMutation
import com.agui.client.agent.AgentSubscriber
import com.agui.client.chunks.transformChunks
import com.agui.core.types.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFails
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertFalse
import kotlin.test.assertSame
import kotlin.test.assertTrue

class DefaultApplyEventsTest {
    private fun baseInput(): RunAgentInput = RunAgentInput(
        threadId = "thread",
        runId = "run"
    )

    private fun dummyAgent(): AbstractAgent = object : AbstractAgent() {
        override fun run(input: RunAgentInput): Flow<BaseEvent> = flowOf()
    }

    @Test
    fun surfacesRawEvents() = runTest {
        val input = baseInput()
        val rawEvent = RawEvent(
            event = buildJsonObject { put("type", "diagnostic") },
            source = "test-source"
        )

        val states = defaultApplyEvents(input, flowOf(rawEvent)).toList()

        assertEquals(1, states.size)
        val state = states.first()
        assertNotNull(state.rawEvents)
        assertEquals(listOf(rawEvent), state.rawEvents)
    }

    @Test
    fun surfacesCustomEvents() = runTest {
        val input = baseInput()
        val customEvent = CustomEvent(
            name = "ProgressUpdate",
            value = buildJsonObject { put("percent", 50) }
        )

        val states = defaultApplyEvents(input, flowOf(customEvent)).toList()

        assertEquals(1, states.size)
        val state = states.first()
        assertNotNull(state.customEvents)
        assertEquals(listOf(customEvent), state.customEvents)
    }

    @Test
    fun accumulatesMultipleCustomEvents() = runTest {
        val input = baseInput()
        val customEvents = listOf(
            CustomEvent(
                name = "ProgressUpdate",
                value = buildJsonObject { put("percent", 10) }
            ),
            CustomEvent(
                name = "ProgressUpdate",
                value = buildJsonObject { put("percent", 80) }
            )
        )

        val states = defaultApplyEvents(input, flowOf(*customEvents.toTypedArray())).toList()

        assertEquals(customEvents.size, states.size)
        val latestState = states.last()
        assertEquals(customEvents, latestState.customEvents)
    }

    @Test
    fun accumulatesMultipleRawEvents() = runTest {
        val input = baseInput()
        val rawEvents = listOf(
            RawEvent(event = buildJsonObject { put("type", "diagnostic") }),
            RawEvent(event = buildJsonObject { put("type", "metric") }, source = "collector")
        )

        val states = defaultApplyEvents(input, flowOf(*rawEvents.toTypedArray())).toList()

        assertEquals(rawEvents.size, states.size)
        val latestState = states.last()
        assertEquals(rawEvents, latestState.rawEvents)
    }

    @Test
    fun transformsTextMessageChunksIntoAssistantMessage() = runTest {
        val input = baseInput()
        val events = flowOf<BaseEvent>(
            TextMessageChunkEvent(messageId = "msg1", delta = "Hello "),
            TextMessageChunkEvent(delta = "world!")
        )

        val states = defaultApplyEvents(input, events.transformChunks()).toList()

        val latestMessages = states.last().messages
        assertNotNull(latestMessages)
        val assistantMessage = latestMessages.last() as AssistantMessage
        assertEquals("Hello world!", assistantMessage.content)
    }

    @Test
    fun respectsNonAssistantRolesForTextMessages() = runTest {
        val input = baseInput()
        val events = flowOf<BaseEvent>(
            TextMessageStartEvent(messageId = "dev1", role = Role.DEVELOPER),
            TextMessageContentEvent(messageId = "dev1", delta = "Configure"),
            TextMessageContentEvent(messageId = "dev1", delta = " agent")
        )

        val states = defaultApplyEvents(input, events).toList()

        val latestMessages = states.last().messages
        assertNotNull(latestMessages)
        val developerMessage = latestMessages.last() as DeveloperMessage
        assertEquals("Configure agent", developerMessage.content)
    }

    @Test
    fun subscriberCanStopPropagationBeforeMutation() = runTest {
        val input = baseInput()
        val agent = dummyAgent()
        val subscriber = object : AgentSubscriber {
            override suspend fun onEvent(params: AgentEventParams): AgentStateMutation? {
                return AgentStateMutation(
                    messages = params.messages + UserMessage(id = "u1", content = "hi"),
                    stopPropagation = true
                )
            }
        }

        val states = defaultApplyEvents(
            input,
            flowOf<BaseEvent>(TextMessageStartEvent(messageId = "msg1")),
            agent = agent,
            subscribers = listOf(subscriber)
        ).toList()

        assertEquals(1, states.size)
        val messages = states.first().messages
        assertNotNull(messages)
        val userMessage = messages.first() as UserMessage
        assertEquals("hi", userMessage.content)
    }

    @Test
    fun appendsToolCallResultAsToolMessage() = runTest {
        val input = baseInput()
        val events = flowOf<BaseEvent>(
            ToolCallStartEvent(toolCallId = "call1", toolCallName = "lookup"),
            ToolCallArgsEvent(toolCallId = "call1", delta = "{\"arg\":\"value\"}"),
            ToolCallEndEvent(toolCallId = "call1"),
            ToolCallResultEvent(messageId = "tool_msg", toolCallId = "call1", content = "done")
        )

        val states = defaultApplyEvents(input, events).toList()
        val messages = states.last().messages
        assertNotNull(messages)
        val toolMessages = messages.filterIsInstance<ToolMessage>()
        assertEquals(1, toolMessages.size)
        val toolMessage = toolMessages.first()
        assertEquals("done", toolMessage.content)
       assertEquals("call1", toolMessage.toolCallId)
       assertTrue(messages.any { it is AssistantMessage })
   }

    @Test
    fun appendsMultimodalToolCallResultAsIdenticalToolMessage() = runTest {
        val input = baseInput()
        val metadata = buildJsonObject { put("title", "Invoice") }
        val parts = listOf<ContentPart>(
            TextPart(text = "Invoice INV-2291 attached."),
            ImagePart(source = UrlSource(value = "https://example.test/invoice.png", mimeType = "image/png"))
        )
        val result = ToolCallResultEvent.multimodal(
            messageId = "tool_msg",
            toolCallId = "call1",
            parts = parts,
            metadata = metadata,
            subagentRunId = "sub-1"
        )
        val encodedEvent = AgUiJson.encodeToJsonElement(BaseEvent.serializer(), result)
        val events = flowOf(AgUiV1.decodeEvent(encodedEvent))

        val states = defaultApplyEvents(input, events).toList()
        val messages = states.last().messages
        assertNotNull(messages)
        val toolMessage = messages.single() as ToolMessage
        assertEquals("tool_msg", toolMessage.id)
        assertEquals("", toolMessage.content)
        assertEquals(parts, toolMessage.contentParts)
        assertEquals(metadata, toolMessage.metadata)
        assertEquals("sub-1", toolMessage.subagentRunId)
        assertEquals("call1", toolMessage.toolCallId)

        val nextInput = input.copy(runId = "next-run", messages = messages)
        val encoded = AgUiJson.encodeToJsonElement(RunAgentInput.serializer(), nextInput).jsonObject
        val encodedResult = encoded.getValue("messages").jsonArray.single().jsonObject
        assertEquals(JsonPrimitive("tool"), encodedResult["role"])
        assertEquals(JsonPrimitive("tool_msg"), encodedResult["id"])
        assertEquals(JsonPrimitive("call1"), encodedResult["toolCallId"])
        assertEquals(
            AgUiJson.parseToJsonElement(
                """[{"type":"text","text":"Invoice INV-2291 attached."},{"type":"image","source":{"type":"url","value":"https://example.test/invoice.png","mimeType":"image/png"}}]"""
            ),
            encodedResult["content"]
        )
        assertEquals(metadata, encodedResult["metadata"])
        assertEquals(JsonPrimitive("sub-1"), encodedResult["subagentRunId"])
    }

    @Test
    fun appendsTextToolCallResultWithMetadataAndAttributionAsString() = runTest {
        val input = baseInput()
        val metadata = buildJsonObject { put("source", "lookup") }
        val events = flowOf<BaseEvent>(
            ToolCallResultEvent(
                messageId = "text_tool_msg",
                toolCallId = "text_call",
                content = "done",
                metadata = metadata,
                subagentRunId = "text-sub-1"
            )
        )

        val states = defaultApplyEvents(input, events).toList()
        val messages = states.last().messages
        assertNotNull(messages)
        val toolMessage = messages.single() as ToolMessage
        assertEquals("text_tool_msg", toolMessage.id)
        assertEquals("text_call", toolMessage.toolCallId)
        assertEquals("done", toolMessage.content)
        assertNull(toolMessage.contentParts)
        assertEquals(metadata, toolMessage.metadata)
        assertEquals("text-sub-1", toolMessage.subagentRunId)

        val nextInput = input.copy(runId = "next-run", messages = messages)
        val encoded = AgUiJson.encodeToJsonElement(RunAgentInput.serializer(), nextInput).jsonObject
        val encodedResult = encoded.getValue("messages").jsonArray.single().jsonObject
        assertEquals(JsonPrimitive("tool"), encodedResult["role"])
        assertEquals(JsonPrimitive("text_tool_msg"), encodedResult["id"])
        assertEquals(JsonPrimitive("text_call"), encodedResult["toolCallId"])
        assertEquals(JsonPrimitive("done"), encodedResult["content"])
        assertEquals(metadata, encodedResult["metadata"])
        assertEquals(JsonPrimitive("text-sub-1"), encodedResult["subagentRunId"])
    }

    @Test
    fun stateDeltaThatCannotApplyIsReportedAndSkipped() = runTest {
        val input = baseInput().copy(
            state = buildJsonObject { put("items", buildJsonArray { }) }
        )
        val delta = buildJsonArray {
            add(buildJsonObject {
                put("op", "replace")
                put("path", "/items/0/title")
                put("value", "New title")
            })
        }
        val reportedDeltas = mutableListOf<JsonArray?>()
        val appliedDeltas = mutableListOf<JsonArray>()
        val events = flowOf<BaseEvent>(
            StateDeltaEvent(delta = delta),
            TextMessageStartEvent(messageId = "msg-after-delta"),
            TextMessageContentEvent(messageId = "msg-after-delta", delta = "continued")
        )

        val states = defaultApplyEvents(
            input,
            events,
            stateHandler = stateHandler(
                onDelta = { appliedDeltas.add(it) },
                onError = { _, failedDelta -> reportedDeltas.add(failedDelta) }
            )
        ).toList()

        assertEquals<List<JsonArray?>>(listOf(delta), reportedDeltas)
        assertTrue(appliedDeltas.isEmpty())
        assertTrue(states.all { it.state == null })
        val messages = states.last().messages
        assertNotNull(messages)
        val message = messages.single() as AssistantMessage
        assertEquals("continued", message.content)
    }

    @Test
    fun decodedStateDeltaValuesPreserveOpaqueNumbers() = runTest {
        val values = listOf(
            "42",
            "1e309",
            "-1e309",
            "1e-400",
            "-1e-400",
            """{"nested":[1e309,-1e309,1e-400]}"""
        )

        values.forEach { value ->
            assertDecodedStateDeltaSucceeds(
                "{}",
                """{"type":"STATE_DELTA","delta":[{"op":"add","path":"/value","value":$value}]}""",
                """{"value":$value}"""
            )
        }
    }

    @Test
    fun decodedRootTestsPreserveMatchingNumericDocuments() = runTest {
        val equivalentValues = listOf(
            "1e309" to "10e308",
            "-1e309" to "-10e308",
            "1e-400" to "10e-401",
            """{"nested":[1e309,-1e309,1e-400]}""" to
                """{"nested":[10e308,-10e308,10e-401]}"""
        )

        equivalentValues.forEach { (source, expected) ->
            assertDecodedStateDeltaSucceeds(
                source,
                """{"type":"STATE_DELTA","delta":[{"op":"test","path":"","value":$expected}]}""",
                source
            )
        }
    }

    @Test
    fun decodedRootTestMismatchesPreserveStateAndContinue() = runTest {
        val cases = listOf(
            "1e309" to """[{"op":"test","path":"","value":2e309}]""",
            """{"count":0,"large":1e309}""" to """[
                {"op":"replace","path":"/count","value":1},
                {"op":"test","path":"","value":{"count":1,"large":2e309}}
            ]"""
        )

        cases.forEach { (source, patch) ->
            val initialState = AgUiJson.parseToJsonElement(source)
            val failingEvent = AgUiV1.decodeEvent(AgUiJson.parseToJsonElement(
                """{"type":"STATE_DELTA","delta":$patch}"""
            )) as StateDeltaEvent
            val observeEvent = AgUiV1.decodeEvent(AgUiJson.parseToJsonElement(
                """{"type":"STATE_DELTA","delta":[]}"""
            )) as StateDeltaEvent
            val laterEvent = AgUiV1.decodeEvent(AgUiJson.parseToJsonElement(
                """{"type":"STATE_DELTA","delta":[{"op":"replace","path":"","value":{"recovered":true}}]}"""
            )) as StateDeltaEvent
            val reportedDeltas = mutableListOf<JsonArray?>()
            val appliedDeltas = mutableListOf<JsonArray>()

            val states = defaultApplyEvents(
                baseInput().copy(state = initialState),
                flowOf<BaseEvent>(
                    failingEvent,
                    observeEvent,
                    laterEvent,
                    TextMessageStartEvent(messageId = "after-decoded-mismatch"),
                    TextMessageContentEvent(messageId = "after-decoded-mismatch", delta = "continued")
                ),
                stateHandler = stateHandler(
                    onDelta = { appliedDeltas.add(it) },
                    onError = { _, delta -> reportedDeltas.add(delta) }
                )
            ).toList()

            assertEquals<List<JsonArray?>>(listOf(failingEvent.delta), reportedDeltas, patch)
            assertSame(failingEvent.delta.first(), reportedDeltas.single()?.first(), patch)
            assertEquals(listOf(observeEvent.delta, laterEvent.delta), appliedDeltas, patch)
            assertEquals(
                listOf(initialState, AgUiJson.parseToJsonElement("""{"recovered":true}""")),
                states.mapNotNull { it.state },
                patch
            )
            assertEquals(initialState.toString(), states.first().state.toString(), patch)
            assertEquals(AgUiJson.parseToJsonElement(source), initialState, patch)
            val messages = assertNotNull(states.last().messages)
            assertEquals("continued", (messages.single() as AssistantMessage).content, patch)
        }
    }

    @Test
    fun decodedRootRemovalThenChildReplacementPreservesState() = runTest {
        assertStateDeltaFailurePreservesState(
            "root removal then child replacement",
            AgUiJson.parseToJsonElement("""{"keep":1}"""),
            AgUiJson.parseToJsonElement("""[
                {"op":"remove","path":""},
                {"op":"replace","path":"/keep","value":2}
            ]""").jsonArray
        )
    }

    @Test
    fun decodedRootRemovalFailurePreservesEmptyNameMember() = runTest {
        assertStateDeltaFailurePreservesState(
            "root removal preserves the entire document including its empty-name member",
            AgUiJson.parseToJsonElement("""{"":{"nested":true},"keep":1,"untouched":[null,1e309]}"""),
            AgUiJson.parseToJsonElement("""[
                {"op":"remove","path":""},
                {"op":"replace","path":"/keep","value":2}
            ]""").jsonArray
        )
    }

    @Test
    fun decodedRootRemovalFailureAfterSuccessfulPrefixPreservesState() = runTest {
        assertStateDeltaFailurePreservesState(
            "successful prefix before root removal is rolled back",
            AgUiJson.parseToJsonElement("""{"":{"nested":true},"keep":1,"untouched":[null,1e309]}"""),
            AgUiJson.parseToJsonElement("""[
                {"op":"replace","path":"/keep","value":9},
                {"op":"remove","path":""},
                {"op":"replace","path":"/keep","value":2}
            ]""").jsonArray
        )
    }

    @Test
    fun decodedRootRemovalRejectsOperationsRequiringADocumentBeforeRestoration() = runTest {
        val operations = listOf(
            """{"op":"remove","path":""}""",
            """{"op":"test","path":"","value":{"keep":1}}""",
            """{"op":"replace","path":"","value":null}""",
            """{"op":"add","path":"/created","value":1}""",
            """{"op":"copy","from":"/keep","path":""}""",
            """{"op":"move","from":"/keep","path":""}"""
        )

        operations.forEach { operation ->
            assertStateDeltaFailurePreservesState(
                "removed document is unavailable to $operation even before a later root addition",
                AgUiJson.parseToJsonElement("""{"keep":1}"""),
                AgUiJson.parseToJsonElement("""[
                    {"op":"remove","path":""},
                    $operation,
                    {"op":"add","path":"","value":{"restored":true}}
                ]""").jsonArray
            )
        }
    }

    @Test
    fun decodedRootRemovalWithoutRestorationPreservesState() = runTest {
        assertStateDeltaFailurePreservesState(
            "a delta cannot publish an absent document",
            AgUiJson.parseToJsonElement("""{"keep":1}"""),
            AgUiJson.parseToJsonElement("""[{"op":"remove","path":""}]""").jsonArray
        )
    }

    @Test
    fun decodedRootRemovalCanRestoreJsonNullAndOpaqueValues() = runTest {
        val values = listOf("null", "1e309", "1e-400", """{"restored":[null,1e309,-1e309,1e-400]}""")

        values.forEach { value ->
            assertDecodedStateDeltaSucceeds(
                """{"":{"nested":true},"keep":1}""",
                """{"type":"STATE_DELTA","delta":[
                    {"op":"remove","path":""},
                    {"op":"add","path":"","value":$value},
                    {"op":"test","path":"","value":$value}
                ]}""",
                value
            )
        }

        assertDecodedStateDeltaSucceeds(
            "null",
            """{"type":"STATE_DELTA","delta":[
                {"op":"remove","path":""},
                {"op":"add","path":"","value":null},
                {"op":"test","path":"","value":null},
                {"op":"remove","path":""},
                {"op":"add","path":"","value":{"keep":1}},
                {"op":"replace","path":"/keep","value":2}
            ]}""",
            """{"keep":2}"""
        )
    }

    @Test
    fun decodedNonRootSourcesStillSupportRootDestinationsAndSamePointerMoves() = runTest {
        val cases = listOf(
            Triple("""{"child":{"value":1},"other":2}""",
                """[{"op":"copy","from":"/child","path":""}]""", """{"value":1}"""),
            Triple("""{"child":{"value":1},"other":2}""",
                """[{"op":"move","from":"/child","path":""}]""", """{"value":1}"""),
            Triple("""{"items":[1,2]}""",
                """[{"op":"copy","from":"/items/1","path":""}]""", "2"),
            Triple("""{"items":[1,2]}""",
                """[{"op":"move","from":"/items/1","path":""}]""", "2"),
            Triple("""{"child":{"value":1},"other":2}""",
                """[{"op":"move","from":"/child","path":"/child"}]""", """{"child":{"value":1},"other":2}"""),
            Triple("""{"items":[1,2]}""",
                """[{"op":"move","from":"/items/1","path":"/items/1"}]""", """{"items":[1,2]}""")
        )

        cases.forEach { (source, patch, expected) ->
            assertDecodedStateDeltaSucceeds(source, """{"type":"STATE_DELTA","delta":$patch}""", expected)
        }
    }

    @Test
    fun decodedStateDeltaEnvelopePreservesOpaqueNumbers() = runTest {
        val opaqueFields = listOf(
            """"metadata":{"values":[1e309,-1e309,1e-400],"timestamp":null}""",
            """"rawEvent":1e309""",
            """"rawEvent":{"values":[1e309,-1e309,1e-400]},"metadata":{"value":1e309}"""
        )

        opaqueFields.forEach { fields ->
            assertDecodedStateDeltaSucceeds(
                "{}",
                """{"type":"STATE_DELTA","delta":[{"op":"add","path":"/count","value":1}],
                    "timestamp":9007199254740991,"subagentRunId":"sub-1",$fields}""",
                """{"count":1}"""
            )
        }
    }

    private suspend fun assertDecodedStateDeltaSucceeds(source: String, eventJson: String, expected: String) {
        val event = AgUiV1.decodeEvent(AgUiJson.parseToJsonElement(eventJson)) as StateDeltaEvent
        val initialState = AgUiJson.parseToJsonElement(source)
        val appliedDeltas = mutableListOf<JsonArray>()
        var reportedError = false

        val states = defaultApplyEvents(
            baseInput().copy(state = initialState),
            flowOf<BaseEvent>(
                event,
                TextMessageStartEvent(messageId = "after-decoded-delta"),
                TextMessageContentEvent(messageId = "after-decoded-delta", delta = "continued")
            ),
            stateHandler = stateHandler(
                onDelta = { appliedDeltas.add(it) },
                onError = { _, _ -> reportedError = true }
            )
        ).toList()

        assertFalse(reportedError, eventJson)
        assertEquals(listOf(event.delta), appliedDeltas, eventJson)
        event.delta.forEachIndexed { index, operation ->
            assertSame(operation, appliedDeltas.single()[index], eventJson)
        }
        assertEquals(listOf(AgUiJson.parseToJsonElement(expected)), states.mapNotNull { it.state }, eventJson)
        assertEquals(AgUiJson.parseToJsonElement(source), initialState, eventJson)
        val messages = assertNotNull(states.last().messages)
        assertEquals("continued", (messages.single() as AssistantMessage).content, eventJson)
    }

    @Test
    fun stateDeltaValidationRetainsEnvelopeChecks() = runTest {
        val delta = AgUiJson.parseToJsonElement("""[{"op":"add","path":"/count","value":1}]""").jsonArray
        val invalidEvents = listOf(
            StateDeltaEvent(delta = delta, timestamp = 9007199254740992L),
            StateDeltaEvent(delta = delta, timestamp = -9007199254740992L),
            StateDeltaEvent(delta = delta, rawEvent = JsonNull)
        )

        invalidEvents.forEach { event ->
            var appliedDelta = false
            var reportedError = false

            assertFails("Expected invalid envelope to be fatal: $event") {
                defaultApplyEvents(
                    baseInput().copy(state = buildJsonObject { }),
                    flowOf<BaseEvent>(event),
                    stateHandler = stateHandler(
                        onDelta = { appliedDelta = true },
                        onError = { _, _ -> reportedError = true }
                    )
                ).toList()
            }

            assertFalse(appliedDelta)
            assertFalse(reportedError)
        }
    }

    @Test
    fun unknownStateDeltaOperationIsSkippedWhileKnownOperationAndTextContinue() = runTest {
        val input = baseInput().copy(state = buildJsonObject { put("count", 0) })
        val knownOperation = buildJsonObject {
            put("op", "replace")
            put("path", "/count")
            put("value", 1)
        }
        val delta = buildJsonArray {
            add(buildJsonObject { put("op", "futureOperation") })
            add(knownOperation)
        }
        val appliedDeltas = mutableListOf<JsonArray>()
        var reportedError = false

        val states = defaultApplyEvents(
            input,
            flowOf<BaseEvent>(
                StateDeltaEvent(delta = delta),
                TextMessageStartEvent(messageId = "after-unknown"),
                TextMessageContentEvent(messageId = "after-unknown", delta = "continued")
            ),
            stateHandler = stateHandler(
                onDelta = { appliedDeltas.add(it) },
                onError = { _, _ -> reportedError = true }
            )
        ).toList()

        assertEquals(listOf(JsonArray(listOf(knownOperation))), appliedDeltas)
        assertEquals(listOf(buildJsonObject { put("count", 1) }), states.mapNotNull { it.state })
        assertFalse(reportedError)
        val messages = assertNotNull(states.last().messages)
        assertEquals("continued", (messages.single() as AssistantMessage).content)
    }

    @Test
    fun allUnknownStateDeltaOperationsPreserveStateAndAllowLaterText() = runTest {
        val input = baseInput().copy(state = buildJsonObject { put("count", 0) })
        val delta = buildJsonArray {
            add(buildJsonObject { put("op", "futureOperation") })
            add(buildJsonObject { put("op", "anotherFutureOperation") })
        }
        val appliedDeltas = mutableListOf<JsonArray>()
        var reportedError = false

        val states = defaultApplyEvents(
            input,
            flowOf<BaseEvent>(
                StateDeltaEvent(delta = delta),
                TextMessageStartEvent(messageId = "after-unknown"),
                TextMessageContentEvent(messageId = "after-unknown", delta = "continued")
            ),
            stateHandler = stateHandler(
                onDelta = { appliedDeltas.add(it) },
                onError = { _, _ -> reportedError = true }
            )
        ).toList()

        assertEquals(listOf(JsonArray(emptyList())), appliedDeltas)
        assertEquals(listOf(input.state), states.mapNotNull { it.state })
        assertFalse(reportedError)
        val messages = assertNotNull(states.last().messages)
        assertEquals("continued", (messages.single() as AssistantMessage).content)
    }

    @Test
    fun failedKnownOperationsAfterUnknownOperationRemainAtomicAndReportEffectiveDelta() = runTest {
        val input = baseInput().copy(state = buildJsonObject { put("count", 0) })
        val knownDelta = buildJsonArray {
            add(buildJsonObject {
                put("op", "replace")
                put("path", "/count")
                put("value", 1)
            })
            add(buildJsonObject {
                put("op", "test")
                put("path", "/count")
                put("value", 2)
            })
        }
        val delta = buildJsonArray {
            add(buildJsonObject { put("op", "futureOperation") })
            knownDelta.forEach { add(it) }
        }
        val laterDelta = buildJsonArray {
            add(buildJsonObject {
                put("op", "test")
                put("path", "/count")
                put("value", 0)
            })
            add(buildJsonObject {
                put("op", "replace")
                put("path", "/count")
                put("value", 3)
            })
        }
        val reportedDeltas = mutableListOf<JsonArray?>()
        val appliedDeltas = mutableListOf<JsonArray>()

        val states = defaultApplyEvents(
            input,
            flowOf<BaseEvent>(
                StateDeltaEvent(delta = delta),
                StateDeltaEvent(delta = laterDelta)
            ),
            stateHandler = stateHandler(
                onDelta = { appliedDeltas.add(it) },
                onError = { _, failedDelta -> reportedDeltas.add(failedDelta) }
            )
        ).toList()

        assertEquals<List<JsonArray?>>(listOf(knownDelta), reportedDeltas)
        assertEquals(listOf(laterDelta), appliedDeltas)
        assertEquals(buildJsonObject { put("count", 3) }, states.single().state)
    }

    @Test
    fun malformedStateDeltaOperationDiscriminatorsAreFatal() = runTest {
        val malformedOperations = listOf(
            JsonNull,
            JsonPrimitive("replace"),
            buildJsonArray { },
            buildJsonObject { },
            buildJsonObject { put("op", JsonNull) },
            buildJsonObject { put("op", 42) },
            buildJsonObject { put("op", true) },
            buildJsonObject { put("op", buildJsonObject { }) },
            buildJsonObject { put("op", buildJsonArray { }) }
        )

        malformedOperations.forEach { malformedOperation ->
            var reportedError = false
            var appliedDelta = false

            assertFails("Expected malformed operation to be fatal: $malformedOperation") {
                defaultApplyEvents(
                    baseInput(),
                    flowOf<BaseEvent>(StateDeltaEvent(delta = buildJsonArray {
                        add(buildJsonObject { put("op", "futureOperation") })
                        add(malformedOperation)
                    })),
                    stateHandler = stateHandler(
                        onDelta = { appliedDelta = true },
                        onError = { _, _ -> reportedError = true }
                    )
                ).toList()
            }

            assertFalse(appliedDelta)
            assertFalse(reportedError)
        }
    }

    @Test
    fun malformedKnownStateDeltaOperationAfterUnknownOperationIsFatal() = runTest {
        val delta = buildJsonArray {
            add(buildJsonObject { put("op", "futureOperation") })
            add(buildJsonObject {
                put("op", "replace")
                put("path", "/count")
            })
        }
        var appliedDelta = false
        var reportedError = false

        assertFailsWith<IllegalArgumentException> {
            defaultApplyEvents(
                baseInput().copy(state = buildJsonObject { put("count", 0) }),
                flowOf<BaseEvent>(StateDeltaEvent(delta = delta)),
                stateHandler = stateHandler(
                    onDelta = { appliedDelta = true },
                    onError = { _, _ -> reportedError = true }
                )
            ).toList()
        }

        assertFalse(appliedDelta)
        assertFalse(reportedError)
    }

    @Test
    fun strictV1DecodingStillRejectsUnknownStateDeltaOperation() {
        val event = buildJsonObject {
            put("type", "STATE_DELTA")
            put("delta", buildJsonArray {
                add(buildJsonObject {
                    put("op", "futureOperation")
                    put("path", "/count")
                    put("value", 1)
                })
            })
        }

        assertFailsWith<IllegalArgumentException> {
            AgUiV1.decodeEvent(event)
        }
    }

    @Test
    fun malformedStateDeltaMissingOpIsFatal() = runTest {
        val malformedDelta = buildJsonArray {
            add(buildJsonObject {
                put("path", "/items/0/title")
                put("value", "New title")
            })
        }
        var reportedError = false

        assertFails {
            defaultApplyEvents(
                baseInput(),
                flowOf<BaseEvent>(StateDeltaEvent(delta = malformedDelta)),
                stateHandler = stateHandler(onError = { _, _ -> reportedError = true })
            ).toList()
        }

        assertFalse(reportedError)
    }

    @Test
    fun malformedStateDeltaPointerIsFatal() = runTest {
        val malformedDelta = buildJsonArray {
            add(buildJsonObject {
                put("op", "replace")
                put("path", "items/0/title")
                put("value", "New title")
            })
        }
        var reportedError = false

        assertFails {
            defaultApplyEvents(
                baseInput(),
                flowOf<BaseEvent>(StateDeltaEvent(delta = malformedDelta)),
                stateHandler = stateHandler(onError = { _, _ -> reportedError = true })
            ).toList()
        }

        assertFalse(reportedError)
    }

    @Test
    fun failedStateDeltaPreservesPriorStateAfterEarlierOperationSucceeds() = runTest {
        val input = baseInput().copy(state = buildJsonObject {
            put("count", 0)
            put("items", buildJsonArray { })
        })
        val failingDelta = buildJsonArray {
            add(buildJsonObject {
                put("op", "replace")
                put("path", "/count")
                put("value", 1)
            })
            add(buildJsonObject {
                put("op", "replace")
                put("path", "/items/0/title")
                put("value", "New title")
            })
        }
        val validDelta = buildJsonArray {
            add(buildJsonObject {
                put("op", "test")
                put("path", "/count")
                put("value", 0)
            })
            add(buildJsonObject {
                put("op", "replace")
                put("path", "/count")
                put("value", 2)
            })
        }
        val reportedDeltas = mutableListOf<JsonArray?>()
        val appliedDeltas = mutableListOf<JsonArray>()

        val states = defaultApplyEvents(
            input,
            flowOf<BaseEvent>(
                StateDeltaEvent(delta = failingDelta),
                StateDeltaEvent(delta = validDelta),
                TextMessageStartEvent(messageId = "after-recovery"),
                TextMessageContentEvent(messageId = "after-recovery", delta = "continued")
            ),
            stateHandler = stateHandler(
                onDelta = { appliedDeltas.add(it) },
                onError = { _, delta -> reportedDeltas.add(delta) }
            )
        ).toList()

        assertEquals<List<JsonArray?>>(listOf(failingDelta), reportedDeltas)
        assertEquals(listOf(validDelta), appliedDeltas)
        assertEquals(
            listOf(buildJsonObject {
                put("count", 2)
                put("items", buildJsonArray { })
            }),
            states.mapNotNull { it.state }
        )
        val messages = assertNotNull(states.last().messages)
        assertEquals("continued", (messages.single() as AssistantMessage).content)
    }

    @Test
    fun stateDeltaFailureCasesPreserveTheWholeDocumentAndContinue() = runTest {
        val initialState = AgUiJson.parseToJsonElement(
            """{"count":0,"items":[{"title":"Original"}],"untouched":true}"""
        )
        val replaceCount = AgUiJson.parseToJsonElement(
            """{"op":"replace","path":"/count","value":1}"""
        )
        val failures = listOf(
            "root test mismatch" to buildJsonArray {
                add(buildJsonObject {
                    put("op", "test")
                    put("path", "")
                    put("value", buildJsonObject { put("count", 99) })
                })
            },
            "root test mismatch after replacement" to buildJsonArray {
                add(replaceCount)
                add(buildJsonObject {
                    put("op", "test")
                    put("path", "")
                    put("value", initialState)
                })
            }
        )

        failures.forEach { (label, delta) ->
            assertStateDeltaFailurePreservesState(label, initialState, delta)
        }
    }

    @Test
    fun missingIntermediateObjectReplacePreservesState() = runTest {
        assertMissingObjectReplacePreservesState("/missing/title", afterSuccessfulOperation = false)
    }

    @Test
    fun missingIntermediateObjectReplaceAfterSuccessfulOperationPreservesState() = runTest {
        assertMissingObjectReplacePreservesState("/missing/title", afterSuccessfulOperation = true)
    }

    @Test
    fun missingFinalObjectReplacePreservesState() = runTest {
        assertMissingObjectReplacePreservesState("/missing", afterSuccessfulOperation = false)
    }

    @Test
    fun missingFinalObjectReplaceAfterSuccessfulOperationPreservesState() = runTest {
        assertMissingObjectReplacePreservesState("/missing", afterSuccessfulOperation = true)
    }

    private suspend fun assertMissingObjectReplacePreservesState(path: String, afterSuccessfulOperation: Boolean) {
        val initialState = AgUiJson.parseToJsonElement(
            """{"count":0,"items":[{"title":"Original"}],"untouched":true}"""
        )
        val delta = buildJsonArray {
            if (afterSuccessfulOperation) {
                add(AgUiJson.parseToJsonElement("""{"op":"replace","path":"/count","value":1}"""))
            }
            add(buildJsonObject {
                put("op", "replace")
                put("path", path)
                put("value", "New title")
            })
        }

        assertStateDeltaFailurePreservesState("$path afterSuccessfulOperation=$afterSuccessfulOperation", initialState, delta)
    }

    @Test
    fun relatedOperationsRejectMissingObjectTargetsAndSources() = runTest {
        val initialState = AgUiJson.parseToJsonElement(
            """{"count":0,"nullable":null,"items":[{"title":"Original"}],"untouched":true}"""
        )
        val operations = listOf(
            """{"op":"remove","path":"/missing"}""",
            """{"op":"remove","path":"/missing/title"}""",
            """{"op":"test","path":"/missing/title","value":null}""",
            """{"op":"add","path":"/missing/title","value":null}""",
            """{"op":"copy","from":"/nullable","path":"/missing/title"}""",
            """{"op":"move","from":"/nullable","path":"/missing/title"}""",
            """{"op":"copy","from":"/missing","path":"/copied"}""",
            """{"op":"move","from":"/missing","path":"/moved"}""",
            """{"op":"copy","from":"/missing/title","path":"/copied"}""",
            """{"op":"move","from":"/missing/title","path":"/moved"}""",
            """{"op":"replace","path":"/items/0/missing","value":1}""",
            """{"op":"add","path":"/nullable/title","value":1}""",
            """{"op":"add","path":"/items/-/title","value":1}""",
            """{"op":"replace","path":"/items/01/title","value":1}""",
            """{"op":"move","from":"/items","path":"/items/nested"}"""
        )

        operations.forEach { operation ->
            val delta = buildJsonArray {
                add(AgUiJson.parseToJsonElement("""{"op":"replace","path":"/count","value":1}"""))
                add(AgUiJson.parseToJsonElement(operation))
            }
            assertStateDeltaFailurePreservesState(operation, initialState, delta)
        }
    }

    @Test
    fun moveRejectsObjectDestinationMissingAfterSourceRemoval() = runTest {
        val initialState = AgUiJson.parseToJsonElement(
            """{"items":[{"id":"source"},{"nested":{}},{}],"untouched":true}"""
        )
        val delta = AgUiJson.parseToJsonElement(
            """[{"op":"move","from":"/items/0","path":"/items/1/nested/moved"}]"""
        ).jsonArray

        assertStateDeltaFailurePreservesState("move destination after removal", initialState, delta)
    }

    @Test
    fun missingObjectPathsUseDecodedPointerTokens() = runTest {
        val initialState = buildJsonObject {
            put("line\\nkey", 1)
            put("quotedkey", 2)
            put("back\\\\slash", 3)
            put("existing", 4)
        }
        val paths = listOf("/line\nkey", "/quoted\"key", "/back\\slash", "/", "//existing")

        paths.forEach { path ->
            val delta = buildJsonArray {
                add(buildJsonObject {
                    put("op", "replace")
                    put("path", path)
                    put("value", 9)
                })
            }
            assertStateDeltaFailurePreservesState("missing decoded path $path", initialState, delta)
        }
    }

    @Test
    fun stateDeltaPreservesApplicableObjectAndArrayOperations() = runTest {
        val cases = listOf(
            Triple(
                """{"count":0,"items":[{"title":"Original"}],"untouched":true}""",
                """[{"op":"replace","path":"/items/0/title","value":"Updated"}]""",
                """{"count":0,"items":[{"title":"Updated"}],"untouched":true}"""
            ),
            Triple(
                """{"untouched":true}""",
                """[{"op":"add","path":"/created","value":{"count":0}},{"op":"replace","path":"/created/count","value":1}]""",
                """{"untouched":true,"created":{"count":1}}"""
            ),
            Triple(
                """{"nullable":null,"removed":null}""",
                """[{"op":"test","path":"/nullable","value":null},{"op":"copy","from":"/nullable","path":"/copied"},{"op":"move","from":"/nullable","path":"/moved"},{"op":"remove","path":"/removed"},{"op":"replace","path":"/copied","value":1}]""",
                """{"copied":1,"moved":null}"""
            ),
            Triple(
                """{"items":[{"title":"Original"}]}""",
                """[{"op":"add","path":"/items/0","value":null},{"op":"add","path":"/items/-","value":null},{"op":"replace","path":"/items/1/title","value":"Updated"},{"op":"remove","path":"/items/0"}]""",
                """{"items":[{"title":"Updated"},null]}"""
            ),
            Triple(
                """{"items":[{"id":"source"},null,{"nested":{}}]}""",
                """[{"op":"move","from":"/items/0","path":"/items/1/nested/moved"}]""",
                """{"items":[null,{"nested":{"moved":{"id":"source"}}}]}"""
            ),
            Triple(
                """{"":{"nested":1},"a/b":{"~1":null}}""",
                """[{"op":"replace","path":"//nested","value":2},{"op":"replace","path":"/a~1b/~01","value":3},{"op":"replace","path":"/","value":null}]""",
                """{"":null,"a/b":{"~1":3}}"""
            ),
            Triple("null", """[{"op":"add","path":"","value":{"nullable":null}}]""", """{"nullable":null}""")
        )

        cases.forEach { (source, patch, expected) ->
            val delta = AgUiJson.parseToJsonElement(patch).jsonArray
            val appliedDeltas = mutableListOf<JsonArray>()
            var reportedError = false

            val states = defaultApplyEvents(
                baseInput().copy(state = AgUiJson.parseToJsonElement(source)),
                flowOf<BaseEvent>(StateDeltaEvent(delta = delta)),
                stateHandler = stateHandler(
                    onDelta = { appliedDeltas.add(it) },
                    onError = { _, _ -> reportedError = true }
                )
            ).toList()

            assertFalse(reportedError, patch)
            assertEquals(listOf(delta), appliedDeltas, patch)
            assertEquals(AgUiJson.parseToJsonElement(expected), states.single().state, patch)
        }
    }

    @Test
    fun matchingRootTestsPreserveTheDocument() = runTest {
        val equivalentValues = listOf(
            """{"number":1.0,"nested":[true,null,{"value":100}]}""" to
                """{"nested":[true,null,{"value":1e2}],"number":1}""",
            "[1,2.00,3e0]" to "[1.0,2,3]",
            "1.0" to "1",
            "100" to "1e2",
            "0.00100" to "1e-3",
            "-0e999999999999999999999" to "0",
            "10e-1" to "1",
            "0.1e1" to "1",
            "0.0100e+000000000000000000001" to "1e-1",
            "100e9223372036854775807" to "1e9223372036854775809",
            "1e-9223372036854775809" to "100e-9223372036854775811",
            "10e99999999999999999999999" to "1e100000000000000000000000",
            "10e-100000000000000000000000" to "1e-99999999999999999999999",
            "\"text\"" to "\"text\"",
            "true" to "true",
            "false" to "false",
            "null" to "null"
        )

        equivalentValues.forEach { (source, expected) ->
            val initialState = AgUiJson.parseToJsonElement(source)
            val delta = buildJsonArray {
                add(buildJsonObject {
                    put("op", "test")
                    put("path", "")
                    put("value", AgUiJson.parseToJsonElement(expected))
                })
            }
            val appliedDeltas = mutableListOf<JsonArray>()
            var reportedError = false

            val states = defaultApplyEvents(
                baseInput().copy(state = initialState),
                flowOf<BaseEvent>(StateDeltaEvent(delta = delta)),
                stateHandler = stateHandler(
                    onDelta = { appliedDeltas.add(it) },
                    onError = { _, _ -> reportedError = true }
                )
            ).toList()

            assertFalse(reportedError, "$source should equal $expected")
            assertEquals(listOf(delta), appliedDeltas)
            assertEquals(initialState.toString(), states.single().state.toString(), source)
        }
    }

    @Test
    fun rootTestsCompareTheDocumentAtTheirSequentialPosition() = runTest {
        val initialState = AgUiJson.parseToJsonElement("""{"count":0,"nested":[1.0]}""")
        val delta = AgUiJson.parseToJsonElement(
            """[
                {"op":"replace","path":"/count","value":1},
                {"op":"test","path":"","value":{"count":1.0,"nested":[1]}},
                {"op":"replace","path":"/count","value":2}
            ]"""
        ).jsonArray
        val appliedDeltas = mutableListOf<JsonArray>()
        var reportedError = false

        val states = defaultApplyEvents(
            baseInput().copy(state = initialState),
            flowOf<BaseEvent>(
                StateDeltaEvent(delta = delta),
                TextMessageStartEvent(messageId = "after-root-test"),
                TextMessageContentEvent(messageId = "after-root-test", delta = "continued")
            ),
            stateHandler = stateHandler(
                onDelta = { appliedDeltas.add(it) },
                onError = { _, _ -> reportedError = true }
            )
        ).toList()

        assertFalse(reportedError)
        assertEquals(listOf(delta), appliedDeltas)
        assertEquals(
            listOf(AgUiJson.parseToJsonElement("""{"count":2,"nested":[1.0]}""")),
            states.mapNotNull { it.state }
        )
        val messages = assertNotNull(states.last().messages)
        assertEquals("continued", (messages.single() as AssistantMessage).content)
    }

    @Test
    fun rootTestsRejectUnequalJsonValues() = runTest {
        val unequalValues = listOf(
            "9007199254740992" to "9007199254740993",
            "1e309" to "2e309",
            "1e-400" to "2e-400",
            "1e999999999999999999999" to "1e1000000000000000000000",
            "-1" to "1",
            "[1,2]" to "[2,1]",
            """{"nested":[{"number":1}]}""" to """{"nested":[{"number":2}]}""",
            """{"count":1,"extra":null}""" to """{"count":1}""",
            "\"1\"" to "1",
            "true" to "\"true\"",
            "null" to "false"
        )

        unequalValues.forEach { (source, expected) ->
            val delta = buildJsonArray {
                add(buildJsonObject {
                    put("op", "test")
                    put("path", "")
                    put("value", AgUiJson.parseToJsonElement(expected))
                })
            }
            assertStateDeltaFailurePreservesState(
                "$source must not equal $expected",
                AgUiJson.parseToJsonElement(source),
                delta
            )
        }
    }

    private suspend fun assertStateDeltaFailurePreservesState(
        label: String,
        initialState: JsonElement,
        failingDelta: JsonArray
    ) {
        val originalDocument = initialState.toString()
        val failingEvent = AgUiV1.decodeEvent(buildJsonObject {
            put("type", "STATE_DELTA")
            put("delta", failingDelta)
        }) as StateDeltaEvent
        val observeDelta = buildJsonArray { }
        val recoveredState = buildJsonObject { put("recovered", true) }
        val laterDelta = buildJsonArray {
            add(buildJsonObject {
                put("op", "replace")
                put("path", "")
                put("value", recoveredState)
            })
        }
        val reportedDeltas = mutableListOf<JsonArray?>()
        val appliedDeltas = mutableListOf<JsonArray>()

        val states = defaultApplyEvents(
            baseInput().copy(state = initialState),
            flowOf<BaseEvent>(
                failingEvent,
                StateDeltaEvent(delta = observeDelta),
                StateDeltaEvent(delta = laterDelta),
                TextMessageStartEvent(messageId = "after-failed-delta"),
                TextMessageContentEvent(messageId = "after-failed-delta", delta = "continued")
            ),
            stateHandler = stateHandler(
                onDelta = { appliedDeltas.add(it) },
                onError = { _, delta -> reportedDeltas.add(delta) }
            )
        ).toList()

        assertEquals<List<JsonArray?>>(listOf(failingDelta), reportedDeltas, label)
        failingEvent.delta.forEachIndexed { index, operation ->
            assertSame(operation, reportedDeltas.single()?.get(index), label)
        }
        assertEquals(listOf(observeDelta, laterDelta), appliedDeltas, label)
        assertEquals(listOf(initialState, recoveredState), states.mapNotNull { it.state }, label)
        assertEquals(originalDocument, states.first().state.toString(), label)
        assertEquals(originalDocument, initialState.toString(), label)
        val messages = assertNotNull(states.last().messages)
        assertEquals("continued", (messages.single() as AssistantMessage).content, label)
    }

    @Test
    fun stateDeltaCanReplaceRootWithJsonNull() = runTest {
        val delta = buildJsonArray {
            add(buildJsonObject {
                put("op", "replace")
                put("path", "")
                put("value", JsonNull)
            })
        }
        val appliedDeltas = mutableListOf<JsonArray>()
        var reportedError = false

        val states = defaultApplyEvents(
            baseInput(),
            flowOf<BaseEvent>(StateDeltaEvent(delta = delta)),
            stateHandler = stateHandler(
                onDelta = { appliedDeltas.add(it) },
                onError = { _, _ -> reportedError = true }
            )
        ).toList()

        assertSame(JsonNull, states.single().state)
        assertEquals(listOf(delta), appliedDeltas)
        assertFalse(reportedError)
    }

    @Test
    fun stateDeltaCallbackCancellationPropagatesWithoutReportingStateError() = runTest {
        val cancellation = CancellationException("State callback cancelled")
        var reportedError = false

        val thrown = assertFailsWith<CancellationException> {
            defaultApplyEvents(
                baseInput(),
                flowOf<BaseEvent>(StateDeltaEvent(delta = buildJsonArray { })),
                stateHandler = stateHandler(
                    onDelta = { throw cancellation },
                    onError = { _, _ -> reportedError = true }
                )
            ).toList()
        }

        assertSame(cancellation, thrown)
        assertFalse(reportedError)
    }

    @Test
    fun stateDeltaCallbackFailurePropagatesWithoutReportingStateError() = runTest {
        val failure = IllegalStateException("State callback failed")
        var reportedError = false

        val thrown = assertFailsWith<IllegalStateException> {
            defaultApplyEvents(
                baseInput(),
                flowOf<BaseEvent>(StateDeltaEvent(delta = buildJsonArray { })),
                stateHandler = stateHandler(
                    onDelta = { throw failure },
                    onError = { _, _ -> reportedError = true }
                )
            ).toList()
        }

        assertSame(failure, thrown)
        assertFalse(reportedError)
    }

    @Test
    fun stateDeltaCollectorFailuresPropagateWithoutReportingStateError() = runTest {
        val failures = listOf(
            IllegalStateException("Collector failed"),
            CancellationException("Collector cancelled")
        )

        failures.forEach { failure ->
            var reportedError = false
            var appliedDeltas = 0

            val thrown = assertFails {
                defaultApplyEvents(
                    baseInput(),
                    flowOf<BaseEvent>(StateDeltaEvent(delta = buildJsonArray { })),
                    stateHandler = stateHandler(
                        onDelta = { appliedDeltas++ },
                        onError = { _, _ -> reportedError = true }
                    )
                ).collect { throw failure }
            }

            assertSame(failure, thrown)
            assertEquals(1, appliedDeltas)
            assertFalse(reportedError)
        }
    }

    @Test
    fun stateErrorCallbackFailuresPropagateUnchanged() = runTest {
        val input = baseInput().copy(
            state = buildJsonObject { put("items", buildJsonArray { }) }
        )
        val failures = listOf(
            IllegalStateException("State error callback failed"),
            CancellationException("State error callback cancelled")
        )
        val delta = buildJsonArray {
            add(buildJsonObject {
                put("op", "replace")
                put("path", "/items/0/title")
                put("value", "new")
            })
        }

        failures.forEach { failure ->
            var reportedErrors = 0
            var appliedDelta = false

            val thrown = assertFails {
                defaultApplyEvents(
                    input,
                    flowOf<BaseEvent>(StateDeltaEvent(delta = delta)),
                    stateHandler = stateHandler(
                        onDelta = { appliedDelta = true },
                        onError = { _, failedDelta ->
                            reportedErrors++
                            assertEquals(delta, failedDelta)
                            throw failure
                        }
                    )
                ).toList()
            }

            assertSame(failure, thrown)
            assertEquals(1, reportedErrors)
            assertFalse(appliedDelta)
        }
    }

    @Test
    fun tracksThinkingTelemetryDuringStream() = runTest {
        val input = baseInput()
        val events = flowOf<BaseEvent>(
            ThinkingStartEvent(title = "Planning"),
            ThinkingTextMessageStartEvent(),
            ThinkingTextMessageContentEvent(delta = "Step 1"),
            ThinkingTextMessageContentEvent(delta = " -> Step 2")
        )

        val states = defaultApplyEvents(input, events).toList()
        val thinking = states.last().thinking
        assertNotNull(thinking)
        assertTrue(thinking.isThinking)
        assertEquals("Planning", thinking.title)
        assertEquals(listOf("Step 1 -> Step 2"), thinking.messages)
    }

    @Test
    fun thinkingEndMarksStatusInactive() = runTest {
        val input = baseInput()
        val events = flowOf<BaseEvent>(
            ThinkingStartEvent(title = "Reasoning"),
            ThinkingTextMessageStartEvent(),
            ThinkingTextMessageContentEvent(delta = "Considering options"),
            ThinkingTextMessageEndEvent(),
            ThinkingEndEvent()
        )

        val states = defaultApplyEvents(input, events).toList()
        val thinking = states.last().thinking
        assertNotNull(thinking)
        assertFalse(thinking.isThinking)
        assertEquals(listOf("Considering options"), thinking.messages)
    }

    @Test
    fun tracksReasoningSingleStreamLifecycle() = runTest {
        val input = baseInput()
        val events = flowOf<BaseEvent>(
            ReasoningStartEvent(messageId = "r1"),
            ReasoningMessageStartEvent(messageId = "r1"),
            ReasoningMessageContentEvent(messageId = "r1", delta = "Step 1"),
            ReasoningMessageContentEvent(messageId = "r1", delta = " -> Step 2"),
            ReasoningMessageEndEvent(messageId = "r1"),
            ReasoningEndEvent(messageId = "r1")
        )

        val states = defaultApplyEvents(input, events).toList()
        val reasoning = states.last().reasoning
        assertNotNull(reasoning)
        assertEquals(1, reasoning.streams.size)
        val stream = reasoning.streams.first()
        assertEquals("r1", stream.messageId)
        assertFalse(stream.isActive)
        assertEquals("Step 1 -> Step 2", stream.text)
    }

    @Test
    fun tracksReasoningConcurrentStreams() = runTest {
        val input = baseInput()
        val events = flowOf<BaseEvent>(
            ReasoningStartEvent(messageId = "r1"),
            ReasoningStartEvent(messageId = "r2"),
            ReasoningMessageContentEvent(messageId = "r1", delta = "alpha"),
            ReasoningMessageContentEvent(messageId = "r2", delta = "beta"),
            ReasoningMessageContentEvent(messageId = "r1", delta = " more"),
            ReasoningEndEvent(messageId = "r2"),
            ReasoningEndEvent(messageId = "r1")
        )

        val states = defaultApplyEvents(input, events).toList()
        val reasoning = states.last().reasoning
        assertNotNull(reasoning)
        assertEquals(2, reasoning.streams.size)

        val r1 = reasoning.streams.first { it.messageId == "r1" }
        val r2 = reasoning.streams.first { it.messageId == "r2" }
        assertEquals("alpha more", r1.text)
        assertEquals("beta", r2.text)
        assertFalse(r1.isActive)
        assertFalse(r2.isActive)
    }

    @Test
    fun reasoningEncryptedValueAttachesToMostRecentStream() = runTest {
        val input = baseInput()
        val events = flowOf<BaseEvent>(
            ReasoningStartEvent(messageId = "r1"),
            ReasoningMessageContentEvent(messageId = "r1", delta = "thinking..."),
            ReasoningEncryptedValueEvent(
                subtype = "message",
                entityId = "e1",
                encryptedValue = "ENC_PAYLOAD"
            ),
            ReasoningEndEvent(messageId = "r1")
        )

        val states = defaultApplyEvents(input, events).toList()
        val reasoning = states.last().reasoning
        assertNotNull(reasoning)
        val stream = reasoning.streams.single()
        assertEquals("r1", stream.messageId)
        assertEquals(1, stream.encryptedValues.size)
        val ev = stream.encryptedValues.first()
        assertEquals("message", ev.subtype)
        assertEquals("e1", ev.entityId)
        assertEquals("ENC_PAYLOAD", ev.encryptedValue)
    }

    @Test
    fun reasoningChunkAutoPopulatesStream() = runTest {
        val input = baseInput()
        val events = flowOf<BaseEvent>(
            ReasoningMessageChunkEvent(messageId = "r1", delta = "Hello "),
            ReasoningMessageChunkEvent(delta = "world!")
        )

        val states = defaultApplyEvents(input, events).toList()
        val reasoning = states.last().reasoning
        assertNotNull(reasoning)
        val stream = reasoning.streams.single()
        assertEquals("r1", stream.messageId)
        assertEquals("Hello world!", stream.text)
        assertTrue(stream.isActive)
    }
}
