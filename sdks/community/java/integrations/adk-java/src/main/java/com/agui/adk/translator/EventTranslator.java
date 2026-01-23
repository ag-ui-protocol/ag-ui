package com.agui.adk.translator;

import com.agui.adk.translator.step.EventTranslationStep;
import com.agui.core.event.BaseEvent;
import com.google.adk.events.Event;
import io.reactivex.rxjava3.annotations.NonNull;
import io.reactivex.rxjava3.core.Flowable;
import io.reactivex.rxjava3.core.FlowableTransformer;
import org.reactivestreams.Publisher;

import java.util.List;

/**
 * A stateful transformer, created once per agent run, that translates a stream of ADK Events
 * into a full, compliant stream of AG-UI BaseEvents, including start, finish, and deferred events.
 * This class acts as the Composite root and a reactive operator.
 */
public class EventTranslator implements FlowableTransformer<Event, BaseEvent> {

    private final TranslationContext context;
    private final List<EventTranslationStep> eventTranslationSteps;

    /**
     * A public constructor to be called by the {@link EventTranslatorFactory}.
     * @param context The stateful context for this specific run.
     * @param eventTranslationSteps The ordered list of translation steps for the composite.
     */
    public EventTranslator(TranslationContext context, List<EventTranslationStep> eventTranslationSteps) {
        this.context = context;
        this.eventTranslationSteps = eventTranslationSteps;
    }

    /**
     * The main entry point from the reactive stream, applying the full translation lifecycle.
     * @param upstream The upstream flow of ADK Events.
     * @return The downstream flow of translated AG-UI BaseEvents.
     */
    @Override
    @NonNull
    public Publisher<BaseEvent> apply(@NonNull Flowable<Event> upstream) {
        Flowable<BaseEvent> mainTranslationStream = upstream
                .concatMap(this::translate);

        Flowable<BaseEvent> deferredEvents = Flowable.defer(() ->
            Flowable.fromIterable(this.getAndClearDeferredConfirmEvents())
        );

        // Compose the final stream, letting the adapter handle Start/Finish events.
        return mainTranslationStream.concatWith(deferredEvents);
    }
    
    /**
     * Translates a single event by delegating to the child steps.
     * @param event The ADK Event to translate.
     * @return A Flowable of generated BaseEvents.
     */
    public Flowable<BaseEvent> translate(Event event) {
        // Set long-running tool IDs from the ADK event to the context
        event.longRunningToolIds().ifPresent(this.context::populateLongRunningToolIds);

        // This is the composite pattern logic. It uses its own internal context.
        return Flowable.fromIterable(eventTranslationSteps) // Updated field name
                .concatMap(child -> child.translate(event, this.context));
    }

    /**
     * Retrieves and clears any events that were deferred during the run.
     * @return A list of deferred events.
     */
    public List<BaseEvent> getAndClearDeferredConfirmEvents() {
        return this.context.getAndClearDeferredConfirmEvents();
    }
}
