package com.agui.chatapp.java.model;

import org.junit.Test;
import static org.junit.Assert.*;

/**
 * Unit tests for ChatSession.
 */
public class ChatSessionTest {

    @Test
    public void testChatSessionConstruction() {
        long startTime = System.currentTimeMillis();
        
        ChatSession session = new ChatSession("agent-123", "thread-456", startTime);
        
        assertEquals("agent-123", session.getAgentId());
        assertEquals("thread-456", session.getThreadId());
        assertEquals(startTime, session.getStartedAt());
    }

    @Test
    public void testChatSessionConstructionWithDefaultTime() {
        long beforeCreation = System.currentTimeMillis();
        
        ChatSession session = new ChatSession("agent-123", "thread-456");
        
        long afterCreation = System.currentTimeMillis();
        
        assertEquals("agent-123", session.getAgentId());
        assertEquals("thread-456", session.getThreadId());
        assertTrue(session.getStartedAt() >= beforeCreation);
        assertTrue(session.getStartedAt() <= afterCreation);
    }

    @Test
    public void testChatSessionEquality() {
        long startTime = System.currentTimeMillis();
        
        ChatSession session1 = new ChatSession("agent-123", "thread-456", startTime);
        ChatSession session2 = new ChatSession("agent-123", "thread-456", startTime);
        ChatSession session3 = new ChatSession("agent-456", "thread-456", startTime);
        ChatSession session4 = new ChatSession("agent-123", "thread-789", startTime);
        ChatSession session5 = new ChatSession("agent-123", "thread-456", startTime + 1000);
        
        // Same values should be equal
        assertEquals(session1, session2);
        assertEquals(session1.hashCode(), session2.hashCode());
        
        // Different agent ID
        assertNotEquals(session1, session3);
        
        // Different thread ID
        assertNotEquals(session1, session4);
        
        // Different start time
        assertNotEquals(session1, session5);
        
        // Null check
        assertNotEquals(session1, null);
        
        // Different class
        assertNotEquals(session1, "not a session");
        
        // Self equality
        assertEquals(session1, session1);
    }

    @Test
    public void testGenerateThreadId() throws InterruptedException {
        String threadId1 = ChatSession.generateThreadId();
        Thread.sleep(1); // Small delay to ensure different timestamps
        String threadId2 = ChatSession.generateThreadId();
        
        assertNotNull(threadId1);
        assertNotNull(threadId2);
        assertNotEquals(threadId1, threadId2); // Should be unique
        assertTrue(threadId1.startsWith("thread_"));
        assertTrue(threadId2.startsWith("thread_"));
        
        // Should match format: thread_{timestamp}_{random}
        assertTrue(threadId1.matches("thread_\\d+_\\d+"));
        assertTrue(threadId2.matches("thread_\\d+_\\d+"));
        
        // Extract timestamp parts (between "thread_" and second "_")
        String[] parts1 = threadId1.split("_");
        String[] parts2 = threadId2.split("_");
        
        assertEquals(3, parts1.length); // Should have exactly 3 parts: "thread", timestamp, random
        assertEquals(3, parts2.length);
        
        long timestamp1 = Long.parseLong(parts1[1]);
        long timestamp2 = Long.parseLong(parts2[1]);
        
        assertTrue(timestamp1 > 0);
        assertTrue(timestamp2 > 0);
        assertTrue(timestamp2 >= timestamp1); // Should be same or later
        
        // Verify random parts are different (highly likely but not guaranteed)
        // This helps ensure uniqueness even with same timestamp
        int random1 = Integer.parseInt(parts1[2]);
        int random2 = Integer.parseInt(parts2[2]);
        assertTrue(random1 >= 0 && random1 < 1000);
        assertTrue(random2 >= 0 && random2 < 1000);
    }

    @Test
    public void testChatSessionToString() {
        ChatSession session = new ChatSession("agent-123", "thread-456", 1234567890L);
        
        String toString = session.toString();
        assertNotNull(toString);
        assertTrue(toString.contains("ChatSession"));
        assertTrue(toString.contains("agent-123"));
        assertTrue(toString.contains("thread-456"));
        assertTrue(toString.contains("1234567890"));
    }

    @Test
    public void testChatSessionWithLongIds() {
        // Test with longer, more realistic IDs
        String agentId = "agent_1703123456789_5432";
        String threadId = "thread_1703123456890";
        
        ChatSession session = new ChatSession(agentId, threadId);
        
        assertEquals(agentId, session.getAgentId());
        assertEquals(threadId, session.getThreadId());
        assertTrue(session.getStartedAt() > 0);
    }

    @Test
    public void testChatSessionImmutability() {
        ChatSession session = new ChatSession("agent-123", "thread-456");
        
        // Verify that getters return the same values consistently
        String agentId1 = session.getAgentId();
        String agentId2 = session.getAgentId();
        assertEquals(agentId1, agentId2);
        
        String threadId1 = session.getThreadId();
        String threadId2 = session.getThreadId();
        assertEquals(threadId1, threadId2);
        
        long startTime1 = session.getStartedAt();
        long startTime2 = session.getStartedAt();
        assertEquals(startTime1, startTime2);
    }
}