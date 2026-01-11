package com.agui.adk.translator.context;

import com.agui.core.event.BaseEvent;

import java.util.*;

/**
 * Holds all state related to tool calls for a single translation run.
 */
public class ToolState {
    private final Map<String, String> activeToolCalls = new HashMap<>();
    private final Set<String> longRunningToolIds = new HashSet<>(); // Changed to Set and initialized
    private final Set<String> predictiveStateToolCallIds = new HashSet<>();
    private final List<BaseEvent> deferredConfirmEvents = new ArrayList<>();

    // --- Query Methods ---
    public boolean isLongRunningTool(String toolCallId) {
        return longRunningToolIds.contains(toolCallId);
    }

    public boolean isPredictiveStateTool(String toolCallId) {
        return predictiveStateToolCallIds.contains(toolCallId);
    }

    public boolean isActive(String toolCallId) {
        return activeToolCalls.containsKey(toolCallId);
    }
    
    public List<BaseEvent> getAndClearDeferredEvents() {
        if (deferredConfirmEvents.isEmpty()) {
            return List.of();
        }
        List<BaseEvent> events = new ArrayList<>(this.deferredConfirmEvents);
        this.deferredConfirmEvents.clear();
        return events;
    }

    // --- State Mutation Methods ---
    public void populateLongRunningToolIds(Set<String> ids) {
        this.longRunningToolIds.clear();
        this.longRunningToolIds.addAll(ids);
    }

    public void startTrackingToolCall(String toolCallId) {
        this.activeToolCalls.put(toolCallId, toolCallId);
    }

    public void endTrackingToolCall(String toolCallId) {
        this.activeToolCalls.remove(toolCallId);
    }

    public void addPredictiveStateToolCallId(String toolCallId) {
        this.predictiveStateToolCallIds.add(toolCallId);
    }
    
    public void addDeferredConfirmEvents(List<BaseEvent> events) {
        this.deferredConfirmEvents.addAll(events);
    }
}
