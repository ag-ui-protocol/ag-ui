package com.agui.adk.translator;

import com.agui.adk.translator.context.PredictiveState;
import com.agui.adk.translator.context.StreamingState;
import com.agui.adk.translator.context.ToolState;
import com.agui.core.event.BaseEvent;

import java.util.List;
import java.util.Optional;
import java.util.Set;

/**
 * A context class to hold the state for a single translation run.
 * It acts as a Facade, providing a clean API to the underlying state sub-contexts.
 */
public class TranslationContext {
    // Per-run identifiers, remain at the top level
    private final String threadId;
    private final String runId;

    // --- Sub-Context Composition ---
    private final StreamingState streamingState;
    private final ToolState toolState;
    private final PredictiveState predictiveState;

    /**
     * Constructs a new context for a single agent run.
     * @param threadId The ID of the conversation thread for this run.
     * @param runId The unique ID for this specific run.
     * @param predictStateConfig The configuration for predictive state.
     */
    public TranslationContext(String threadId, String runId, List<PredictStateMapping> predictStateConfig) {
        this.threadId = threadId;
        this.runId = runId;
        
        this.streamingState = new StreamingState();
        this.toolState = new ToolState();
        this.predictiveState = new PredictiveState(predictStateConfig);
    }

    /**
     * Convenience constructor for when there is no predictive state configuration.
     */
    public TranslationContext(String threadId, String runId) {
        this(threadId, runId, List.of());
    }

    public String getThreadId() {
        return threadId;
    }

    public String getRunId() {
        return runId;
    }
    
    // --- Public Facade Methods ---

    // StreamingState Facade
    public boolean isStreaming() { return streamingState.isStreaming(); }
    public Optional<String> getStreamingMessageId() { return streamingState.getMessageId(); }
    public Optional<String> forceCloseStreamingMessage() {
        return getStreamingMessageId().map(messageId -> {
            streamingState.endStream(this.runId); // Pass runId for history
            return messageId;
        });
    }

    public Optional<String> handleDuplicateOrEmptyStream(String combinedText) {
        if (isDuplicateStream(combinedText) || combinedText.isEmpty()) {
            resetStreamingHistory();
            return Optional.empty();
        }
        return Optional.of(combinedText);
    }

    public boolean isDuplicateStream(String combinedText) {
        return runId.equals(streamingState.getLastStreamedRunId()) &&
               streamingState.getLastStreamedText() != null &&
               (combinedText.equals(streamingState.getLastStreamedText()) || streamingState.getLastStreamedText().endsWith(combinedText));
    }

    public void resetStreamingHistory() {
        streamingState.resetHistory();
    }
    
    public void endStream() {
        streamingState.endStream(this.runId);
    }

    // ToolState Facade
    public void startTrackingToolCall(String toolCallId) { toolState.startTrackingToolCall(toolCallId); }
    public void endTrackingToolCall(String toolCallId) { toolState.endTrackingToolCall(toolCallId); }
    public void addPredictiveStateToolCallId(String toolCallId) { toolState.addPredictiveStateToolCallId(toolCallId); }
    public void populateLongRunningToolIds(Set<String> ids) { toolState.populateLongRunningToolIds(ids); }
    public boolean isLongRunningTool(String toolCallId) { return toolState.isLongRunningTool(toolCallId); }
    public boolean isPredictiveStateTool(String toolCallId) { return toolState.isPredictiveStateTool(toolCallId); }
    public void addDeferredConfirmEvents(List<BaseEvent> events) { toolState.addDeferredConfirmEvents(events); }
    public List<BaseEvent> getAndClearDeferredConfirmEvents() { return toolState.getAndClearDeferredEvents(); }

    // PredictiveState Facade
    public boolean lacksPredictiveStateForTool(String toolName) { return !predictiveState.hasToolConfig(toolName); }
    public boolean hasEmittedPredictiveStateForTool(String toolName) { return predictiveState.hasEmittedForTool(toolName); }
    public void markPredictiveStateAsEmittedForTool(String toolName) { predictiveState.markAsEmittedForTool(toolName); }
    public List<PredictStateMapping> getPredictiveStateMappingsForTool(String toolName) { return predictiveState.getMappingsForTool(toolName); }
    public boolean shouldEmitConfirmForTool(String toolName) { return predictiveState.shouldEmitConfirmForTool(toolName); }
    public boolean hasEmittedConfirmForTool(String toolName) { return predictiveState.hasEmittedConfirmForTool(toolName); }
    public void markConfirmAsEmittedForTool(String toolName) { predictiveState.markAsEmittedConfirmForTool(toolName); }
    public Optional<String> startStreamingIfNeeded() { return streamingState.startStreaming(); }
    public void appendToCurrentStreamText(String text) {
        streamingState.appendToCurrentText(text);
    }

    public boolean isActive(String toolCallId) {
        return toolState.isActive(toolCallId);
    }
}
