package com.agui.client

import com.agui.core.types.*
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.test.runTest
import kotlinx.datetime.Clock
import kotlin.test.*

/**
 * Integration tests for StatefulAgUiAgent with persistent user IDs
 */
class IntegrationTest {
    
    @Test
    fun testPersistentUserIdWithConversationHistory() = runTest {
        val userId = "user_integration_test_12345"
        
        // Create agent with persistent user ID
        val agent = MockIntegrationAgent(userId)
        
        // Send multiple messages
        agent.sendMessage("First message", "thread1").toList()
        agent.sendMessage("Second message", "thread1").toList()
        agent.sendMessage("Third message", "thread1").toList()
        
        // Verify all messages have the same user ID
        val history = agent.getHistory("thread1")
        val userMessages = history.filterIsInstance<UserMessage>()
        
        assertEquals(3, userMessages.size)
        assertTrue(userMessages.all { it.id == userId }, "All messages should have the same user ID")
        
        // Verify conversation history is maintained
        assertEquals("First message", userMessages[0].content)
        assertEquals("Second message", userMessages[1].content)
        assertEquals("Third message", userMessages[2].content)
    }
    
    @Test
    fun testUserIdConsistencyAcrossThreadsWithHistory() = runTest {
        val userId = "user_cross_thread_67890"
        
        val agent = MockIntegrationAgent(userId)
        
        // Build history on thread 1
        agent.sendMessage("Thread1 Msg1", "thread1").toList()
        agent.sendMessage("Thread1 Msg2", "thread1").toList()
        
        // Build history on thread 2
        agent.sendMessage("Thread2 Msg1", "thread2").toList()
        agent.sendMessage("Thread2 Msg2", "thread2").toList()
        
        // Verify user ID consistency
        val thread1History = agent.getHistory("thread1")
        val thread2History = agent.getHistory("thread2")
        
        val thread1Users = thread1History.filterIsInstance<UserMessage>()
        val thread2Users = thread2History.filterIsInstance<UserMessage>()
        
        // All messages should have the same user ID
        assertTrue(thread1Users.all { it.id == userId })
        assertTrue(thread2Users.all { it.id == userId })
        
        // Histories should be separate
        assertEquals(2, thread1Users.size)
        assertEquals(2, thread2Users.size)
        assertNotEquals(thread1Users[0].content, thread2Users[0].content)
    }
    
    @Test
    fun testHistoryWithSystemPromptAndPersistentUserId() = runTest {
        val userId = "user_with_system_11111"
        val systemPrompt = "You are a helpful test assistant"
        
        val agent = MockIntegrationAgent(userId, systemPrompt)
        
        // Send messages
        agent.sendMessage("Hello", "thread1").toList()
        agent.sendMessage("How are you?", "thread1").toList()
        
        val history = agent.getHistory("thread1")
        
        // Verify structure
        assertTrue(history[0] is SystemMessage)
        assertTrue(history[0].id.startsWith("sys_"))
        assertEquals(systemPrompt, history[0].content)
        
        // Verify user messages have persistent ID
        val userMessages = history.filterIsInstance<UserMessage>()
        assertEquals(2, userMessages.size)
        assertTrue(userMessages.all { it.id == userId })
    }
    
    
    @Test
    fun testAgentRecreationWithSameUserId() = runTest {
        val userId = "user_persistent_across_agents_33333"
        
        // Create first agent and send messages
        val agent1 = MockIntegrationAgent(userId)
        agent1.sendMessage("From agent 1", "thread1").toList()
        val agent1Messages = agent1.capturedMessages
        
        // Create second agent with same user ID
        val agent2 = MockIntegrationAgent(userId)
        agent2.sendMessage("From agent 2", "thread2").toList()
        val agent2Messages = agent2.capturedMessages
        
        // Both agents should use the same user ID
        val agent1User = agent1Messages.filterIsInstance<UserMessage>().first()
        val agent2User = agent2Messages.filterIsInstance<UserMessage>().first()
        
        assertEquals(userId, agent1User.id)
        assertEquals(userId, agent2User.id)
        assertEquals(agent1User.id, agent2User.id)
    }
    
