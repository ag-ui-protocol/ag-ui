package com.agui.http;

import com.agui.core.agent.RunAgentInput;
import com.agui.core.event.BaseEvent;
import com.agui.core.event.TextMessageContentEvent;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

@DisplayName("BaseHttpClient")
class BaseHttpClientTest {

    private TestHttpClient httpClient;

    @BeforeEach
    void setUp() {
        httpClient = new TestHttpClient();
    }

    @Test
    void shouldStreamEventsSuccessfully() {
        var input = new RunAgentInput("thread", "run", null, List.of(), List.of(), List.of(), null);
        var events = new ArrayList<BaseEvent>();
        Consumer<BaseEvent> eventHandler = events::add;
        var cancellationToken = new AtomicBoolean(false);

        var future = httpClient.streamEvents(input, eventHandler, cancellationToken);

        assertThat(future).isNotNull();
        assertThat(future.join()).isNull(); // Should complete successfully
        assertThat(events).hasSize(1);
        assertThat(events.get(0)).isInstanceOf(TextMessageContentEvent.class);
    }

    @Test
    void shouldHandleCancellation() {
        var input = new RunAgentInput("thread", "run", null, List.of(), List.of(), List.of(), null);
        Consumer<BaseEvent> eventHandler = event -> {};
        var cancellationToken = new AtomicBoolean(true); // Pre-cancelled

        httpClient.shouldCheckCancellation = true;
        var future = httpClient.streamEvents(input, eventHandler, cancellationToken);

        assertThat(future).isNotNull();
        assertThat(future.join()).isNull(); // Should complete without error
        assertThat(httpClient.wasCancelled).isTrue();
    }

    @Test
    void shouldThrowOnNullInput() {
        Consumer<BaseEvent> eventHandler = event -> {};
        var cancellationToken = new AtomicBoolean(false);

        assertThatThrownBy(() -> httpClient.streamEvents(null, eventHandler, cancellationToken))
            .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void shouldThrowOnNullEventHandler() {
        var input = new RunAgentInput("thread", "run", null, List.of(), List.of(), List.of(), null);
        var cancellationToken = new AtomicBoolean(false);

        assertThatThrownBy(() -> httpClient.streamEvents(input, null, cancellationToken))
            .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void shouldThrowOnNullCancellationToken() {
        var input = new RunAgentInput("thread", "run", null, List.of(), List.of(), List.of(), null);
        Consumer<BaseEvent> eventHandler = event -> {};

        assertThatThrownBy(() -> httpClient.streamEvents(input, eventHandler, null))
            .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void shouldCloseSuccessfully() {
        httpClient.close();
        
        assertThat(httpClient.isClosed).isTrue();
    }

    @Test
    void shouldBeIdempotentOnClose() {
        httpClient.close();
        httpClient.close(); // Should not throw
        
        assertThat(httpClient.isClosed).isTrue();
    }

    static class TestHttpClient implements BaseHttpClient {
        boolean isClosed = false;
        boolean wasCancelled = false;
        boolean shouldCheckCancellation = false;

        @Override
        public CompletableFuture<Void> streamEvents(
            RunAgentInput input,
            Consumer<BaseEvent> eventHandler,
            AtomicBoolean cancellationToken
        ) {
            if (input == null) {
                throw new IllegalArgumentException("Input cannot be null");
            }
            if (eventHandler == null) {
                throw new IllegalArgumentException("Event handler cannot be null");
            }
            if (cancellationToken == null) {
                throw new IllegalArgumentException("Cancellation token cannot be null");
            }

            return CompletableFuture.supplyAsync(() -> {
                if (shouldCheckCancellation && cancellationToken.get()) {
                    wasCancelled = true;
                    return null;
                }

                // Simulate event streaming
                var event = new TextMessageContentEvent();
                event.setDelta("Hello");
                eventHandler.accept(event);

                return null;
            });
        }

        @Override
        public void close() {
            isClosed = true;
        }
    }
}