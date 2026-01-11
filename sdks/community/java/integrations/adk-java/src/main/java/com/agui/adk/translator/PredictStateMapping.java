package com.agui.adk.translator;

import java.util.Collections;
import java.util.Map;

/**
 * A configuration record that defines predictive state behavior for a specific tool.
 * This class corresponds to the `PredictStateMapping` dataclass from the original implementation.
 */
public record PredictStateMapping(String toolName, boolean emitConfirmTool, Map<String, Object> toPayload) {
    /**
     * Canonical constructor that performs a defensive copy of the toPayload map to ensure deep immutability.
     * @param toolName The name of the tool this mapping applies to.
     * @param emitConfirmTool Whether to emit a deferred confirm_changes tool call.
     * @param toPayload The payload for the PredictState CustomEvent.
     */
    public PredictStateMapping(String toolName, boolean emitConfirmTool, Map<String, Object> toPayload) {
        this.toolName = toolName;
        this.emitConfirmTool = emitConfirmTool;
        // Defensive copy: create a new HashMap and then make it unmodifiable.
        // This ensures the internal map cannot be modified by external references.
        this.toPayload = (toPayload != null) ? Map.copyOf(toPayload) : Collections.emptyMap();
    }
}
