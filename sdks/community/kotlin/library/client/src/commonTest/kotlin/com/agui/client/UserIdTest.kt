package com.agui.client

import com.agui.core.types.*
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import kotlinx.datetime.Clock
import kotlin.test.*

class UserIdTest {
    
    @Test
    fun testUserIdFromConfig() = runTest {
        val customUserId = "user_custom_12345"
        
        // Test with base AgUiAgent
        val agent = TestableAgUiAgent("http://test-url") {
            userId = customUserId
        }
        
        val events = agent.sendMessage("Hello").toList()
        val capturedMessage = agent.lastCapturedMessage
        
        assertNotNull(capturedMessage)
        assertEquals(customUserId, capturedMessage.id, "User message should use configured userId")
    }
    
    @Test
    fun testUserIdGeneratedWhenNotProvided() = runTest {
        // Test without providing userId
        val agent = TestableAgUiAgent("http://test-url")
        
        val events = agent.sendMessage("Hello").toList()
        val capturedMessage = agent.lastCapturedMessage
        
        assertNotNull(capturedMessage)
        assertTrue(capturedMessage.id.startsWith("usr_"), "Generated userId should start with 'usr_'")
    }
    
    @Test
    fun testStatefulAgentUsesConfiguredUserId() = runTest {
        val customUserId = "user_stateful_67890"
        
        val agent = TestableStatefulAgent("http://test-url") {
            userId = customUserId
        }
        
        // Send multiple messages
        agent.sendMessage("Message 1", "thread1").toList()
        agent.sendMessage("Message 2", "thread1").toList()
        
        // Check all user messages have the same userId
        val messages = agent.lastMessages
        val userMessages = messages.filterIsInstance<UserMessage>()
        
        assertEquals(2, userMessages.size)
        userMessages.forEach { message ->
            assertEquals(customUserId, message.id, "All user messages should have the configured userId")
        }
    }
    
    @Test
    fun testUserIdConsistentAcrossThreads() = runTest {
        val customUserId = "user_persistent_11111"
        
        val agent = TestableStatefulAgent("http://test-url") {
            userId = customUserId
        }
        
        // Send messages on different threads
        agent.sendMessage("Thread 1 message", "thread1").toList()
        val thread1Messages = agent.lastMessages
        
        agent.sendMessage("Thread 2 message", "thread2").toList()
        val thread2Messages = agent.lastMessages
        
        // Extract user messages from both threads
        val thread1User = thread1Messages.filterIsInstance<UserMessage>().first()
        val thread2User = thread2Messages.filterIsInstance<UserMessage>().first()
        
        assertEquals(customUserId, thread1User.id, "Thread 1 should use configured userId")
        assertEquals(customUserId, thread2User.id, "Thread 2 should use same userId")
        assertEquals(thread1User.id, thread2User.id, "UserId should be consistent across threads")
    }
    
    @Test
    fun testUserIdNotAffectedBySystemMessages() = runTest {
        val customUserId = "user_with_system_22222"
        
        val agent = TestableStatefulAgent("http://test-url") {
            userId = customUserId
            systemPrompt = "You are a test assistant"
        }
        
        agent.sendMessage("Hello", "thread1").toList()
        val messages = agent.lastMessages
        
        // Verify system message has different ID format
        val systemMessage = messages.filterIsInstance<SystemMessage>().first()
        val userMessage = messages.filterIsInstance<UserMessage>().first()
        
        assertTrue(systemMessage.id.startsWith("sys_"), "System message should have sys_ prefix")
        assertEquals(customUserId, userMessage.id, "User message should have configured userId")
        assertNotEquals(systemMessage.id, userMessage.id, "System and user messages should have different IDs")
    }
    
    /**
     * Test agent that captures messages for verification
     */
    private class TestableAgUiAgent(
        url: String,
        configure: AgUiAgentConfig.() -> Unit = {}
    ) : AgUiAgent(url, configure) {
        var lastCapturedMessage: UserMessage? = null
        
        override fun run(input: RunAgentInput): Flow<BaseEvent> {
            // Capture the user message
            lastCapturedMessage = input.messages.filterIsInstance<UserMessage>().lastOrNull()
            
            return flow {
                emit(RunStartedEvent(threadId = input.threadId, runId = input.runId))
                emit(RunFinishedEvent(threadId = input.threadId, runId = input.runId))
            }
        }
    }
    
    /**
     * Test stateful agent that captures all messages
     */
    private class TestableStatefulAgent(
        url: String,
        configure: StatefulAgUiAgentConfig.() -> Unit = {}
    ) : StatefulAgUiAgent(url, configure) {
        var lastMessages: List<Message> = emptyList()
        
        override fun run(input: RunAgentInput): Flow<BaseEvent> {
            lastMessages = input.messages
            
            return flow {
                emit(RunStartedEvent(threadId = input.threadId, runId = input.runId))
                
                // Simulate assistant response
                val messageId = "msg_${Clock.System.now().toEpochMilliseconds()}"
                emit(TextMessageStartEvent(messageId = messageId))
                emit(TextMessageContentEvent(messageId = messageId, delta = "Test response"))
                emit(TextMessageEndEvent(messageId = messageId))
                
                emit(RunFinishedEvent(threadId = input.threadId, runId = input.runId))
            }
        }
    }
}