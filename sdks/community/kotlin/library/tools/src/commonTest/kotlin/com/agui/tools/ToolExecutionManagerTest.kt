package com.agui.tools

import com.agui.core.types.Tool
import com.agui.core.types.ToolCallStartEvent
import com.agui.core.types.ToolCallArgsEvent
import com.agui.core.types.ToolCallEndEvent
import com.agui.core.types.ToolMessage
import com.agui.core.types.RunFinishedEvent
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ToolExecutionManagerTest {

    @Test
    fun executesRegisteredToolAndEmitsLifecycleEvents() = runTest {
        val registry = DefaultToolRegistry()
        val handler = RecordingResponseHandler()
        val manager = ToolExecutionManager(registry, handler)

        registry.registerTool(
            object : AbstractToolExecutor(
                Tool(
                    name = "echo",
                    description = "Returns the provided text",
                    parameters = JsonObject(emptyMap())
                )
            ) {
                override suspend fun executeInternal(context: ToolExecutionContext): ToolExecutionResult {
                    return ToolExecutionResult.success(message = "echo:${context.toolCall.function.arguments}")
                }
            }
        )

        val streamEvents = listOf(
            ToolCallStartEvent(toolCallId = "call-1", toolCallName = "echo"),
            ToolCallArgsEvent(toolCallId = "call-1", delta = """{"text":"hi"}"""),
            ToolCallEndEvent(toolCallId = "call-1"),
            RunFinishedEvent(threadId = "thread-1", runId = "run-1")
        )

        val collected = manager.processEventStream(
            events = flowOf(*streamEvents.toTypedArray()),
            threadId = "thread-1",
            runId = "run-1"
        ).toList()

        assertEquals(streamEvents, collected)
        assertEquals(1, handler.messages.size)
        val response = handler.messages.single()
        assertEquals("call-1", response.toolCallId)
        assertEquals("""echo:{"text":"hi"}""", response.content)
    }

    @Test
    fun missingToolProducesFailureResponse() = runTest {
        val registry = DefaultToolRegistry() // intentionally empty
        val handler = RecordingResponseHandler()
        val manager = ToolExecutionManager(registry, handler)

        manager.processEventStream(
            events = flowOf(
                ToolCallStartEvent(toolCallId = "missing-1", toolCallName = "unknown"),
                ToolCallArgsEvent(toolCallId = "missing-1", delta = "{}"),
                ToolCallEndEvent(toolCallId = "missing-1"),
                RunFinishedEvent(threadId = "thread-2", runId = "run-2")
            ),
            threadId = "thread-2",
            runId = "run-2"
        ).toList()

        assertEquals(1, handler.messages.size)
        val response = handler.messages.single()
        assertEquals("missing-1", response.toolCallId)
        assertTrue(response.content.contains("not available"))
    }

    private class RecordingResponseHandler : ToolResponseHandler {
        val messages = mutableListOf<ToolMessage>()
        override suspend fun sendToolResponse(toolMessage: ToolMessage, threadId: String?, runId: String?) {
            messages += toolMessage.copy(content = toolMessage.content)
        }
    }
}
