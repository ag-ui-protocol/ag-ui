package io.workm8.agui.spring;

import io.workm8.agui.BaseHttpClient;
import io.workm8.agui.event.BaseEvent;
import io.workm8.agui.input.RunAgentInput;
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.web.reactive.function.BodyInserters;
import org.springframework.http.MediaType;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;

public class HttpClient extends BaseHttpClient {

    private final WebClient webClient;
    private final String url;

    public HttpClient(final String url) {
        super();
        this.url = url;

        this.webClient = WebClient.builder()
            .codecs(configurer -> configurer
                .defaultCodecs()
                .maxInMemorySize(16 * 1024 * 1024)) // 16MB buffer for streaming
                .build();
    }

    @Override
    public CompletableFuture<Void> streamEvents(final RunAgentInput input, Consumer<BaseEvent> eventHandler) {
        AtomicBoolean isCancelled = new AtomicBoolean(false);

        return webClient.post()
            .uri(url)
            .contentType(MediaType.APPLICATION_JSON)
            .accept(MediaType.APPLICATION_JSON)
            .body(BodyInserters.fromValue(input))
            .retrieve()
            .bodyToFlux(String.class)
            .takeWhile(line -> !isCancelled.get())
            .filter(line -> line.trim().startsWith("data: "))
            .map(line -> {
                try {
                    String jsonData = line.trim().substring(6).trim();
                    return objectMapper.readValue(jsonData, BaseEvent.class);
                } catch (Exception e) {
                    System.err.println("Error parsing event: " + e.getMessage());
                    return null;
                }
            })
            .filter(event -> event != null)
            .doOnNext(event -> {
                if (eventHandler != null) {
                    eventHandler.accept(event);
                }
            })
            .then()
            .doOnCancel(() -> isCancelled.set(true))
            .toFuture();
    }

    @Override
    public CompletableFuture<Void> streamEventsWithCancellation(
        final RunAgentInput input,
        final Consumer<BaseEvent> eventHandler,
        final AtomicBoolean cancellationToken
    ) {
        return webClient.post()
            .uri(url)
            .contentType(MediaType.APPLICATION_JSON)
            .accept(MediaType.APPLICATION_JSON)
            .body(BodyInserters.fromValue(input))
            .retrieve()
            .bodyToFlux(String.class)
            .takeWhile(line -> !cancellationToken.get())
            .filter(line -> line.trim().startsWith("data: "))
            .map(line -> {
                try {
                    String jsonData = line.trim().substring(6).trim();
                    return objectMapper.readValue(jsonData, BaseEvent.class);
                } catch (Exception e) {
                    System.err.println("Error parsing event: " + e.getMessage());
                    return null;
                }
            })
            .filter(event -> event != null)
            .doOnNext(event -> {
                if (eventHandler != null) {
                    eventHandler.accept(event);
                }
            })
            .then()
            .doOnCancel(() -> cancellationToken.set(true))
            .toFuture();
    }

    @Override
    public void close() {
        // WebClient doesn't require explicit cleanup as it uses shared resources
        // If you need to customize connection pooling, you can create a custom
        // ConnectionProvider and dispose it here
    }
}