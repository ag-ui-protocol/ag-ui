package com.agui.client

import com.agui.core.types.*
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.datetime.Clock
import kotlin.test.*

class StatefulAgUiAgentTest {
    
    @Test
    fun testConversationHistoryMaintained() = runTest {
        // Create a mock agent that echoes back the number of messages it receives
        val mockAgent = MockStatefulAgent()
        
        // Send first message
        val events1 = mockAgent.sendMessage("Hello", "thread1").toList()
        assertEquals(1, mockAgent.lastMessageCount, "First message should have 1 message")
        
        // Send second message on same thread
        val events2 = mockAgent.sendMessage("How are you?", "thread1").toList()
        assertEquals(3, mockAgent.lastMessageCount, "Second message should have 3 messages (user + assistant + user)")
        
        // Send third message on same thread
        val events3 = mockAgent.sendMessage("Goodbye", "thread1").toList()
        assertEquals(5, mockAgent.lastMessageCount, "Third message should have 5 messages (user + assistant + user + assistant + user)")
    }
    
    @Test
    fun testSeparateThreadsHaveSeparateHistory() = runTest {
        val mockAgent = MockStatefulAgent()
        
        // Send messages on thread 1
        mockAgent.sendMessage("Hello", "thread1").toList()
        mockAgent.sendMessage("How are you?", "thread1").toList()
        assertEquals(3, mockAgent.lastMessageCount)  // user + assistant + user
        
        // Send message on thread 2 - should start fresh
        mockAgent.sendMessage("New conversation", "thread2").toList()
        assertEquals(1, mockAgent.lastMessageCount, "New thread should start with 1 message")
        
        // Back to thread 1 - should have full history
        mockAgent.sendMessage("Back to thread 1", "thread1").toList()
        assertEquals(5, mockAgent.lastMessageCount, "Thread 1 should have its history (user + assistant + user + assistant + user)")
    }
    
    @Test
    fun testSystemPromptAddedOnlyOnce() = runTest {
        val mockAgent = MockStatefulAgent(systemPrompt = "You are a helpful assistant")
        
        // Send first message
        mockAgent.sendMessage("Hello", "thread1").toList()
        val messages1 = mockAgent.lastMessages
        assertEquals(2, messages1.size, "Should have system + user message")
        assertTrue(messages1[0] is SystemMessage)
        assertEquals("You are a helpful assistant", messages1[0].content)
        
        // Send second message
        mockAgent.sendMessage("How are you?", "thread1").toList()
        val messages2 = mockAgent.lastMessages
        assertEquals(4, messages2.size, "Should have system + user + assistant + user messages")
        assertTrue(messages2[0] is SystemMessage, "System message should still be first")
        
        // Verify only one system message
        val systemMessageCount = messages2.count { it is SystemMessage }
        assertEquals(1, systemMessageCount, "Should only have one system message")
    }
    
    @Test
    fun testHistoryLengthLimit() = runTest {
        val mockAgent = MockStatefulAgent(maxHistoryLength = 3)
        
        // Send 5 messages
        repeat(5) { i ->
            mockAgent.sendMessage("Message $i", "thread1").toList()
        }
        
        // With history limit of 3, after 5 messages we should have fewer messages
        assertTrue(mockAgent.lastMessageCount <= 5, "History should be limited but may include assistant messages")
        
        // The actual conversation history should also be limited
        val history = mockAgent.getHistory("thread1")
        assertTrue(history.size <= 6, "History should be trimmed (up to 3 user + 3 assistant messages)")
    }
    
    @Test
    fun testHistoryLengthLimitWithSystemPrompt() = runTest {
        val mockAgent = MockStatefulAgent(
            systemPrompt = "System prompt",
            maxHistoryLength = 3
        )
        
        // Send 5 messages
        repeat(5) { i ->
            mockAgent.sendMessage("Message $i", "thread1").toList()
        }
        
        // With system prompt + history limit, should have reasonable number of messages
        assertTrue(mockAgent.lastMessageCount <= 5, "History should be limited but may include system + assistant messages")
        val messages = mockAgent.lastMessages
        assertTrue(messages[0] is SystemMessage, "System message should be preserved")
        assertEquals("System prompt", messages[0].content)
        
        // The actual history should also respect the limit
        val history = mockAgent.getHistory("thread1")
        assertTrue(history.size <= 5, "History should be trimmed while preserving system message")
    }
    
