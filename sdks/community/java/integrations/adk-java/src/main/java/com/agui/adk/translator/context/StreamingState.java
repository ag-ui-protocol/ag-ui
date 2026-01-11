package com.agui.adk.translator.context;

import java.util.Optional;
import java.util.UUID;

/**
 * Holds all state related to text streaming for a single translation run.
 */
public class StreamingState {
    private String messageId = null;
    private boolean isStreaming = false;
    private String currentText = "";
    private String lastStreamedText = null;
    private String lastStreamedRunId = null;

    // --- Getters ---
    public Optional<String> getMessageId() { return Optional.ofNullable(messageId); }
    public boolean isStreaming() { return isStreaming; }
    public String getLastStreamedText() { return lastStreamedText; }
    public String getLastStreamedRunId() { return lastStreamedRunId; }

    // --- State Mutation Methods ---

    /**
     * Starts a new stream if one is not already active.
     *
     * @return The new message ID if a stream was started, otherwise null.
     */
    public Optional<String> startStreaming() {
        if (this.isStreaming) {
            return Optional.empty();
        }
        this.isStreaming = true;
        this.messageId = UUID.randomUUID().toString();
        this.currentText = "";
        return Optional.of(this.messageId);
    }

    public void appendToCurrentText(String text) {
        if (text != null) {
            this.currentText += text;
        }
    }

    /**
     * Ends the current stream, updating the history for deduplication.
     */
    public void endStream(String runId) {
        if (!this.currentText.isEmpty()) {
            this.lastStreamedText = this.currentText;
            this.lastStreamedRunId = runId;
        }
        this.isStreaming = false;
        this.messageId = null;
        this.currentText = "";
    }
    
    /**
     * Resets the deduplication history.
     */
    public void resetHistory() {
        this.lastStreamedText = null;
        this.lastStreamedRunId = null;
    }
}