    @Test
    fun testClearHistoryDoesNotAffectUserId() = runTest {
        val userId = "user_clear_history_44444"
        
        val agent = MockIntegrationAgent(userId)
        
        // Build history
        agent.sendMessage("Message 1", "thread1").toList()
        agent.sendMessage("Message 2", "thread1").toList()
        
        // Clear history
        agent.clearHistory("thread1")
        
        // Send new message
        agent.sendMessage("After clear", "thread1").toList()
        
        val history = agent.getHistory("thread1")
        assertTrue(history.size <= 2, "After clear, should have at most user + assistant message")
        
        // User ID should still be the same
        val userMessage = history.filterIsInstance<UserMessage>().first()
        assertEquals(userId, userMessage.id)
    }
    
    @Test
    fun testMultipleAgentsWithDifferentUserIds() = runTest {
        val userId1 = "user_agent1_55555"
        val userId2 = "user_agent2_66666"
        
        val agent1 = MockIntegrationAgent(userId1)
        val agent2 = MockIntegrationAgent(userId2)
        
        // Send messages from both agents
        agent1.sendMessage("From user 1", "thread1").toList()
        agent2.sendMessage("From user 2", "thread2").toList()
        
        // Verify each agent uses its own user ID
        val agent1User = agent1.capturedMessages.filterIsInstance<UserMessage>().first()
        val agent2User = agent2.capturedMessages.filterIsInstance<UserMessage>().first()
        
        assertEquals(userId1, agent1User.id)
        assertEquals(userId2, agent2User.id)
        assertNotEquals(agent1User.id, agent2User.id)
    }
    
    @Test
    fun testAssistantResponsesInHistoryWithPersistentUserId() = runTest {
        val userId = "user_with_assistant_77777"
        
        val agent = MockIntegrationAgent(userId)
        
        // Send messages and get responses
        agent.sendMessage("Hello", "thread1").toList()
        agent.sendMessage("How are you?", "thread1").toList()
        
        val history = agent.getHistory("thread1")
        
        // Should have alternating user/assistant messages
        assertEquals(4, history.size) // 2 user + 2 assistant
        
        // Verify pattern
        assertTrue(history[0] is UserMessage)
        assertTrue(history[1] is AssistantMessage)
        assertTrue(history[2] is UserMessage)
        assertTrue(history[3] is AssistantMessage)
        
        // All user messages should have persistent ID
        val userMessages = history.filterIsInstance<UserMessage>()
        assertTrue(userMessages.all { it.id == userId })
        
        // Assistant messages should have different IDs
        val assistantMessages = history.filterIsInstance<AssistantMessage>()
        assertTrue(assistantMessages.all { it.id.startsWith("msg_") })
        assertNotEquals(assistantMessages[0].id, assistantMessages[1].id)
    }
    
    /**
     * Mock agent for integration testing
     */
    private class MockIntegrationAgent(
        private val userId: String,
        systemPrompt: String? = null,
        maxHistoryLength: Int = 100
    ) : StatefulAgUiAgent("http://mock-integration-url", {
        this.userId = userId
        this.systemPrompt = systemPrompt
        this.maxHistoryLength = maxHistoryLength
    }) {
        
        var capturedMessages: List<Message> = emptyList()
        private var messageCounter = 0
        
        override fun run(input: RunAgentInput): Flow<BaseEvent> {
            capturedMessages = input.messages
            
            return flow {
                emit(RunStartedEvent(threadId = input.threadId, runId = input.runId))
                
                // Find last user message and simulate assistant response
                val lastUserMessage = input.messages.lastOrNull { it is UserMessage }
                if (lastUserMessage != null) {
                    val messageId = "msg_${Clock.System.now().toEpochMilliseconds()}_${++messageCounter}"
                    emit(TextMessageStartEvent(messageId = messageId))
                    emit(TextMessageContentEvent(
                        messageId = messageId,
                        delta = "Response to: ${lastUserMessage.content}"
                    ))
                    emit(TextMessageEndEvent(messageId = messageId))
                }
                
                emit(RunFinishedEvent(threadId = input.threadId, runId = input.runId))
            }
        }
    }
}