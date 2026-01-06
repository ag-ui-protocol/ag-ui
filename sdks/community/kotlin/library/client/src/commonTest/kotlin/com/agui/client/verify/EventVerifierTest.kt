package com.agui.client.verify

import com.agui.core.types.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.buildJsonArray
import kotlin.test.*

class EventVerifierTest {

    // ========== Basic Flow Tests ==========

    @Test
    fun testValidEventSequence() = runTest {
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            TextMessageStartEvent(messageId = "m1"),
            TextMessageContentEvent(messageId = "m1", delta = "Hello"),
            TextMessageEndEvent(messageId = "m1"),
            RunFinishedEvent(threadId = "t1", runId = "r1")
        )

        val result = events.verifyEvents().toList()
        assertEquals(5, result.size)
    }

    @Test
    fun testEmptyFlow() = runTest {
        val events = emptyFlow<BaseEvent>()
        val result = events.verifyEvents().toList()
        assertEquals(0, result.size)
    }

    // ========== Run Lifecycle Tests ==========

    @Test
    fun testFirstEventMustBeRunStarted() = runTest {
        val events = flowOf(
            TextMessageStartEvent(messageId = "m1")
        )

        assertFailsWith<AGUIError> {
            events.verifyEvents().toList()
        }.let { error ->
            assertTrue(error.message!!.contains("First event must be 'RUN_STARTED'"))
        }
    }

    @Test
    fun testFirstEventCanBeRunError() = runTest {
        val events = flowOf(
            RunErrorEvent(message = "Failed to start")
        )

        val result = events.verifyEvents().toList()
        assertEquals(1, result.size)
    }

    @Test
    fun testCannotSendMultipleRunStarted() = runTest {
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            RunStartedEvent(threadId = "t2", runId = "r2")
        )

        assertFailsWith<AGUIError> {
            events.verifyEvents().toList()
        }.let { error ->
            assertTrue(error.message!!.contains("Cannot send 'RUN_STARTED' while a run is still active"))
        }
    }

    @Test
    fun testCannotSendEventsAfterRunFinished() = runTest {
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            RunFinishedEvent(threadId = "t1", runId = "r1"),
            TextMessageStartEvent(messageId = "m1")
        )

        assertFailsWith<AGUIError> {
            events.verifyEvents().toList()
        }.let { error ->
            assertTrue(error.message!!.contains("The run has already finished"))
        }
    }

    @Test
    fun testCannotSendEventsAfterRunError() = runTest {
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            RunErrorEvent(message = "Error occurred"),
            TextMessageStartEvent(messageId = "m1")
        )

        assertFailsWith<AGUIError> {
            events.verifyEvents().toList()
        }.let { error ->
            assertTrue(error.message!!.contains("The run has already errored"))
        }
    }

    @Test
    fun testCanSendRunErrorAfterRunFinished() = runTest {
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            RunFinishedEvent(threadId = "t1", runId = "r1"),
            RunErrorEvent(message = "Late error")
        )

        val result = events.verifyEvents().toList()
        assertEquals(3, result.size)
    }

    // ========== Text Message Tests ==========

    @Test
    fun testValidTextMessageSequence() = runTest {
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            TextMessageStartEvent(messageId = "m1"),
            TextMessageContentEvent(messageId = "m1", delta = "Hello "),
            TextMessageContentEvent(messageId = "m1", delta = "world!"),
            TextMessageEndEvent(messageId = "m1"),
            RunFinishedEvent(threadId = "t1", runId = "r1")
        )

        val result = events.verifyEvents().toList()
        assertEquals(6, result.size)
    }

    @Test
    fun testConcurrentTextMessagesWithDifferentIds() = runTest {
        // TypeScript SDK supports concurrent messages with different IDs
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            TextMessageStartEvent(messageId = "m1"),
            TextMessageStartEvent(messageId = "m2"),
            TextMessageContentEvent(messageId = "m1", delta = "Hello"),
            TextMessageContentEvent(messageId = "m2", delta = "World"),
            TextMessageEndEvent(messageId = "m1"),
            TextMessageEndEvent(messageId = "m2"),
            RunFinishedEvent(threadId = "t1", runId = "r1")
        )

        val result = events.verifyEvents().toList()
        assertEquals(8, result.size)
    }

    @Test
    fun testCannotStartSameMessageIdTwice() = runTest {
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            TextMessageStartEvent(messageId = "m1"),
            TextMessageStartEvent(messageId = "m1") // Same ID
        )

        val error = assertFailsWith<AGUIError> {
            events.verifyEvents().toList()
        }
        assertTrue(error.message!!.contains("A text message with ID 'm1' is already in progress"))
    }

    @Test
    fun testCannotSendContentWithoutStart() = runTest {
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            TextMessageContentEvent(messageId = "m1", delta = "Hello")
        )

        assertFailsWith<AGUIError> {
            events.verifyEvents().toList()
        }.let { error ->
            assertTrue(error.message!!.contains("No active text message found"))
        }
    }

    @Test
    fun testCannotSendEndWithoutStart() = runTest {
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            TextMessageEndEvent(messageId = "m1")
        )

        assertFailsWith<AGUIError> {
            events.verifyEvents().toList()
        }.let { error ->
            assertTrue(error.message!!.contains("No active text message found"))
        }
    }

    @Test
    fun testContentForNonExistentMessage() = runTest {
        // With concurrent message support, sending content for a non-started message ID fails
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            TextMessageStartEvent(messageId = "m1"),
            TextMessageContentEvent(messageId = "m2", delta = "Hello") // m2 not started
        )

        assertFailsWith<AGUIError> {
            events.verifyEvents().toList()
        }.let { error ->
            assertTrue(error.message!!.contains("No active text message found with ID 'm2'"))
        }
    }

    @Test
    fun testEndForNonExistentMessage() = runTest {
        // With concurrent message support, ending a non-started message ID fails
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            TextMessageStartEvent(messageId = "m1"),
            TextMessageEndEvent(messageId = "m2") // m2 not started
        )

        assertFailsWith<AGUIError> {
            events.verifyEvents().toList()
        }.let { error ->
            assertTrue(error.message!!.contains("No active text message found with ID 'm2'"))
        }
    }

    @Test
    fun testOtherEventsAllowedDuringTextMessage() = runTest {
        // TypeScript SDK allows other events during active text messages
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            TextMessageStartEvent(messageId = "m1"),
            ToolCallStartEvent(toolCallId = "t1", toolCallName = "test"),
            ToolCallEndEvent(toolCallId = "t1"),
            TextMessageContentEvent(messageId = "m1", delta = "Hello"),
            TextMessageEndEvent(messageId = "m1"),
            RunFinishedEvent(threadId = "t1", runId = "r1")
        )

        val result = events.verifyEvents().toList()
        assertEquals(7, result.size)
    }

    // ========== Tool Call Tests ==========

    @Test
    fun testValidToolCallSequence() = runTest {
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            ToolCallStartEvent(toolCallId = "tc1", toolCallName = "get_weather"),
            ToolCallArgsEvent(toolCallId = "tc1", delta = "{\"location\":"),
            ToolCallArgsEvent(toolCallId = "tc1", delta = " \"Paris\"}"),
            ToolCallEndEvent(toolCallId = "tc1"),
            RunFinishedEvent(threadId = "t1", runId = "r1")
        )

        val result = events.verifyEvents().toList()
        assertEquals(6, result.size)
    }

    @Test
    fun testConcurrentToolCallsWithDifferentIds() = runTest {
        // TypeScript SDK supports concurrent tool calls with different IDs
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            ToolCallStartEvent(toolCallId = "tc1", toolCallName = "tool1"),
            ToolCallStartEvent(toolCallId = "tc2", toolCallName = "tool2"),
            ToolCallArgsEvent(toolCallId = "tc1", delta = "{}"),
            ToolCallArgsEvent(toolCallId = "tc2", delta = "{}"),
            ToolCallEndEvent(toolCallId = "tc1"),
            ToolCallEndEvent(toolCallId = "tc2"),
            RunFinishedEvent(threadId = "t1", runId = "r1")
        )

        val result = events.verifyEvents().toList()
        assertEquals(8, result.size)
    }

    @Test
    fun testCannotStartSameToolCallIdTwice() = runTest {
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            ToolCallStartEvent(toolCallId = "tc1", toolCallName = "tool1"),
            ToolCallStartEvent(toolCallId = "tc1", toolCallName = "tool2") // Same ID
        )

        assertFailsWith<AGUIError> {
            events.verifyEvents().toList()
        }.let { error ->
            assertTrue(error.message!!.contains("A tool call with ID 'tc1' is already in progress"))
        }
    }

    @Test
    fun testCannotSendArgsWithoutStart() = runTest {
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            ToolCallArgsEvent(toolCallId = "tc1", delta = "{}")
        )

        assertFailsWith<AGUIError> {
            events.verifyEvents().toList()
        }.let { error ->
            assertTrue(error.message!!.contains("No active tool call found"))
        }
    }

    @Test
    fun testArgsForNonExistentToolCall() = runTest {
        // With concurrent tool call support, sending args for a non-started tool call ID fails
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            ToolCallStartEvent(toolCallId = "tc1", toolCallName = "tool1"),
            ToolCallArgsEvent(toolCallId = "tc2", delta = "{}") // tc2 not started
        )

        assertFailsWith<AGUIError> {
            events.verifyEvents().toList()
        }.let { error ->
            assertTrue(error.message!!.contains("No active tool call found with ID 'tc2'"))
        }
    }

    // ========== Step Tests ==========

    @Test
    fun testValidStepSequence() = runTest {
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            StepStartedEvent(stepName = "step1"),
            StepStartedEvent(stepName = "step2"),
            StepFinishedEvent(stepName = "step1"),
            StepFinishedEvent(stepName = "step2"),
            RunFinishedEvent(threadId = "t1", runId = "r1")
        )

        val result = events.verifyEvents().toList()
        assertEquals(6, result.size)
    }

    @Test
    fun testCannotStartDuplicateStep() = runTest {
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            StepStartedEvent(stepName = "step1"),
            StepStartedEvent(stepName = "step1")
        )

        assertFailsWith<AGUIError> {
            events.verifyEvents().toList()
        }.let { error ->
            assertTrue(error.message!!.contains("Step \"step1\" is already active"))
        }
    }

    @Test
    fun testCannotFinishNonStartedStep() = runTest {
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            StepFinishedEvent(stepName = "step1")
        )

        assertFailsWith<AGUIError> {
            events.verifyEvents().toList()
        }.let { error ->
            assertTrue(error.message!!.contains("step \"step1\" that was not started"))
        }
    }

    @Test
    fun testCannotFinishRunWithActiveSteps() = runTest {
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            StepStartedEvent(stepName = "step1"),
            RunFinishedEvent(threadId = "t1", runId = "r1")
        )

        assertFailsWith<AGUIError> {
            events.verifyEvents().toList()
        }.let { error ->
            assertTrue(error.message!!.contains("steps are still active: step1"))
        }
    }

    // ========== Thinking Events Tests ==========

    @Test
    fun testValidThinkingSequence() = runTest {
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            ThinkingStartEvent(title = "Analyzing problem"),
            ThinkingTextMessageStartEvent(),
            ThinkingTextMessageContentEvent(delta = "Let me think..."),
            ThinkingTextMessageContentEvent(delta = " step by step"),
            ThinkingTextMessageEndEvent(),
            ThinkingEndEvent(),
            RunFinishedEvent(threadId = "t1", runId = "r1")
        )

        val result = events.verifyEvents().toList()
        assertEquals(8, result.size)
    }

    @Test
    fun testCannotStartMultipleThinkingSteps() = runTest {
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            ThinkingStartEvent(),
            ThinkingStartEvent()
        )

        assertFailsWith<AGUIError> {
            events.verifyEvents().toList()
        }.let { error ->
            assertTrue(error.message!!.contains("A thinking step is already in progress"))
        }
    }

    @Test
    fun testCannotEndThinkingWithoutStart() = runTest {
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            ThinkingEndEvent()
        )

        assertFailsWith<AGUIError> {
            events.verifyEvents().toList()
        }.let { error ->
            assertTrue(error.message!!.contains("No active thinking step found"))
        }
    }

    @Test
    fun testCannotStartThinkingMessageWithoutThinkingStep() = runTest {
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            ThinkingTextMessageStartEvent()
        )

        assertFailsWith<AGUIError> {
            events.verifyEvents().toList()
        }.let { error ->
            assertTrue(error.message!!.contains("No active thinking step found"))
        }
    }

    @Test
    fun testCannotStartMultipleThinkingMessages() = runTest {
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            ThinkingStartEvent(),
            ThinkingTextMessageStartEvent(),
            ThinkingTextMessageStartEvent()
        )

        assertFailsWith<AGUIError> {
            events.verifyEvents().toList()
        }.let { error ->
            assertTrue(error.message!!.contains("A thinking text message is already in progress"))
        }
    }

    @Test
    fun testCannotSendThinkingContentWithoutStart() = runTest {
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            ThinkingStartEvent(),
            ThinkingTextMessageContentEvent(delta = "thinking...")
        )

        assertFailsWith<AGUIError> {
            events.verifyEvents().toList()
        }.let { error ->
            assertTrue(error.message!!.contains("No active thinking text message found"))
        }
    }

    @Test
    fun testCannotEndThinkingMessageWithoutStart() = runTest {
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            ThinkingStartEvent(),
            ThinkingTextMessageEndEvent()
        )

        assertFailsWith<AGUIError> {
            events.verifyEvents().toList()
        }.let { error ->
            assertTrue(error.message!!.contains("No active thinking text message found"))
        }
    }

    @Test
    fun testOtherEventsAllowedDuringThinkingMessage() = runTest {
        // TypeScript SDK allows other events during active thinking messages
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            ThinkingStartEvent(),
            ThinkingTextMessageStartEvent(),
            TextMessageStartEvent(messageId = "m1"),
            TextMessageContentEvent(messageId = "m1", delta = "Hello"),
            TextMessageEndEvent(messageId = "m1"),
            ThinkingTextMessageContentEvent(delta = "thinking..."),
            ThinkingTextMessageEndEvent(),
            ThinkingEndEvent(),
            RunFinishedEvent(threadId = "t1", runId = "r1")
        )

        val result = events.verifyEvents().toList()
        assertEquals(10, result.size)
    }

    @Test
    fun testMultipleThinkingCycles() = runTest {
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            // First thinking cycle
            ThinkingStartEvent(title = "First analysis"),
            ThinkingTextMessageStartEvent(),
            ThinkingTextMessageContentEvent(delta = "First thought"),
            ThinkingTextMessageEndEvent(),
            ThinkingEndEvent(),
            // Second thinking cycle
            ThinkingStartEvent(title = "Second analysis"),
            ThinkingTextMessageStartEvent(),
            ThinkingTextMessageContentEvent(delta = "Second thought"),
            ThinkingTextMessageEndEvent(),
            ThinkingEndEvent(),
            RunFinishedEvent(threadId = "t1", runId = "r1")
        )

        val result = events.verifyEvents().toList()
        assertEquals(12, result.size)
    }

    @Test
    fun testThinkingWithoutTextMessages() = runTest {
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            ThinkingStartEvent(title = "Silent thinking"),
            ThinkingEndEvent(),
            RunFinishedEvent(threadId = "t1", runId = "r1")
        )

        val result = events.verifyEvents().toList()
        assertEquals(4, result.size)
    }

    // ========== State Events Tests ==========

    @Test
    fun testStateEventsAllowed() = runTest {
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            StateSnapshotEvent(snapshot = JsonNull),
            StateDeltaEvent(delta = buildJsonArray { }),
            MessagesSnapshotEvent(messages = emptyList()),
            RunFinishedEvent(threadId = "t1", runId = "r1")
        )

        val result = events.verifyEvents().toList()
        assertEquals(5, result.size)
    }

    // ========== Special Events Tests ==========

    @Test
    fun testRawEventsAllowedEverywhere() = runTest {
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            RawEvent(event = JsonNull),
            TextMessageStartEvent(messageId = "m1"),
            RawEvent(event = JsonNull),
            TextMessageContentEvent(messageId = "m1", delta = "Hello"),
            RawEvent(event = JsonNull),
            TextMessageEndEvent(messageId = "m1"),
            RawEvent(event = JsonNull),
            ThinkingStartEvent(),
            RawEvent(event = JsonNull),
            ThinkingTextMessageStartEvent(),
            RawEvent(event = JsonNull),
            ThinkingTextMessageContentEvent(delta = "thinking"),
            RawEvent(event = JsonNull),
            ThinkingTextMessageEndEvent(),
            RawEvent(event = JsonNull),
            ThinkingEndEvent(),
            RawEvent(event = JsonNull),
            RunFinishedEvent(threadId = "t1", runId = "r1")
        )

        val result = events.verifyEvents().toList()
        assertEquals(19, result.size)
    }

    @Test
    fun testCustomEventsAllowed() = runTest {
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            CustomEvent(name = "custom1", value = JsonNull),
            CustomEvent(name = "custom2", value = JsonNull),
            RunFinishedEvent(threadId = "t1", runId = "r1")
        )

        val result = events.verifyEvents().toList()
        assertEquals(4, result.size)
    }

    // ========== Complex Integration Tests ==========

    @Test
    fun testComplexValidSequence() = runTest {
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            StepStartedEvent(stepName = "reasoning"),
            ThinkingStartEvent(title = "Problem analysis"),
            ThinkingTextMessageStartEvent(),
            ThinkingTextMessageContentEvent(delta = "I need to analyze..."),
            ThinkingTextMessageEndEvent(),
            ThinkingEndEvent(),
            TextMessageStartEvent(messageId = "m1"),
            TextMessageContentEvent(messageId = "m1", delta = "Based on my analysis, "),
            TextMessageEndEvent(messageId = "m1"),
            ToolCallStartEvent(toolCallId = "tc1", toolCallName = "get_info"),
            ToolCallArgsEvent(toolCallId = "tc1", delta = "{}"),
            ToolCallEndEvent(toolCallId = "tc1"),
            TextMessageStartEvent(messageId = "m2"),
            TextMessageContentEvent(messageId = "m2", delta = "the answer is 42."),
            TextMessageEndEvent(messageId = "m2"),
            StepFinishedEvent(stepName = "reasoning"),
            RunFinishedEvent(threadId = "t1", runId = "r1")
        )

        val result = events.verifyEvents().toList()
        assertEquals(18, result.size)
    }

    @Test
    fun testDebugLoggingDoesNotAffectValidation() = runTest {
        // Now we test with same message ID since concurrent different IDs is allowed
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            TextMessageStartEvent(messageId = "m1"),
            TextMessageStartEvent(messageId = "m1") // Same ID should still fail
        )

        assertFailsWith<AGUIError> {
            events.verifyEvents(debug = true).toList()
        }.let { error ->
            assertTrue(error.message!!.contains("A text message with ID 'm1' is already in progress"))
        }
    }

    // ========== Edge Cases ==========

    @Test
    fun testEmptyDeltaValidation() {
        // This tests the init block validation, not the verifier
        assertFailsWith<IllegalArgumentException> {
            TextMessageContentEvent(messageId = "m1", delta = "")
        }

        assertFailsWith<IllegalArgumentException> {
            ThinkingTextMessageContentEvent(delta = "")
        }
    }

    @Test
    fun testValidSequenceAfterError() = runTest {
        // Once an error occurs, no more events should be allowed (except RUN_ERROR)
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            RunErrorEvent(message = "Something went wrong")
            // No more events after error
        )

        val result = events.verifyEvents().toList()
        assertEquals(2, result.size)
    }

    @Test
    fun testToolCallResultEventAllowed() = runTest {
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            ToolCallResultEvent(
                messageId = "msg1",
                toolCallId = "tool1",
                content = "Tool result content"
            ),
            RunFinishedEvent(threadId = "t1", runId = "r1")
        )

        val result = events.verifyEvents().toList()
        assertEquals(3, result.size)
        assertTrue(result[1] is ToolCallResultEvent)
        assertEquals("Tool result content", (result[1] as ToolCallResultEvent).content)
    }

    @Test 
    fun testSequenceWithToolCallAndResult() = runTest {
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            ToolCallStartEvent(toolCallId = "tool1", toolCallName = "test_tool"),
            ToolCallArgsEvent(toolCallId = "tool1", delta = "{\"param\":\"value\"}"),
            ToolCallEndEvent(toolCallId = "tool1"),
            ToolCallResultEvent(
                messageId = "msg1", 
                toolCallId = "tool1",
                content = "Success: processed param=value"
            ),
            RunFinishedEvent(threadId = "t1", runId = "r1")
        )

        val result = events.verifyEvents().toList()
        assertEquals(6, result.size)
        assertTrue(result[4] is ToolCallResultEvent)
        assertEquals("Success: processed param=value", (result[4] as ToolCallResultEvent).content)
    }
}