package io.workm8.agui.client.stream;

public interface IEventStream<T> {
    void next(T item);
    void error(Throwable error);
    void complete();
    boolean isCancelled();
    void cancel();
}
