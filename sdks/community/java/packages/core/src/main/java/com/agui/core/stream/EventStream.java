package com.agui.core.stream;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;
import java.util.logging.Logger;

/**
 * Concrete implementation of {@link IEventStream} that provides thread-safe event stream processing
 * with customizable handlers for data, errors, and completion.
 * <p>
 * This implementation uses callback functions to handle stream events and provides robust
 * error handling with protection against infinite error loops. All operations are thread-safe
 * and use atomic operations combined with synchronization to ensure consistent state management.
 * </p>
 * <p>
 * Example usage:
 * </p>
 * <pre>{@code
 * EventStream<String> stream = new EventStream<>(
 *     item -> System.out.println("Received: " + item),
 *     error -> System.err.println("Error: " + error.getMessage()),
 *     () -> System.out.println("Stream completed")
 * );
 *
 * stream.next("Hello");
 * stream.next("World");
 * stream.complete();
 * }</pre>
 *
 * @param <T> the type of items processed by this stream
 *
 * @author Pascal Wilbrink
 */
public class EventStream<T> implements IEventStream<T> {
    private final Consumer<T> onNext;
    private final Consumer<Throwable> onError;
    private final Runnable onComplete;
    private final AtomicBoolean cancelled = new AtomicBoolean(false);
    private final AtomicBoolean completed = new AtomicBoolean(false);
    private final Object lock = new Object();

    private final Logger logger = Logger.getLogger(EventStream.class.getName());

    /**
     * Creates a new EventStream with the specified handlers.
     * <p>
     * Any of the handlers can be null, in which case the corresponding events will be ignored.
     * </p>
     *
     * @param onNext     the handler for processing stream items, may be null
     * @param onError    the handler for processing errors, may be null
     * @param onComplete the handler for stream completion, may be null
     */
    public EventStream(
        Consumer<T> onNext,
        Consumer<Throwable> onError,
        Runnable onComplete
    ) {
        this.onNext = onNext;
        this.onError = onError;
        this.onComplete = onComplete;
    }

    /**
     * {@inheritDoc}
     * <p>
     * This implementation is thread-safe and will silently ignore items if the stream
     * has been cancelled or completed. If the onNext handler throws an exception,
     * it will be automatically converted to an error event using {@link #error(Throwable)}.
     * </p>
     */
    @Override
    public void next(T item) {
        synchronized (lock) {
            if (cancelled.get() || completed.get() || onNext == null) {
                return;
            }

            try {
                onNext.accept(item);
            } catch (Exception e) {
                // Call error without lock to avoid potential deadlock
                CompletableFuture.runAsync(() -> error(e));
            }
        }
    }

    /**
     * {@inheritDoc}
     * <p>
     * This implementation marks the stream as completed when an error occurs and provides
     * protection against infinite error loops. If the error handler itself throws an exception,
     * </p>
     */
    @Override
    public void error(Throwable error) {
        synchronized (lock) {
            if (cancelled.get() || completed.get() || onError == null) {
                return;
            }

            completed.set(true); // Mark as completed first

            try {
                onError.accept(error);
            } catch (Exception e) {
                logger.severe("Error in error handler: " + e.getMessage());
                e.printStackTrace();
            }
        }
    }

    /**
     * {@inheritDoc}
     * <p>
     * This implementation uses atomic operations to ensure the completion handler is called
     * exactly once, even in multi-threaded scenarios. If the completion handler throws an
     * exception, it is logged to System.err without affecting the stream's completed state.
     * </p>
     */
    @Override
    public void complete() {
        synchronized (lock) {
            if (cancelled.get() || completed.getAndSet(true) || onComplete == null) {
                return;
            }

            try {
                onComplete.run();
            } catch (Exception e) {
                logger.severe("Error in complete handler: " + e.getMessage());
                e.printStackTrace();
            }
        }
    }

    /**
     * {@inheritDoc}
     */
    @Override
    public boolean isCancelled() {
        return cancelled.get();
    }

    /**
     * {@inheritDoc}
     * <p>
     * This implementation is thread-safe and idempotent. Once cancelled, the stream
     * will ignore all further events including next, error, and complete calls.
     * </p>
     */
    @Override
    public void cancel() {
        synchronized (lock) {
            cancelled.set(true);
        }
    }

    /**
     * Checks whether this stream has completed successfully or with an error.
     * <p>
     * A stream is considered completed if {@link #complete()} or {@link #error(Throwable)}
     * has been called. This is different from {@link #isCancelled()} which indicates
     * user-initiated termination.
     * </p>
     *
     * @return {@code true} if the stream has completed, {@code false} otherwise
     */
    public boolean isCompleted() {
        return completed.get();
    }
}
