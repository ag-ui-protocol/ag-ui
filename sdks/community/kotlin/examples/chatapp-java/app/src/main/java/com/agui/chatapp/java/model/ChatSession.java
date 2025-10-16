package com.agui.chatapp.java.model;

import androidx.annotation.NonNull;

import java.util.Objects;

/**
 * Represents the current chat session state.
 * Tracks which agent is being used and the thread ID for conversation continuity.
 * This ensures each agent conversation is properly isolated.
 */
public class ChatSession {
    private final String agentId;
    private final String threadId;
    private final long startedAt;
    
    public ChatSession(@NonNull String agentId, @NonNull String threadId, long startedAt) {
        this.agentId = agentId;
        this.threadId = threadId;
        this.startedAt = startedAt;
    }
    
    public ChatSession(@NonNull String agentId, @NonNull String threadId) {
        this(agentId, threadId, System.currentTimeMillis());
    }
    
    @NonNull
    public String getAgentId() {
        return agentId;
    }
    
    @NonNull
    public String getThreadId() {
        return threadId;
    }
    
    public long getStartedAt() {
        return startedAt;
    }
    
    /**
     * Generate a unique thread ID for a new chat session.
     */
    public static String generateThreadId() {
        return "thread_" + System.currentTimeMillis() + "_" + (int)(Math.random() * 1000);
    }
    
    @Override
    public boolean equals(Object obj) {
        if (this == obj) return true;
        if (!(obj instanceof ChatSession)) return false;
        ChatSession that = (ChatSession) obj;
        return startedAt == that.startedAt &&
               Objects.equals(agentId, that.agentId) &&
               Objects.equals(threadId, that.threadId);
    }
    
    @Override
    public int hashCode() {
        return Objects.hash(agentId, threadId, startedAt);
    }
    
    @Override
    public String toString() {
        return "ChatSession{" +
                "agentId='" + agentId + '\'' +
                ", threadId='" + threadId + '\'' +
                ", startedAt=" + startedAt +
                '}';
    }
}