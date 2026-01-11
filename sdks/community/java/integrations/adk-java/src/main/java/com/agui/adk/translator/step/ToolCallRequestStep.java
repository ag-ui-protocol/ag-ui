package com.agui.adk.translator.step;

import com.agui.adk.translator.PredictStateMapping;
import com.agui.adk.translator.TranslationContext;
import com.agui.core.event.*;
import com.agui.core.event.TextMessageEndEvent;
import com.google.adk.events.Event;
import com.google.genai.types.Content;
import com.google.genai.types.FunctionCall;
import com.google.genai.types.Part;
import com.google.gson.Gson;
import io.reactivex.rxjava3.core.BackpressureStrategy;
import io.reactivex.rxjava3.core.Flowable;
import org.jetbrains.annotations.NotNull;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

import static com.agui.server.EventFactory.*;

/**
 * A unified processing step for handling all tool call requests from an Event's content parts.
 */
public enum ToolCallRequestStep implements EventTranslationStep {

    INSTANCE;

    private static final Logger logger = LoggerFactory.getLogger(ToolCallRequestStep.class);

    private final Gson gson;

    ToolCallRequestStep() {
        this.gson = new Gson();
    }

    @Override
    public Flowable<BaseEvent> translate(Event event, TranslationContext context) {
        List<FunctionCall> functionCalls = event.content()
                .flatMap(Content::parts)
                .map(parts -> parts.stream()
                        .map(Part::functionCall)
                        .filter(Optional::isPresent)
                        .map(Optional::get)
                        .toList())
                .orElse(List.of());

        if (functionCalls.isEmpty()) {
            return Flowable.empty();
        }

        Flowable<BaseEvent> closeStreamEvent = context.forceCloseStreamingMessage()
                .map(messageId -> {
                    TextMessageEndEvent endEvent = new TextMessageEndEvent();
                    endEvent.setMessageId(messageId);
                    return (BaseEvent) endEvent;
                })
                .map(Flowable::just)
                .orElse(Flowable.empty());

        Flowable<BaseEvent> toolCallEvents = Flowable.fromIterable(functionCalls)
                .concatMap(fc -> translateSingleFunctionCall(fc, context));

        return closeStreamEvent.concatWith(toolCallEvents);
    }

    private Flowable<BaseEvent> translateSingleFunctionCall(FunctionCall functionCall, TranslationContext context) {
        String toolCallId = functionCall.id().orElseGet(() -> UUID.randomUUID().toString());
        String name = functionCall.name().orElseThrow(() -> new IllegalArgumentException("Function call name is empty"));

        trackToolCallStart(toolCallId, name, context);

        Flowable<BaseEvent> predictEvent = emitPredictStateEventIfNeeded(name, toolCallId, context);
        Flowable<BaseEvent> coreToolCallEvents = emitCoreToolCallEvents(functionCall, toolCallId, name);

        return predictEvent.concatWith(coreToolCallEvents)
            .doOnTerminate(() -> finalizeToolCall(context, toolCallId, name));
    }

    private void finalizeToolCall(TranslationContext context, String toolCallId, String name) {
        trackToolCallEnd(toolCallId, context);
        deferConfirmChangesIfNeeded(name, context);
    }

    private void trackToolCallStart(String toolCallId, String name, TranslationContext context) {
        if (context.isActive(toolCallId)) {
            logger.warn("⚠️  DUPLICATE TOOL CALL! Tool call ID {} (name: {}) already exists in active calls!", toolCallId, name);
        }
        context.startTrackingToolCall(toolCallId);
    }

    private void trackToolCallEnd(String toolCallId, TranslationContext context) {
        context.endTrackingToolCall(toolCallId);
    }

    private Flowable<BaseEvent> emitCoreToolCallEvents(FunctionCall functionCall, String toolCallId, String name) {
        return Flowable.create(emitter -> {
            emitter.onNext(createToolCallStartEvent(toolCallId, name));
            functionCall.args().ifPresent(args -> {
                String argsStr = this.gson.toJson(args);
                ToolCallArgsEvent argsEvent = createToolCallArgsEvent(toolCallId, argsStr);
                emitter.onNext(argsEvent);
            });

            ToolCallEndEvent endEvent = createToolCallEndEvent(toolCallId);
            emitter.onNext(endEvent);
            
            emitter.onComplete();
        }, BackpressureStrategy.BUFFER);
    }

    @NotNull
    private static ToolCallEndEvent createToolCallEndEvent(String toolCallId) {
        ToolCallEndEvent endEvent = new ToolCallEndEvent();
        endEvent.setToolCallId(toolCallId);
        return endEvent;
    }

    @NotNull
    private static ToolCallArgsEvent createToolCallArgsEvent(String toolCallId, String argsStr) {
        ToolCallArgsEvent argsEvent = new ToolCallArgsEvent();
        argsEvent.setDelta(argsStr);
        argsEvent.setToolCallId(toolCallId);
        return argsEvent;
    }

    @NotNull
    private static ToolCallStartEvent createToolCallStartEvent(String toolCallId, String name) {
        ToolCallStartEvent startEvent = new ToolCallStartEvent();
        startEvent.setToolCallId(toolCallId);
        startEvent.setToolCallName(name);
        startEvent.setParentMessageId(null);
        return startEvent;
    }

    private Flowable<BaseEvent> emitPredictStateEventIfNeeded(String toolName, String toolCallId, TranslationContext context) {
        if (context.lacksPredictiveStateForTool(toolName) || context.hasEmittedPredictiveStateForTool(toolName)) {
            return Flowable.empty();
        }

        context.addPredictiveStateToolCallId(toolCallId);
        context.markPredictiveStateAsEmittedForTool(toolName);
        
        List<PredictStateMapping> mappings = context.getPredictiveStateMappingsForTool(toolName);
        List<Map<String, Object>> payload = mappings.stream().map(PredictStateMapping::toPayload).toList();

        CustomEvent customEvent = new CustomEvent();
        customEvent.setRawEvent(payload);
        return Flowable.just(customEvent);
    }

    private void deferConfirmChangesIfNeeded(String toolName, TranslationContext context) {
        if (!shouldDeferConfirmChanges(toolName, context)) {
            return;
        }
        performDeferConfirmChanges(toolName, context);
    }

    private boolean shouldDeferConfirmChanges(String toolName, TranslationContext context) {
        if (context.lacksPredictiveStateForTool(toolName) || context.hasEmittedConfirmForTool(toolName)) {
            return false;
        }
        return context.shouldEmitConfirmForTool(toolName);
    }

    private void performDeferConfirmChanges(String toolName, TranslationContext context) {
        String confirmId = UUID.randomUUID().toString();
        List<BaseEvent> deferredEvents = List.of(
            toolCallStartEvent(confirmId, "confirm_changes", null),
            toolCallArgsEvent("{}", confirmId),
            toolCallEndEvent(confirmId)
        );
        context.addDeferredConfirmEvents(deferredEvents);
        context.markConfirmAsEmittedForTool(toolName);
    }
}