    @Test
    fun testClearHistory() = runTest {
        val mockAgent = MockStatefulAgent()
        
        // Send messages on two threads
        mockAgent.sendMessage("Thread 1 message", "thread1").toList()
        mockAgent.sendMessage("Thread 2 message", "thread2").toList()
        
        // Clear specific thread
        mockAgent.clearHistory("thread1")
        
        // Thread 1 should be empty
        mockAgent.sendMessage("New message", "thread1").toList()
        assertEquals(1, mockAgent.lastMessageCount, "Thread 1 should start fresh after clear")
        
        // Thread 2 should still have history
        mockAgent.sendMessage("Another message", "thread2").toList()
        assertEquals(3, mockAgent.lastMessageCount, "Thread 2 should retain history (1 original user + 1 assistant + 1 new user)")
        
        // Clear all
        mockAgent.clearHistory()
        mockAgent.sendMessage("Fresh start", "thread2").toList()
        assertEquals(1, mockAgent.lastMessageCount, "All threads should be cleared")
    }
    
    @Test
    fun testGetHistory() = runTest {
        val mockAgent = MockStatefulAgent()
        
        // Send messages
        mockAgent.sendMessage("Message 1", "thread1").toList()
        mockAgent.sendMessage("Message 2", "thread1").toList()
        
        // Get history
        val history = mockAgent.getHistory("thread1")
        assertEquals(4, history.size)  // user + assistant + user + assistant
        assertEquals("Message 1", history[0].content)
        assertTrue(history[1] is AssistantMessage)
        assertEquals("Message 2", history[2].content)
        assertTrue(history[3] is AssistantMessage)
        
        // Get history for non-existent thread
        val emptyHistory = mockAgent.getHistory("nonexistent")
        assertTrue(emptyHistory.isEmpty())
    }
    
    @Test
    fun testAssistantMessagesAddedToHistory() = runTest {
        val mockAgent = MockStatefulAgent()
        
        // Send a message and simulate assistant response
        val events = mockAgent.sendMessage("Hello", "thread1").toList()
        
        // Verify assistant message was captured
        val history = mockAgent.getHistory("thread1")
        assertEquals(2, history.size, "Should have user + assistant message")
        assertTrue(history[0] is UserMessage)
        assertTrue(history[1] is AssistantMessage)
        assertEquals("Assistant response to: Hello", (history[1] as AssistantMessage).content)
    }
    
    /**
     * Mock agent that extends StatefulAgUiAgent for testing
     */
    private class MockStatefulAgent(
        systemPrompt: String? = null,
        maxHistoryLength: Int = 100
    ) : StatefulAgUiAgent("http://mock-url", {
        this.systemPrompt = systemPrompt
        this.maxHistoryLength = maxHistoryLength
    }) {
        var lastMessages: List<Message> = emptyList()
        var lastMessageCount: Int = 0
        
        override fun run(input: RunAgentInput): Flow<BaseEvent> {
            // Capture the messages for verification
            lastMessages = input.messages
            lastMessageCount = input.messages.size
            
            // Simulate agent response
            return flow {
                // Emit run started
                emit(RunStartedEvent(
                    threadId = input.threadId,
                    runId = input.runId
                ))
                
                // Find the last user message
                val lastUserMessage = input.messages.lastOrNull { it is UserMessage }
                if (lastUserMessage != null) {
                    // Emit assistant response
                    val messageId = "msg_${Clock.System.now().toEpochMilliseconds()}"
                    emit(TextMessageStartEvent(messageId = messageId))
                    emit(TextMessageContentEvent(
                        messageId = messageId,
                        delta = "Assistant response to: ${lastUserMessage.content}"
                    ))
                    emit(TextMessageEndEvent(messageId = messageId))
                }
                
                // Emit run finished
                emit(RunFinishedEvent(
                    threadId = input.threadId,
                    runId = input.runId
                ))
            }
        }
    }
}