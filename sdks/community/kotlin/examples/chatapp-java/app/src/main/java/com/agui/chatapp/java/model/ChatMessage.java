package com.agui.chatapp.java.model;

import com.agui.core.types.Message;
import com.agui.core.types.Role;

import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;

/**
 * UI model for chat messages that wraps the AG-UI Message type.
 * Provides additional UI-specific properties and formatting.
 */
public class ChatMessage {
    private final String id;
    private final Role role;
    private final String content;
    private final String name;
    private final LocalDateTime timestamp;
    private boolean isStreaming;
    
    // Message state for streaming
    private StringBuilder streamingContent;
    
    public ChatMessage(Message message) {
        this.id = message.getId();
        this.role = message.getMessageRole();
        this.content = message.getContent();
        this.name = message.getName();
        this.timestamp = LocalDateTime.now();
        this.isStreaming = false;
        this.streamingContent = null;
    }
    
    public ChatMessage(String id, Role role, String content, String name) {
        this.id = id;
        this.role = role;
        this.content = content;
        this.name = name;
        this.timestamp = LocalDateTime.now();
        this.isStreaming = false;
        this.streamingContent = null;
    }
    
    // Create a streaming message
    public static ChatMessage createStreaming(String id, Role role, String name) {
        ChatMessage message = new ChatMessage(id, role, "", name);
        message.isStreaming = true;
        message.streamingContent = new StringBuilder();
        return message;
    }
    
    public String getId() {
        return id;
    }
    
    public Role getRole() {
        return role;
    }
    
    public String getContent() {
        if (streamingContent != null) {
            return streamingContent.toString();
        }
        return content != null ? content : "";
    }
    
    public String getName() {
        return name;
    }
    
    public LocalDateTime getTimestamp() {
        return timestamp;
    }
    
    public boolean isStreaming() {
        return isStreaming && streamingContent != null;
    }
    
    public String getFormattedTimestamp() {
        return timestamp.format(DateTimeFormatter.ofPattern("h:mm a"));
    }
    
    public String getSenderDisplayName() {
        if (name != null && !name.isEmpty()) {
            return name;
        }
        
        switch (role) {
            case USER:
                return "You";
            case ASSISTANT:
                return "Assistant";
            case SYSTEM:
                return "System";
            case DEVELOPER:
                return "Developer";
            case TOOL:
                return "Tool";
            default:
                return "Unknown";
        }
    }
    
    /**
     * Append content to a streaming message
     * @param delta The content to append
     */
    public void appendStreamingContent(String delta) {
        if (streamingContent != null) {
            streamingContent.append(delta);
        }
    }
    
    /**
     * Finish streaming and finalize the message content
     */
    public void finishStreaming() {
        if (streamingContent != null) {
            // Content is now final, streaming is complete
            isStreaming = false;
            // Keep the streamed content by updating the content field
            // Note: We can't change the final content field, so we keep streamingContent
        }
    }
    
    /**
     * Check if this is a user message
     */
    public boolean isUser() {
        return role == Role.USER;
    }
    
    /**
     * Check if this is an assistant message
     */
    public boolean isAssistant() {
        return role == Role.ASSISTANT;
    }
    
    /**
     * Check if this is a system message
     */
    public boolean isSystem() {
        return role == Role.SYSTEM;
    }
    
    /**
     * Check if this message has content to display
     */
    public boolean hasContent() {
        String messageContent = getContent();
        return messageContent != null && !messageContent.trim().isEmpty();
    }
    
    @Override
    public boolean equals(Object obj) {
        if (this == obj) return true;
        if (obj == null || getClass() != obj.getClass()) return false;
        ChatMessage that = (ChatMessage) obj;
        return id.equals(that.id);
    }
    
    @Override
    public int hashCode() {
        return id.hashCode();
    }
    
    @Override
    public String toString() {
        return "ChatMessage{" +
                "id='" + id + '\'' +
                ", role=" + role +
                ", content='" + getContent() + '\'' +
                ", timestamp=" + timestamp +
                ", isStreaming=" + isStreaming() +
                '}';
    }
}