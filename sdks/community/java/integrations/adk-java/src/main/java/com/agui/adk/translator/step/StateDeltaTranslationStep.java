package com.agui.adk.translator.step;

import com.agui.adk.translator.TranslationContext;
import com.agui.core.event.BaseEvent;
import com.agui.core.event.StateDeltaEvent;
import com.google.adk.events.Event;
import io.reactivex.rxjava3.core.Flowable;
import org.jetbrains.annotations.NotNull;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentMap;

/**
 * A processing step for handling the 'stateDelta' part of an ADK Event.
 */
public enum StateDeltaTranslationStep implements EventTranslationStep {
    INSTANCE;

    @Override
    public Flowable<BaseEvent> translate(Event event, TranslationContext context) {
        return Optional.ofNullable(event.actions().stateDelta())
            .filter(deltaMap -> !deltaMap.isEmpty())
            .map(StateDeltaTranslationStep::createStateDeltaEventFlowable)
            .orElse(Flowable.empty());
    }

    @NotNull
    private static Flowable<BaseEvent> createStateDeltaEventFlowable(ConcurrentMap<String, Object> delta) {
        return Flowable.fromCallable(() -> createStateDeltaEvent(delta));
    }

    @NotNull
    private static StateDeltaEvent createStateDeltaEvent(ConcurrentMap<String, Object> delta) {
        List<Map<String, Object>> patches = delta.entrySet().stream()
                .map(StateDeltaTranslationStep::createAddPatchMap)
                .toList();
        StateDeltaEvent stateDeltaEvent = new StateDeltaEvent();
        stateDeltaEvent.setRawEvent(patches);
        return stateDeltaEvent;
    }

    @NotNull
    private static Map<String, Object> createAddPatchMap(Map.Entry<String, Object> entry) {
        return Map.<String, Object>of(
                "op", "add",
                "path", "/" + entry.getKey(),
                "value", entry.getValue()
        );
    }
}