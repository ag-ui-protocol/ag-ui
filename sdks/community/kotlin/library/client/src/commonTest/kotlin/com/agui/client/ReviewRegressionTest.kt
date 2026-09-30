package com.agui.client

import com.agui.core.types.*
import com.agui.client.agent.*
import com.agui.client.state.defaultApplyEvents
import com.agui.client.chunks.transformChunks
import com.agui.client.verify.verifyEvents
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.*
import kotlin.test.*

class ReviewRegressionTest {
    private val start = RunStartedEvent("t", "r")
    private val finish = RunFinishedEvent("t", "r")
    private fun json(s: String) = AgUiJson.parseToJsonElement(s)
    private suspend fun verify(vararg events: BaseEvent) = events.asFlow().verifyEvents().toList()
    private class Agent(val events: Flow<BaseEvent>) : AbstractAgent() {
        var errors = 0
        override fun run(input: RunAgentInput) = events
        override fun onError(error: Throwable) { errors++ }
    }

    @Test fun observablePropagatesMalformedPatchesButRecoversApplicationFailures() = runTest {
        val malformed = StateDeltaEvent(json("""[{"path":"/x","value":1}]""").jsonArray)
        val agent = Agent(flowOf(start, malformed, finish))
        val received = mutableListOf<BaseEvent>()
        assertFails { agent.runAgentObservable(RunAgentInput("t", "r")).collect { received.add(it) } }
        assertEquals<List<BaseEvent>>(listOf(start), received)
        assertEquals(1, agent.errors)
        for ((patch, expected) in listOf(
            """[{"op":"add","path":"/x","value":7}]""" to """{"x":7}""",
            """[{"op":"remove","path":"/absent"}]""" to "{}"
        )) {
            val control = Agent(flowOf(start, StateDeltaEvent(json(patch).jsonArray), finish))
            assertEquals(3, control.runAgentObservable(RunAgentInput("t", "r")).toList().size)
            assertEquals<JsonElement?>(json(expected), control.state)
            assertEquals(0, control.errors)
        }
    }

    @Test fun reasoningChunksExpandAndRequireAnOpener() = runTest {
        assertFails { flowOf<BaseEvent>(start, ReasoningMessageChunkEvent(delta = "x"), finish).transformChunks().verifyEvents().toList() }
        val events = flowOf<BaseEvent>(start, ReasoningMessageChunkEvent("m", "a"), ReasoningMessageChunkEvent(delta = "b"), finish)
            .transformChunks().verifyEvents().toList()
        assertEquals(listOf("a", "b"), events.filterIsInstance<ReasoningMessageContentEvent>().map { it.delta })
        assertEquals(1, events.filterIsInstance<ReasoningMessageStartEvent>().size)
        assertEquals(1, events.filterIsInstance<ReasoningMessageEndEvent>().size)
        assertFails { flowOf<BaseEvent>(start, ReasoningMessageStartEvent("m"), ReasoningMessageChunkEvent("m", "x"), finish).transformChunks().verifyEvents().toList() }
    }

    @Test fun childChunksDoNotCloseOrStealParentContinuations() = runTest {
        val events = flowOf<BaseEvent>(start,
            TextMessageChunkEvent(messageId = "parent", delta = "p1"),
            SubagentStartedEvent("child", "worker"),
            TextMessageChunkEvent(messageId = "child-message", delta = "c1", subagentRunId = "child"),
            TextMessageChunkEvent(delta = "p2"),
            TextMessageChunkEvent(delta = "c2", subagentRunId = "child"),
            SubagentFinishedEvent("child"),
            TextMessageChunkEvent(delta = "p3"), finish).transformChunks().verifyEvents().toList()
        assertEquals(listOf("p1", "p2", "p3"), events.filterIsInstance<TextMessageContentEvent>().filter { it.messageId == "parent" }.map { it.delta })
        assertEquals(listOf("c1", "c2"), events.filterIsInstance<TextMessageContentEvent>().filter { it.messageId == "child-message" }.map { it.delta })
        assertEquals(1, events.filterIsInstance<TextMessageEndEvent>().count { it.messageId == "parent" })
    }

