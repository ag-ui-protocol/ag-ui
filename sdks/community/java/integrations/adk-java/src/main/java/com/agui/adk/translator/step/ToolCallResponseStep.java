package com.agui.adk.translator.step;

import com.agui.adk.translator.TranslationContext;
import com.google.gson.Gson;
import com.agui.core.event.BaseEvent;
import com.agui.core.event.ToolCallResultEvent;
import com.google.adk.events.Event;
import com.google.genai.types.FunctionResponse;
import io.reactivex.rxjava3.core.Flowable;
import org.jetbrains.annotations.NotNull;

import java.util.List;
import java.util.UUID;

/**
 * A processing step for handling function/tool responses from an ADK Event.
 */
public enum ToolCallResponseStep implements EventTranslationStep {

    INSTANCE;

    private final Gson gson;

    ToolCallResponseStep() {
        this.gson = new Gson();
    }

    @Override
    public Flowable<BaseEvent> translate(Event event, TranslationContext context) {
        List<FunctionResponse> functionResponses = event.functionResponses();

        if (functionResponses == null || functionResponses.isEmpty()) {
            return Flowable.empty();
        }

        return Flowable.fromIterable(functionResponses)
            .filter(response -> shouldEmitToolCallResult(context, response))
            .map(this::createToolCallResultEvent);
    }

    @NotNull
    private ToolCallResultEvent createToolCallResultEvent(FunctionResponse response) {
        String toolCallId = response.id().orElseGet(() -> UUID.randomUUID().toString());
        // Serialize the response content to a JSON string
        String contentJson = this.gson.toJson(response.response().orElse(null));

        ToolCallResultEvent toolCallResultEvent = new ToolCallResultEvent();
        toolCallResultEvent.setMessageId(UUID.randomUUID().toString());
        toolCallResultEvent.setToolCallId(toolCallId);
        toolCallResultEvent.setContent(contentJson);
        return toolCallResultEvent;
    }

    private static boolean shouldEmitToolCallResult(TranslationContext context, FunctionResponse response) {
        // Skip creating events for tool calls that are long-running or handled by predictive state,
        // as per the original implementation's logic.
        String toolCallId = response.id().orElse("");
        boolean isLongRunning = context.isLongRunningTool(toolCallId); // Corrected typo here
        boolean isPredictive = context.isPredictiveStateTool(toolCallId);
        return !isLongRunning && !isPredictive;
    }
}
