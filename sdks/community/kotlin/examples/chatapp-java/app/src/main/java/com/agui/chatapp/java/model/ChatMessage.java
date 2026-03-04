package com.agui.chatapp.java.model;

import com.agui.example.chatapp.chat.DisplayMessage;
import com.agui.example.chatapp.chat.MessageRole;

import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;

/**
 * UI wrapper around the shared DisplayMessage.
 */
public final class ChatMessage {
    private static final DateTimeFormatter TIME_FORMATTER = DateTimeFormatter.ofPattern("h:mm a");

    private final String id;
    private final MessageRole role;
    private final String content;
    private final boolean streaming;
    private final String senderDisplayName;
    private final long timestampMillis;

    public ChatMessage(DisplayMessage message) {
        this.id = message.getId();
        this.role = message.getRole();
        this.content = message.getContent();
        this.streaming = message.isStreaming();
        this.senderDisplayName = message.getEphemeralType() != null
                ? message.getEphemeralType().name()
                : defaultDisplayName(role);
        this.timestampMillis = message.getTimestamp();
    }

    public String getId() {
        return id;
    }

    public MessageRole getRole() {
        return role;
    }

    public String getContent() {
        return content != null ? content : "";
    }

    public boolean isStreaming() {
        return streaming;
    }

    public String getSenderDisplayName() {
        return senderDisplayName;
    }

    public String getFormattedTimestamp() {
        Instant instant = Instant.ofEpochMilli(timestampMillis);
        return TIME_FORMATTER.format(instant.atZone(ZoneId.systemDefault()));
    }

    private static String defaultDisplayName(MessageRole role) {
        if (role == null) return "";
        switch (role) {
            case USER:
                return "You";
            case ASSISTANT:
                return "Assistant";
            case SYSTEM:
                return "System";
            case ERROR:
                return "Error";
            case TOOL_CALL:
                return "Tool";
            case STEP_INFO:
                return "Step";
            default:
                return "";
        }
    }
}
