package com.agui.spring;

import com.fasterxml.jackson.databind.ObjectMapper;

import com.agui.core.agent.RunAgentInput;
import com.agui.core.event.BaseEvent;
import com.agui.http.BaseHttpClient;
import com.agui.json.ObjectMapperFactory;
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.web.reactive.function.BodyInserters;
import org.springframework.http.MediaType;

import java.util.Objects;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;

public class HttpClient implements BaseHttpClient {

    private final WebClient webClient;
    private final String url;

    private final ObjectMapper objectMapper;

    public HttpClient(final String url) {
        this.url = url;

        this.webClient = WebClient.builder()
                .codecs(configurer -> configurer
                    .defaultCodecs()
                    .maxInMemorySize(16 * 1024 * 1024))
                .build();

        this.objectMapper = new ObjectMapper();
        ObjectMapperFactory.addMixins(this.objectMapper);
    }

    @Override
    public CompletableFuture<Void> streamEvents(
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
            .map(line -> {
                try {
                    String jsonData = line.trim().startsWith("data: ") ? line.trim().substring(6).trim() : line.trim();
                    return objectMapper.readValue(jsonData, BaseEvent.class);
                } catch (Exception e) {
                    System.err.println("Error parsing event: " + e.getMessage());
                    return null;
                }
            })
            .filter(Objects::nonNull)
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