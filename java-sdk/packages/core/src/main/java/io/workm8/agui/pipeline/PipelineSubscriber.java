package io.workm8.agui.pipeline;

@FunctionalInterface
public interface PipelineSubscriber<T> {
    void onNext(T item);

    default void onError(Throwable error) {
        // Default implementation - can be overridden
        throw new RuntimeException("Unhandled pipeline error", error);
    }

    default void onComplete() {
        // Default empty implementation
    }
}