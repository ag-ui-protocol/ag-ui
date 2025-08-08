package io.workm8.agui.pipeline;

@FunctionalInterface
public interface PipelineEmitter<T> {
    void subscribe(PipelineSubscriber<T> subscriber);
}

