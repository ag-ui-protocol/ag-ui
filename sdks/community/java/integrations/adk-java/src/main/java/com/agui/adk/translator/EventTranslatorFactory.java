package com.agui.adk.translator;

import com.agui.adk.translator.step.*;

import java.util.Collections;
import java.util.List;

/**
 * A factory responsible for creating and configuring a new, stateful
 * {@link EventTranslator} for each agent run. Implemented as a robust JVM singleton.
 */
public enum EventTranslatorFactory {
    INSTANCE; // The single instance of this singleton factory

    private final List<EventTranslationStep> eventTranslationSteps;

    // The constructor is automatically private and called by the JVM
    private EventTranslatorFactory() {
        // Manually build the fixed, ordered, and simplified pipeline of steps.
        this.eventTranslationSteps = List.of(
            TextMessageStreamStep.INSTANCE,
            ToolCallRequestStep.INSTANCE,
            ToolCallResponseStep.INSTANCE,
            StateDeltaTranslationStep.INSTANCE
        );
    }

    /**
     * Creates a new EventTranslator instance for a specific agent run.
     *
     * @param threadId The ID of the conversation thread for this run.
     * @param runId The unique ID for this specific run.
     * @param predictStateConfig The configuration for predictive state.
     * @return A new, configured EventTranslator instance.
     */
    public EventTranslator create(String threadId, String runId, List<PredictStateMapping> predictStateConfig) {
        TranslationContext context = new TranslationContext(threadId, runId, predictStateConfig);
        
        return new EventTranslator(context, this.eventTranslationSteps);
    }

    /**
     * Overloaded factory method for when there is no predictive state configuration.
     */
    public EventTranslator create(String threadId, String runId) {
        return create(threadId, runId, List.of());
    }
}
