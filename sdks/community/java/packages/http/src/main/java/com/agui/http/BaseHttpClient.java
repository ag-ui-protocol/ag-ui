package com.agui.http;

import com.agui.core.agent.RunAgentInput;
import com.agui.core.event.BaseEvent;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;

/**
 * Abstract base class for HTTP clients that facilitate agent communication with remote services.
 * <p>
 * This class provides the fundamental contract for HTTP-based agent execution, including
 * event streaming capabilities and resource management. Implementations handle the specific
 * details of HTTP communication, request/response processing, and event stream management
 * while providing a consistent interface for agent execution.
 * <p>
 * The class supports cancellable operations through the use of cancellation tokens,
 * allowing for graceful interruption of long-running HTTP requests and event streams.
 * <p>
 * Subclasses must implement the specific HTTP client logic, including:
 * <ul>
 * <li>HTTP request construction and execution</li>
 * <li>Event stream parsing and processing</li>
 * <li>Connection management and cleanup</li>
 * <li>Error handling and retry logic</li>
 * </ul>
 *
 * @author Pascal Wilbrink
 */
public interface BaseHttpClient {

    /**
     * Executes an agent request and streams events back to the provided handler.
     * <p>
     * This method establishes an HTTP connection to the remote agent service,
     * sends the agent input parameters, and processes the streaming response
     * by parsing events and forwarding them to the event handler.
     * <p>
     * The operation is designed to be cancellable through the cancellation token.
     * Implementations should regularly check the token's state and gracefully
     * terminate the stream when cancellation is requested.
     * <p>
     * The returned CompletableFuture will complete when:
     * <ul>
     * <li>The event stream ends naturally (success)</li>
     * <li>The operation is cancelled via the cancellation token</li>
     * <li>An error occurs during HTTP communication or event processing</li>
     * </ul>
     *
     * @param input             the agent input parameters to send to the remote service,
     *                         including context, messages, tools, and configuration
     * @param eventHandler      consumer function that processes each event received
     *                         from the remote service during the streaming response
     * @param cancellationToken atomic boolean flag that can be set to true to
     *                         request cancellation of the streaming operation
     * @return a CompletableFuture that completes when the streaming operation
     *         finishes, either successfully, through cancellation, or with an error
     * @throws IllegalArgumentException if input or eventHandler are null
     * @throws IllegalStateException if the HTTP client is not properly initialized
     */
    public CompletableFuture<Void> streamEvents(
        final RunAgentInput input,
        Consumer<BaseEvent> eventHandler,
        AtomicBoolean cancellationToken
    );

    /**
     * Closes the underlying HTTP client and releases associated resources.
     * <p>
     * This method should be called when the HTTP client is no longer needed
     * to ensure proper cleanup of resources such as connection pools,
     * thread pools, and other system resources.
     * <p>
     * Implementations should:
     * <ul>
     * <li>Close all active HTTP connections</li>
     * <li>Shutdown connection and thread pools</li>
     * <li>Cancel any pending requests</li>
     * <li>Release any other system resources</li>
     * </ul>
     * <p>
     * After calling this method, the HTTP client should not be used for
     * any further operations. Behavior of subsequent method calls is undefined
     * and may result in exceptions.
     * <p>
     * This method should be idempotent - multiple calls should not cause
     * errors or unexpected behavior.
     */
    void close();

}