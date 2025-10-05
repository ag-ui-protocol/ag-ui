package com.agui.core.subscription;

/**
 * Represents a subscription to a stream or observable that can be cancelled.
 * <p>
 * The Subscription interface provides a standard way to manage subscriptions to
 * event streams, data sources, or other observable entities. It follows the
 * reactive streams pattern by providing a simple unsubscribe mechanism.
 * <p>
 * Implementations should ensure that:
 * <ul>
 * <li>Unsubscribing is idempotent (calling multiple times is safe)</li>
 * <li>Resources are properly cleaned up when unsubscribed</li>
 * <li>The subscription immediately stops receiving events after unsubscribing</li>
 * <li>The operation is thread-safe if the subscription may be accessed concurrently</li>
 * </ul>
 * <p>
 * Example usage:
 * <pre>{@code
 * Subscription subscription = eventSource.subscribe(event -> {
 *     // Handle event
 * });
 *
 * // Later, when no longer needed
 * subscription.unsubscribe();
 * }</pre>
 *
 * @author Pascal Wilbrink
 */
public interface Subscription {
    
    /**
     * Cancels the subscription and stops receiving events.
     * <p>
     * After calling this method, the subscriber should no longer receive any events
     * from the source. This method should clean up any resources associated with
     * the subscription and is safe to call multiple times.
     * <p>
     * Implementations should make this method idempotent, meaning that calling
     * unsubscribe multiple times should have the same effect as calling it once.
     */
    void unsubscribe();
}
