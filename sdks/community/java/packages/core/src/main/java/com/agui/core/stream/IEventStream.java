package com.agui.core.stream;

/**
 * Interface for handling reactive event streams with support for data emission, error handling, and completion.
 * <p>
 * This interface follows the reactive streams pattern, allowing consumers to handle a stream of events
 * of type {@code T}. The stream can emit multiple items, terminate with an error, or complete successfully.
 * It also supports cancellation to stop processing early.
 * </p>
 * <p>
 * Typical usage pattern:
 * </p>
 * <pre>{@code
 * IEventStream<String> stream = ...;
 *
 * // Process items as they arrive
 * stream.next("item1");
 * stream.next("item2");
 *
 * // Complete the stream
 * stream.complete();
 * }</pre>
 *
 * @param <T> the type of items emitted by this stream
 *
 * @author Pascal Wilbrink
 */
public interface IEventStream<T> {

    /**
     * Emits the next item in the stream.
     * <p>
     * This method is called for each new item that becomes available in the stream.
     * Implementations should handle the item immediately and not block for extended periods.
     * </p>
     *
     * @param item the next item to process, may be null depending on the stream implementation
     * @throws IllegalStateException if the stream has been completed, cancelled, or encountered an error
     */
    void next(T item);

    /**
     * Signals that an error has occurred in the stream.
     * <p>
     * Once this method is called, the stream is considered terminated and no further
     * {@link #next(Object)} or {@link #complete()} calls should be made.
     * </p>
     *
     * @param error the error that occurred, must not be null
     * @throws IllegalStateException if the stream has already been completed or cancelled
     */
    void error(Throwable error);

    /**
     * Signals successful completion of the stream.
     * <p>
     * This indicates that no more items will be emitted and the stream has ended normally.
     * Once called, no further {@link #next(Object)} or {@link #error(Throwable)} calls should be made.
     * </p>
     *
     * @throws IllegalStateException if the stream has already been completed, cancelled, or encountered an error
     */
    void complete();

    /**
     * Checks whether this stream has been cancelled.
     * <p>
     * A cancelled stream will not process any further items and should be considered terminated.
     * </p>
     *
     * @return {@code true} if the stream has been cancelled, {@code false} otherwise
     */
    boolean isCancelled();

    /**
     * Cancels the stream, stopping any further processing.
     * <p>
     * After cancellation, the stream should not emit any more items, errors, or completion signals.
     * This method is idempotent - calling it multiple times has the same effect as calling it once.
     * </p>
     * <p>
     * Implementations should clean up any resources and stop background processing when this method is called.
     * </p>
     */
    void cancel();
}