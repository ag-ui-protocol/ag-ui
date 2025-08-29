package com.agui.client

import com.agui.core.types.Message

/**
 * Manages client-side state for conversations.
 * 
 * This interface defines how stateful clients can persist and retrieve
 * conversation history for different threads.
 */
interface ClientStateManager {
    
    /**
     * Stores a message in the conversation history for a thread.
     * 
     * @param threadId The thread ID
     * @param message The message to store
     */
    suspend fun addMessage(threadId: String, message: Message)
    
    /**
     * Retrieves the complete message history for a thread.
     * 
     * @param threadId The thread ID
     * @return List of messages in chronological order
     */
    suspend fun getMessages(threadId: String): List<Message>
    
    /**
     * Clears all messages for a thread.
     * 
     * @param threadId The thread ID
     */
    suspend fun clearMessages(threadId: String)
    
    /**
     * Gets all known thread IDs.
     * 
     * @return Set of thread IDs
     */
    suspend fun getAllThreadIds(): Set<String>
    
    /**
     * Removes all data for a thread.
     * 
     * @param threadId The thread ID
     */
    suspend fun removeThread(threadId: String)
}

/**
 * Simple in-memory implementation of ClientStateManager.
 * 
 * This implementation stores conversation history in memory and is suitable for:
 * - Short-lived applications
 * - Testing scenarios
 * - Applications that don't require persistence across restarts
 */
class SimpleClientStateManager : ClientStateManager {
    
    private val threadMessages = mutableMapOf<String, MutableList<Message>>()
    
    override suspend fun addMessage(threadId: String, message: Message) {
        threadMessages.getOrPut(threadId) { mutableListOf() }.add(message)
    }
    
    override suspend fun getMessages(threadId: String): List<Message> {
        return threadMessages[threadId]?.toList() ?: emptyList()
    }
    
    override suspend fun clearMessages(threadId: String) {
        threadMessages[threadId]?.clear()
    }
    
    override suspend fun getAllThreadIds(): Set<String> {
        return threadMessages.keys.toSet()
    }
    
    override suspend fun removeThread(threadId: String) {
        threadMessages.remove(threadId)
    }
}