    @Test fun textAndToolHistoryRetainEnvelopesAndNamedEncryptedValues() = runTest {
        val a = json("""{"a":1,"replace":"old"}""").jsonObject
        val b = json("""{"b":2,"replace":"new"}""").jsonObject
        val states = defaultApplyEvents(RunAgentInput("t", "r"), flowOf(
            TextMessageStartEvent("m", Role.ASSISTANT, name = "speaker", metadata = a, subagentRunId = "child"),
            TextMessageContentEvent("m", "hello", metadata = b),
            TextMessageEndEvent("m", metadata = json("""{"end":true}""").jsonObject),
            ToolCallStartEvent("c", "f", parentMessageId = "m", metadata = a, subagentRunId = "child"),
            ToolCallArgsEvent("c", "{}", metadata = b), ToolCallEndEvent("c"),
            ReasoningEncryptedValueEvent("message", "m", "message-secret"),
            ReasoningEncryptedValueEvent("tool-call", "c", "call-secret")
        )).toList()
        val message = states.last { it.messages != null }.messages!!.single() as AssistantMessage
        assertEquals("speaker", message.name)
        assertEquals("child", message.subagentRunId)
        assertEquals<JsonElement?>(json("""{"a":1,"b":2,"replace":"new","end":true}"""), message.metadata)
        assertEquals("message-secret", message.encryptedValue)
        val call = message.toolCalls!!.single()
        assertEquals<JsonElement?>(json("""{"a":1,"b":2,"replace":"new"}"""), call.metadata)
        assertEquals("call-secret", call.encryptedValue)
    }

    @Test fun nestedPatchTestsCompareNumbersSemantically() = runTest {
        val initial = json("""{"nested":[{"n":1}]}""")
        val patch = json("""[{"op":"test","path":"/nested","value":[{"n":1e0}]},{"op":"add","path":"/ok","value":true}]""")
        val states = defaultApplyEvents(RunAgentInput("t", "r", state = initial), flowOf(StateDeltaEvent(patch.jsonArray))).toList()
        assertEquals<JsonElement?>(json("""{"nested":[{"n":1}],"ok":true}"""), states.last { it.state != null }.state)
    }

    @Test fun rootSourceCopyAndMoveRespectTheDocument() = runTest {
        val initial = json("""{"x":1,"":"empty-name"}""")
        val cases = listOf(
            """[{"op":"copy","from":"","path":"/copy"}]""" to json("""{"x":1,"":"empty-name","copy":{"x":1,"":"empty-name"}}"""),
            """[{"op":"move","from":"","path":""}]""" to initial,
            """[{"op":"move","from":"","path":"/child"}]""" to initial,
            """[{"op":"move","from":"/x","path":""}]""" to JsonPrimitive(1)
        )
        for ((patch, expected) in cases) {
            val agent = Agent(flowOf(start, StateDeltaEvent(json(patch).jsonArray), finish))
            agent.runAgentObservable(RunAgentInput("t", "r", state = initial)).toList()
            assertEquals(expected, agent.state)
        }
    }

    @Test fun patchPointersUseDecodedJsonCharacters() = runTest {
        val keys = listOf("quote\"", "slash\\", "line\n", "a/b", "a~b")
        for (key in keys) {
            val pointer = "/" + key.replace("~", "~0").replace("/", "~1")
            val operations = JsonArray(listOf(buildJsonObject { put("op", "add"); put("path", pointer); put("value", 1) },
                buildJsonObject { put("op", "test"); put("path", pointer); put("value", 1) }))
            val agent = Agent(flowOf(start, StateDeltaEvent(operations), finish))
            agent.runAgentObservable(RunAgentInput("t", "r")).toList()
            assertEquals(buildJsonObject { put(key, 1) }, agent.state)
        }
    }

    @Test fun newRunAfterErrorResetsVerifier() = runTest {
        verify(start, TextMessageStartEvent("m", Role.ASSISTANT), RunErrorEvent("failed"), RunStartedEvent("t", "r2"), RunFinishedEvent("t", "r2"))
        assertFails { verify(start, RunErrorEvent("failed"), TextMessageStartEvent("m", Role.ASSISTANT)) }
    }

