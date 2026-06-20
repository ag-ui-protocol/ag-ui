@file:Suppress("DEPRECATION")

package com.agui.client.state

import com.agui.client.agent.AbstractAgent
import com.agui.client.agent.AgentEventParams
import com.agui.client.agent.AgentStateMutation
import com.agui.client.agent.AgentSubscriber
import com.agui.client.chunks.transformChunks
import com.agui.core.types.*
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertFalse
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
