package com.agui.adk;

import com.agui.core.event.BaseEvent;
import com.google.adk.events.Event;
import com.google.genai.types.FunctionCall;
import com.google.genai.types.Part;
import com.google.gson.Gson;
import io.reactivex.rxjava3.core.BackpressureStrategy;
import io.reactivex.rxjava3.core.Flowable;
import org.reactivestreams.Publisher;

import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import static com.agui.server.EventFactory.*;

public class EventTranslator {

    private final AtomicReference<String> streamingMessageId = new AtomicReference<>();
    private final AtomicBoolean isStreaming = new AtomicBoolean(false);
    private final Gson gson = new Gson();

    public Publisher<BaseEvent> translate(Event adkEvent) {
        return Flowable.defer(() -> {
            if (adkEvent.content().isPresent() && adkEvent.content().get().parts().isPresent()) {
                return Flowable.fromIterable(adkEvent.content().get().parts().get())
                    .concatMap(this::translatePart);
            }
            return Flowable.empty();
        });
    }

    private Publisher<BaseEvent> translatePart(Part part) {
        if (part.text().isPresent() && !part.text().get().isEmpty()) {
            return translateText(part.text().get());
        } else if (part.functionCall().isPresent()) {
            return translateFunctionCall(part.functionCall().get());
        }
        return Flowable.empty();
    }

    private Publisher<BaseEvent> translateText(String text) {
        return Flowable.create(emitter -> {
            if (isStreaming.compareAndSet(false, true)) {
                streamingMessageId.set(UUID.randomUUID().toString());
                emitter.onNext(textMessageStartEvent(streamingMessageId.get(), "assistant"));
            }
            emitter.onNext(textMessageContentEvent(streamingMessageId.get(), text));
            emitter.onComplete();
        }, BackpressureStrategy.BUFFER);
    }

    private Publisher<BaseEvent> translateFunctionCall(FunctionCall functionCall) {
        return Flowable.create(emitter -> {
            if (isStreaming.compareAndSet(false, true)) {
                streamingMessageId.set(UUID.randomUUID().toString());
            }
            String toolCallId = functionCall.id().orElse(UUID.randomUUID().toString());
            String name = functionCall.name().orElseThrow(() -> new IllegalArgumentException("Function call name is empty"));
            emitter.onNext(toolCallStartEvent(streamingMessageId.get(), name, toolCallId));

            functionCall.args().ifPresent(args -> emitter.onNext(toolCallArgsEvent(gson.toJson(args), toolCallId )));
            emitter.onNext(toolCallEndEvent(toolCallId));
            emitter.onComplete();
        }, BackpressureStrategy.BUFFER);
    }

    public Flowable<BaseEvent> forceCloseStreamingMessage() {
        if (isStreaming.compareAndSet(true, false)) {
            return Flowable.just(textMessageEndEvent(streamingMessageId.get()));
        }
        return Flowable.empty();
    }
}