    @Test fun explicitOwnersMustMatchButOmittedOwnersAreLegal() = runTest {
        val openers = listOf<BaseEvent>(TextMessageStartEvent("m", Role.ASSISTANT, subagentRunId = "a"),
            ToolCallStartEvent("c", "f", subagentRunId = "a"), ReasoningMessageStartEvent("r", subagentRunId = "a"))
        val wrong = listOf<BaseEvent>(TextMessageContentEvent("m", "x", subagentRunId = "b"),
            ToolCallArgsEvent("c", "{}", subagentRunId = "b"), ReasoningMessageContentEvent("r", "x", subagentRunId = "b"))
        val ends = listOf<BaseEvent>(TextMessageEndEvent("m"), ToolCallEndEvent("c"), ReasoningMessageEndEvent("r"))
        for (i in openers.indices) {
            assertFails { verify(start, openers[i], wrong[i], ends[i], finish) }
            verify(start, openers[i], ends[i], finish)
        }
        assertFails { verify(start, openers[0], ToolCallStartEvent("c", "f", parentMessageId = "m", subagentRunId = "b")) }
    }

    @Test fun untaggedToolCallInheritsItsParentMessageOwner() = runTest {
        verify(start, TextMessageStartEvent("m", Role.ASSISTANT, subagentRunId = "a"), TextMessageEndEvent("m"),
            ToolCallStartEvent("c", "f", parentMessageId = "m"), ToolCallArgsEvent("c", "{}", subagentRunId = "a"),
            ToolCallEndEvent("c", subagentRunId = "a"), finish)
        assertFails {
            verify(start, TextMessageStartEvent("m", Role.ASSISTANT, subagentRunId = "a"), TextMessageEndEvent("m"),
                ToolCallStartEvent("c", "f", parentMessageId = "m"), ToolCallArgsEvent("c", "{}", subagentRunId = "b"))
        }
    }

    @Test fun stepsAreScopedByOwner() = runTest {
        verify(start, StepStartedEvent("same"), StepStartedEvent("same", subagentRunId = "child"),
            StepFinishedEvent("same", subagentRunId = "child"), StepFinishedEvent("same"), finish)
        assertFails { verify(start, StepStartedEvent("same", subagentRunId = "child"), StepFinishedEvent("same"), finish) }
    }

    @Test fun announcedSubagentLifecycleMustBeComplete() = runTest {
        verify(start, SubagentStartedEvent("a", "worker"), SubagentFinishedEvent("a"), finish)
        verify(start, SubagentStartedEvent("a", "worker"), SubagentErrorEvent("a", "failed"), finish)
        verify(start, SubagentStartedEvent("a", "worker"), RunErrorEvent("failed"))
        val bad = listOf(
            listOf(SubagentStartedEvent("a", "worker")),
            listOf(SubagentFinishedEvent("a")),
            listOf(SubagentStartedEvent("a", "worker"), SubagentStartedEvent("a", "worker")),
            listOf(SubagentStartedEvent("a", "worker"), SubagentFinishedEvent("a"), SubagentStartedEvent("a", "worker")),
            listOf(SubagentStartedEvent("a", "worker", parentSubagentRunId = "missing")),
            listOf(TextMessageStartEvent("m", Role.ASSISTANT, subagentRunId = "a"), TextMessageEndEvent("m"), SubagentStartedEvent("a", "worker"))
        )
        for (events in bad) assertFails { verify(start, *events.toTypedArray(), finish) }
    }

    @Test fun pendingToolDeclarationsOnlyNameUnansweredCalls() = runTest {
        val pending = finish.copy(outcome = RunFinishedSuccessOutcome(listOf("c")))
        verify(start, ToolCallStartEvent("c", "f"), ToolCallEndEvent("c"), pending)
        assertFails { verify(start, pending) }
        assertFails { verify(start, ToolCallStartEvent("c", "f"), ToolCallEndEvent("c"), ToolCallResultEvent("m", "c", "done"), pending) }
    }

    @Test fun emptyStreamIsTruncated() = runTest { assertFails { emptyFlow<BaseEvent>().verifyEvents().toList() } }
}
