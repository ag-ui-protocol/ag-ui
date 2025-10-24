package com.agui.client.agent

import com.agui.core.types.BaseEvent
import com.agui.core.types.Role
import com.agui.core.types.RunAgentInput
import com.agui.core.types.RunFinishedEvent
import com.agui.core.types.RunStartedEvent
import com.agui.core.types.TextMessageContentEvent
import com.agui.core.types.TextMessageEndEvent
import com.agui.core.types.TextMessageStartEvent
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.test.runTest

class AbstractAgentTest {

    @Test
    fun runAgent_notifiesSubscribersAndUpdatesMessages() = runTest {
        val agent = RecordingAgent(
            events = flowOf(
                RunStartedEvent(threadId = "thread-1", runId = "run-1"),
                TextMessageStartEvent(messageId = "assistant-1", role = Role.ASSISTANT),
                TextMessageContentEvent(messageId = "assistant-1", delta = "Hello"),
                TextMessageEndEvent(messageId = "assistant-1"),
                RunFinishedEvent(threadId = "thread-1", runId = "run-1")
            )
        )
        val subscriber = RecordingSubscriber()
        agent.subscribe(subscriber)

        agent.runAgent()

        val messages = agent.messages
        assertEquals(1, messages.size)
        val assistant = messages.first()
        assertEquals("assistant-1", assistant.id)
        assertEquals("Hello", assistant.content)

        assertEquals(1, subscriber.initializedCount)
        assertEquals(5, subscriber.eventCount)
        assertEquals(1, subscriber.finalizedCount)
        assertEquals(0, subscriber.failedCount)
        assertEquals(1, agent.finalizeCount)
        assertEquals(0, agent.errorCount)
    }

    @Test
    fun runAgent_propagatesErrorsThroughSubscribers() = runTest {
        val agent = RecordingAgent(
            events = flow {
                emit(RunStartedEvent(threadId = "thread-err", runId = "run-err"))
                emit(TextMessageStartEvent(messageId = "assistant-err", role = Role.ASSISTANT))
                throw IllegalStateException("boom")
            }
        )
        val subscriber = RecordingSubscriber()
        agent.subscribe(subscriber)

        agent.runAgent()

        assertEquals(1, subscriber.initializedCount)
        assertEquals(2, subscriber.eventCount)
        assertEquals(1, subscriber.failedCount)
        assertEquals(1, subscriber.finalizedCount)
        assertEquals(1, agent.errorCount)
        assertEquals(1, agent.finalizeCount)
        // Messages should still contain the started streaming message even after failure
        assertTrue(agent.messages.any { it.id == "assistant-err" })
    }

    @Test
    fun runAgentObservable_streamsEventsWithoutCompletingStatePipeline() = runTest {
        val agent = RecordingAgent(
            events = flowOf(
                RunStartedEvent(threadId = "thread-stream", runId = "run-stream"),
                TextMessageStartEvent(messageId = "assistant-stream", role = Role.ASSISTANT),
                TextMessageContentEvent(messageId = "assistant-stream", delta = "Streaming"),
                TextMessageEndEvent(messageId = "assistant-stream"),
                RunFinishedEvent(threadId = "thread-stream", runId = "run-stream")
            )
        )
        val subscriber = RecordingSubscriber()

        val collected = mutableListOf<String>()
        agent.runAgentObservable(subscriber = subscriber).collect { event ->
            collected += event.eventType.name
        }

        assertEquals(
            listOf(
                "RUN_STARTED",
                "TEXT_MESSAGE_START",
                "TEXT_MESSAGE_CONTENT",
                "TEXT_MESSAGE_END",
                "RUN_FINISHED"
            ),
            collected
        )
        assertEquals(1, subscriber.initializedCount)
        assertEquals(collected.size, subscriber.eventCount)
        assertEquals(1, subscriber.finalizedCount)
        assertFalse(agent.messages.isEmpty())
    }

    private class RecordingAgent(
        private val events: Flow<BaseEvent>
    ) : AbstractAgent() {
        var errorCount = 0
        var finalizeCount = 0

        override fun run(input: RunAgentInput): Flow<BaseEvent> = events

        override fun onError(error: Throwable) {
            errorCount++
        }

        override fun onFinalize() {
            finalizeCount++
        }
    }

    private class RecordingSubscriber : AgentSubscriber {
        var initializedCount = 0
        var finalizedCount = 0
        var failedCount = 0
        var eventCount = 0

        override suspend fun onRunInitialized(params: AgentSubscriberParams): AgentStateMutation? {
            initializedCount++
            return null
        }

        override suspend fun onRunFinalized(params: AgentSubscriberParams): AgentStateMutation? {
            finalizedCount++
            return null
        }

        override suspend fun onRunFailed(params: AgentRunFailureParams): AgentStateMutation? {
            failedCount++
            return null
        }

        override suspend fun onEvent(params: AgentEventParams): AgentStateMutation? {
            eventCount++
            return null
        }
    }
}
