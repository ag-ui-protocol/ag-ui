package com.agui.adk.translator.context;

import com.agui.adk.translator.PredictStateMapping;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;

/**
 * Holds configuration and state for predictive state features for a single translation run.
 */
public class PredictiveState {
    private final Map<String, List<PredictStateMapping>> mappingsByToolName; // Renamed
    private final Set<String> emittedForTools;
    private final Set<String> emittedConfirmForTools;

    /**
     * Constructs a new PredictiveState instance and populates its configuration.
     * @param config The list of PredictStateMapping to configure this state.
     */
    public PredictiveState(List<PredictStateMapping> config) {
        List<PredictStateMapping> mappings = (config != null) ? new ArrayList<>(config) : new ArrayList<>();
        this.emittedForTools = new HashSet<>();
        this.emittedConfirmForTools = new HashSet<>();
        this.mappingsByToolName = mappings.stream()
                .collect(Collectors.groupingBy(PredictStateMapping::toolName));
    }

    // --- Query Methods ---
    public boolean hasToolConfig(String toolName) {
        return mappingsByToolName.containsKey(toolName); // Renamed
    }
    
    public boolean hasEmittedForTool(String toolName) {
        return emittedForTools.contains(toolName);
    }

    public boolean hasEmittedConfirmForTool(String toolName) {
        return emittedConfirmForTools.contains(toolName);
    }

    public boolean shouldEmitConfirmForTool(String toolName) {
        return mappingsByToolName.getOrDefault(toolName, List.of()) // Renamed
                     .stream()
                     .anyMatch(PredictStateMapping::emitConfirmTool);
    }

    public List<PredictStateMapping> getMappingsForTool(String toolName) {
        return mappingsByToolName.getOrDefault(toolName, List.of()); // Renamed
    }

    // --- State Mutation Methods ---
    public void markAsEmittedForTool(String toolName) {
        emittedForTools.add(toolName);
    }

    public void markAsEmittedConfirmForTool(String toolName) {
        emittedConfirmForTools.add(toolName);
    }
}
