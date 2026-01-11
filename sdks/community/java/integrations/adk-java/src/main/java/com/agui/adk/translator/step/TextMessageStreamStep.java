package com.agui.adk.translator.step;

import com.agui.adk.translator.TranslationContext;
import com.agui.core.event.BaseEvent;
import com.agui.core.event.TextMessageContentEvent;
import com.agui.core.event.TextMessageEndEvent;
import com.agui.core.event.TextMessageStartEvent;
import com.google.adk.events.Event;
import com.google.genai.types.Content;
import io.reactivex.rxjava3.core.Flowable;
import org.jetbrains.annotations.NotNull;

import java.util.Optional;
import java.util.UUID;
import java.util.stream.Collectors;

/**
 * A processing step that handles the translation of text content from an ADK Event,
 * including complex streaming, finalization, and deduplication logic.
 */
public enum TextMessageStreamStep implements EventTranslationStep {

    INSTANCE; // The single, guaranteed-unique instance

    @Override
    public Flowable<BaseEvent> translate(Event event, TranslationContext context) {
        return Flowable.defer(() -> {
            String combinedText = aggregateTextFromEvent(event);
            if (combinedText.isEmpty() && !event.finalResponse()) {
                return Flowable.empty();
            }

            return event.finalResponse() ? handleFinalResponse(combinedText, context) : handleNormalStreaming(event, combinedText, context);
        });
    }

    private String aggregateTextFromEvent(Event event) {
        return event.content()
            .flatMap(Content::parts)
            .map(parts -> parts.stream()
                .map(part -> part.text().orElse(""))
                .collect(Collectors.joining()))
            .orElse("");
    }

    private Flowable<BaseEvent> handleFinalResponse(String combinedText, TranslationContext context) {
        Flowable<BaseEvent> closeStreamEvent = context.forceCloseStreamingMessage()
                .map(messageId -> {
                    TextMessageEndEvent endEvent = createTextMessageEndEvent(messageId);
                    return (BaseEvent) endEvent;
                })
                .map(Flowable::just)
                .orElse(Flowable.empty());

        return context.handleDuplicateOrEmptyStream(combinedText)
                .map(this::emitCompleteMessage)
                .map(closeStreamEvent::concatWith)
                .orElse(closeStreamEvent);
    }

    private Flowable<BaseEvent> emitCompleteMessage(String text) {
        // Emits a full START/CONTENT/END block for a non-streamed final response.
        String messageId = UUID.randomUUID().toString();
        return Flowable.concat(
            Flowable.just(createTextMessageStartEvent(messageId, "assistant")),
            Flowable.just(createTextMessageContentEvent(messageId, text)),
            Flowable.just(createTextMessageEndEvent(messageId))
        );
    }

    @NotNull
    private static TextMessageContentEvent createTextMessageContentEvent(String messageId, String text) {
        TextMessageContentEvent textMessageContentEvent = new TextMessageContentEvent();
        textMessageContentEvent.setMessageId(messageId);
        textMessageContentEvent.setDelta(text);
        return textMessageContentEvent;
    }

    @NotNull
    private static TextMessageStartEvent createTextMessageStartEvent(String messageId, String role) {
        TextMessageStartEvent textMessageStartEvent = new TextMessageStartEvent();
        textMessageStartEvent.setMessageId(messageId);
        textMessageStartEvent.setRole(role);
        return textMessageStartEvent;
    }

    @NotNull
    private static TextMessageEndEvent createTextMessageEndEvent(String messageId) {
        TextMessageEndEvent textMessageEndEvent = new TextMessageEndEvent();
        textMessageEndEvent.setMessageId(messageId);
        return textMessageEndEvent;
    }

    private Flowable<BaseEvent> handleNormalStreaming(Event event, String combinedText, TranslationContext context) {
        boolean shouldEnd = shouldEndStream(event, context);

        Flowable<BaseEvent> startEvent = startStreamIfNeeded(context);
        Flowable<BaseEvent> contentEvent = emitContent(event, combinedText, context);
        Flowable<BaseEvent> endEvent = endStreamIfNeeded(shouldEnd, context);

        return Flowable.concat(startEvent, contentEvent, endEvent);
    }

    private boolean shouldEndStream(Event event, TranslationContext context) {
        boolean isPartial = event.partial().orElse(false);
        boolean turnComplete = event.turnComplete().orElse(false);
        boolean hasFinishReason = event.finishReason().isPresent();
        boolean finalResponse = event.finalResponse();

        return (turnComplete && !isPartial)
            || (finalResponse && !isPartial)
            || (hasFinishReason && context.isStreaming());
    }

    private Flowable<BaseEvent> startStreamIfNeeded(TranslationContext context) {
        return context.startStreamingIfNeeded()
                .map(newStreamId -> (BaseEvent) createTextMessageStartEvent(newStreamId, "assistant"))
                .map(Flowable::just)
                .orElse(Flowable.empty());
    }

    private Flowable<BaseEvent> emitContent(Event event, String combinedText, TranslationContext context) {
        return Optional.of(combinedText)
                .filter(text -> !text.isEmpty())
                .filter(text -> {
                    boolean isPartial = event.partial().orElse(false);
                    return !context.isStreaming() || isPartial;
                })
                .map(text -> {
                    context.appendToCurrentStreamText(text);
                    return context.getStreamingMessageId()
                            .map(messageId -> (BaseEvent) createTextMessageContentEvent(messageId, text))
                            .map(Flowable::just)
                            .orElse(Flowable.empty());
                })
                .orElse(Flowable.empty());
    }

    private Flowable<BaseEvent> endStreamIfNeeded(boolean shouldEnd, TranslationContext context) {
        if (!shouldEnd) {
            return Flowable.empty();
        }
        
        return context.getStreamingMessageId()
                .map(messageId -> {
                    context.endStream();
                    return (BaseEvent) createTextMessageEndEvent(messageId);
                })
                .map(Flowable::just)
                .orElse(Flowable.empty());
    }
}
