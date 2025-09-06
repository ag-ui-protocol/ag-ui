package com.agui.client.chunks

import com.agui.core.types.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.test.runTest
import kotlin.test.*

class ChunkTransformTest {
    
    @Test
    fun testTextMessageChunkCreatesNewSequence() = runTest {
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            TextMessageChunkEvent(
                messageId = "msg1", 
                delta = "Hello"
            ),
            TextMessageChunkEvent(
                messageId = "msg1", 
                delta = " world"
            )
        )
        
        val result = events.transformChunks().toList()
        
        assertEquals(4, result.size)
        assertTrue(result[0] is RunStartedEvent)
        assertTrue(result[1] is TextMessageStartEvent)
        assertEquals("msg1", (result[1] as TextMessageStartEvent).messageId)
        assertTrue(result[2] is TextMessageContentEvent)
        assertEquals("Hello", (result[2] as TextMessageContentEvent).delta)
        assertTrue(result[3] is TextMessageContentEvent)
        assertEquals(" world", (result[3] as TextMessageContentEvent).delta)
    }
    
    @Test
    fun testToolCallChunkCreatesNewSequence() = runTest {
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            ToolCallChunkEvent(
                toolCallId = "tool1",
                toolCallName = "test_tool", 
                delta = "{\"param\":"
            ),
            ToolCallChunkEvent(
                toolCallId = "tool1",
                delta = "\"value\"}"
            )
        )
        
        val result = events.transformChunks().toList()
        
        assertEquals(4, result.size)
        assertTrue(result[0] is RunStartedEvent)
        assertTrue(result[1] is ToolCallStartEvent)
        assertEquals("tool1", (result[1] as ToolCallStartEvent).toolCallId)
        assertEquals("test_tool", (result[1] as ToolCallStartEvent).toolCallName)
        assertTrue(result[2] is ToolCallArgsEvent)
        assertEquals("{\"param\":", (result[2] as ToolCallArgsEvent).delta)
        assertTrue(result[3] is ToolCallArgsEvent)
        assertEquals("\"value\"}", (result[3] as ToolCallArgsEvent).delta)
    }
    
    @Test
    fun testChunkIntegratesWithExistingTextMessage() = runTest {
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            TextMessageStartEvent(messageId = "msg1"),
            TextMessageContentEvent(messageId = "msg1", delta = "Hello"),
            TextMessageChunkEvent(
                messageId = "msg1", 
                delta = " from chunk"
            )
        )
        
        val result = events.transformChunks().toList()
        
        assertEquals(4, result.size)
        assertTrue(result[0] is RunStartedEvent)
        assertTrue(result[1] is TextMessageStartEvent)
        assertTrue(result[2] is TextMessageContentEvent)
        assertEquals("Hello", (result[2] as TextMessageContentEvent).delta)
        assertTrue(result[3] is TextMessageContentEvent)
        assertEquals(" from chunk", (result[3] as TextMessageContentEvent).delta)
    }
    
    @Test
    fun testChunkIntegratesWithExistingToolCall() = runTest {
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            ToolCallStartEvent(toolCallId = "tool1", toolCallName = "test_tool"),
            ToolCallArgsEvent(toolCallId = "tool1", delta = "{\"param\":"),
            ToolCallChunkEvent(
                toolCallId = "tool1",
                delta = "\"value\"}"
            )
        )
        
        val result = events.transformChunks().toList()
        
        assertEquals(4, result.size)
        assertTrue(result[0] is RunStartedEvent)
        assertTrue(result[1] is ToolCallStartEvent)
        assertTrue(result[2] is ToolCallArgsEvent)
        assertEquals("{\"param\":", (result[2] as ToolCallArgsEvent).delta)
        assertTrue(result[3] is ToolCallArgsEvent)
        assertEquals("\"value\"}", (result[3] as ToolCallArgsEvent).delta)
    }
    
    @Test
    fun testTextChunkClosesToolCall() = runTest {
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            ToolCallStartEvent(toolCallId = "tool1", toolCallName = "test_tool"),
            TextMessageChunkEvent(
                messageId = "msg1", 
                delta = "Hello"
            )
        )
        
        val result = events.transformChunks().toList()
        
        assertEquals(5, result.size)
        assertTrue(result[0] is RunStartedEvent)
        assertTrue(result[1] is ToolCallStartEvent)
        assertTrue(result[2] is ToolCallEndEvent)
        assertEquals("tool1", (result[2] as ToolCallEndEvent).toolCallId)
        assertTrue(result[3] is TextMessageStartEvent)
        assertEquals("msg1", (result[3] as TextMessageStartEvent).messageId)
        assertTrue(result[4] is TextMessageContentEvent)
        assertEquals("Hello", (result[4] as TextMessageContentEvent).delta)
    }
    
    @Test
    fun testToolChunkClosesTextMessage() = runTest {
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            TextMessageStartEvent(messageId = "msg1"),
            ToolCallChunkEvent(
                toolCallId = "tool1",
                toolCallName = "test_tool",
                delta = "{}"
            )
        )
        
        val result = events.transformChunks().toList()
        
        assertEquals(5, result.size)
        assertTrue(result[0] is RunStartedEvent)
        assertTrue(result[1] is TextMessageStartEvent)
        assertTrue(result[2] is TextMessageEndEvent)
        assertEquals("msg1", (result[2] as TextMessageEndEvent).messageId)
        assertTrue(result[3] is ToolCallStartEvent)
        assertEquals("tool1", (result[3] as ToolCallStartEvent).toolCallId)
        assertTrue(result[4] is ToolCallArgsEvent)
        assertEquals("{}", (result[4] as ToolCallArgsEvent).delta)
    }
    
    @Test
    fun testMessageIdChangeCreatesNewMessage() = runTest {
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            TextMessageChunkEvent(messageId = "msg1", delta = "First"),
            TextMessageChunkEvent(messageId = "msg2", delta = "Second")
        )
        
        val result = events.transformChunks().toList()
        
        assertEquals(5, result.size)
        assertTrue(result[0] is RunStartedEvent)
        // First message
        assertTrue(result[1] is TextMessageStartEvent)
        assertEquals("msg1", (result[1] as TextMessageStartEvent).messageId)
        assertTrue(result[2] is TextMessageContentEvent)
        assertEquals("First", (result[2] as TextMessageContentEvent).delta)
        // Second message  
        assertTrue(result[3] is TextMessageStartEvent)
        assertEquals("msg2", (result[3] as TextMessageStartEvent).messageId)
        assertTrue(result[4] is TextMessageContentEvent)
        assertEquals("Second", (result[4] as TextMessageContentEvent).delta)
    }
    
    @Test
    fun testToolCallIdChangeCreatesNewToolCall() = runTest {
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            ToolCallChunkEvent(
                toolCallId = "tool1",
                toolCallName = "first_tool", 
                delta = "first"
            ),
            ToolCallChunkEvent(
                toolCallId = "tool2",
                toolCallName = "second_tool",
                delta = "second"
            )
        )
        
        val result = events.transformChunks().toList()
        
        assertEquals(5, result.size)
        assertTrue(result[0] is RunStartedEvent)
        // First tool call
        assertTrue(result[1] is ToolCallStartEvent)
        assertEquals("tool1", (result[1] as ToolCallStartEvent).toolCallId)
        assertEquals("first_tool", (result[1] as ToolCallStartEvent).toolCallName)
        assertTrue(result[2] is ToolCallArgsEvent)
        assertEquals("first", (result[2] as ToolCallArgsEvent).delta)
        // Second tool call
        assertTrue(result[3] is ToolCallStartEvent)
        assertEquals("tool2", (result[3] as ToolCallStartEvent).toolCallId)
        assertEquals("second_tool", (result[3] as ToolCallStartEvent).toolCallName)
        assertTrue(result[4] is ToolCallArgsEvent)
        assertEquals("second", (result[4] as ToolCallArgsEvent).delta)
    }
    
    @Test
    fun testTextChunkWithoutMessageIdThrowsWhenStartingNew() = runTest {
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            TextMessageChunkEvent(delta = "Hello")
        )
        
        assertFailsWith<IllegalArgumentException> {
            events.transformChunks().collect {}
        }
    }
    
    @Test
    fun testToolChunkWithoutRequiredFieldsThrowsWhenStartingNew() = runTest {
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            ToolCallChunkEvent(delta = "args")
        )
        
        assertFailsWith<IllegalArgumentException> {
            events.transformChunks().collect {}
        }
    }
    
    @Test
    fun testChunkWithoutDeltaGeneratesNoContentEvent() = runTest {
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            TextMessageChunkEvent(messageId = "msg1"),
            ToolCallChunkEvent(toolCallId = "tool1", toolCallName = "test_tool")
        )
        
        val result = events.transformChunks().toList()
        
        assertEquals(4, result.size)
        assertTrue(result[0] is RunStartedEvent)
        assertTrue(result[1] is TextMessageStartEvent)
        assertTrue(result[2] is TextMessageEndEvent)
        assertEquals("msg1", (result[2] as TextMessageEndEvent).messageId)
        assertTrue(result[3] is ToolCallStartEvent)
    }
    
    @Test
    fun testTransformPreservesTimestampsAndRawEvents() = runTest {
        val timestamp = 1234567890L
        val events = flowOf(
            RunStartedEvent(threadId = "t1", runId = "r1"),
            TextMessageChunkEvent(
                messageId = "msg1", 
                delta = "Hello",
                timestamp = timestamp
            )
        )
        
        val result = events.transformChunks().toList()
        
        assertEquals(3, result.size)
        assertTrue(result[1] is TextMessageStartEvent)
        assertEquals(timestamp, result[1].timestamp)
        assertTrue(result[2] is TextMessageContentEvent)
        assertEquals(timestamp, result[2].timestamp)
    }
}