package com.agui;

import com.agui.event.BaseEvent;
import com.agui.types.RunAgentInput;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.SerializationFeature;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;

public abstract class HttpClient {

    protected final ObjectMapper objectMapper;

    public HttpClient() {

        this.objectMapper = new ObjectMapper();
        this.objectMapper.disable(SerializationFeature.FAIL_ON_EMPTY_BEANS);
    }

    /**
     * Stream events from the server, calling the eventHandler for each received event.
     *
     * @param input The input to send to the server
     * @param eventHandler Callback function that handles each received event
     * @return CompletableFuture that completes when the stream ends or fails
     */
    public abstract CompletableFuture<Void> streamEvents(final RunAgentInput input, Consumer<BaseEvent> eventHandler);

    /**
     * Alternative method that returns a CompletableFuture<Void> without event handler
     * (for cases where you just want to know when the stream completes)
     */
    public CompletableFuture<Void> streamEvents(final RunAgentInput input) {
        return streamEvents(input, null);
    }

    /**
     * Utility method to create a cancellable stream that can be interrupted
     */
    public abstract CompletableFuture<Void> streamEventsWithCancellation(
        final RunAgentInput input,
        Consumer<BaseEvent> eventHandler,
        AtomicBoolean cancellationToken
    );

    /**
     * Close the underlying HTTP client
     */
    public abstract void close();

}
