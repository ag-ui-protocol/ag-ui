package io.workm8.agui.okhttp;

import io.workm8.agui.BaseHttpClient;
import io.workm8.agui.event.BaseEvent;
import io.workm8.agui.input.RunAgentInput;
import okhttp3.*;

import java.io.BufferedReader;
import java.io.IOException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;

public class HttpClient extends BaseHttpClient {

    private final OkHttpClient client;

    private final String url;

    public HttpClient(final String url) {
        super();

        this.url = url;

        this.client = new OkHttpClient.Builder()
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .build();
    }

    @Override
    public CompletableFuture<Void> streamEvents(final RunAgentInput input, Consumer<BaseEvent> eventHandler) {
        CompletableFuture<Void> future = new CompletableFuture<>();
        AtomicBoolean isCancelled = new AtomicBoolean(false);

        try {
            var body = RequestBody.create(
                objectMapper.writeValueAsString(input),
                MediaType.get("application/json")
            );

            Request request = new Request.Builder()
                .url(this.url)
                .header("Accept", "application/json")
                .post(body)
                .build();

            Call call = client.newCall(request);

            // Allow cancellation of the CompletableFuture to cancel the HTTP call
            future.whenComplete((result, throwable) -> {
                if (future.isCancelled()) {
                    isCancelled.set(true);
                    call.cancel();
                }
            });

            call.enqueue(new Callback() {
                @Override
                public void onResponse(Call call, Response response) {
                    try (BufferedReader reader = new BufferedReader(response.body().charStream())) {
                        String line;
                        while ((line = reader.readLine()) != null && !isCancelled.get()) {
                            if (line.trim().startsWith("data: ")) {
                                try {
                                    String jsonData = line.trim().substring(6).trim();
                                    BaseEvent event = objectMapper.readValue(jsonData, BaseEvent.class);

                                    // Call the event handler for each event
                                    if (eventHandler != null) {
                                        eventHandler.accept(event);
                                    }
                                } catch (Exception e) {
                                    // Log parsing errors but continue processing
                                    System.err.println("Error parsing event: " + e.getMessage());
                                    // Optionally, you could fail the entire future here:
                                    // future.completeExceptionally(e);
                                     return;
                                }
                            }
                        }

                        if (!isCancelled.get()) {
                            future.complete(null);
                        }
                    } catch (IOException e) {
                        future.completeExceptionally(e);
                    }
                }

                @Override
                public void onFailure(Call call, IOException e) {
                    future.completeExceptionally(e);
                }
            });

        } catch (Exception e) {
            future.completeExceptionally(e);
        }

        return future;
    }


    @Override
    public CompletableFuture<Void> streamEventsWithCancellation(
        final RunAgentInput input,
        final Consumer<BaseEvent> eventHandler,
        final AtomicBoolean cancellationToken
    ) {
        CompletableFuture<Void> future = new CompletableFuture<>();

        try {
            var body = RequestBody.create(
                objectMapper.writeValueAsString(input),
                MediaType.get("application/json")
            );

            Request request = new Request.Builder()
                .url(url)
                .header("Accept", "application/json")
                .post(body)
                .build();

            Call call = client.newCall(request);

            // Cancel HTTP call if either the future is cancelled or the token is set
            future.whenComplete((result, throwable) -> {
                if (future.isCancelled() || cancellationToken.get()) {
                    call.cancel();
                }
            });

            call.enqueue(new Callback() {
                @Override
                public void onResponse(Call call, Response response) {
                    try (BufferedReader reader = new BufferedReader(response.body().charStream())) {
                        String line;
                        while ((line = reader.readLine()) != null &&
                            !future.isCancelled() &&
                            !cancellationToken.get()) {

                            if (line.trim().startsWith("data: ")) {
                                try {
                                    String jsonData = line.trim().substring(6).trim();
                                    BaseEvent event = objectMapper.readValue(jsonData, BaseEvent.class);

                                    if (eventHandler != null) {
                                        eventHandler.accept(event);
                                    }
                                } catch (Exception  e) {
                                    System.err.println("Error parsing event: " + e.getMessage());
                                }
                            }
                        }

                        if (!future.isCancelled() && !cancellationToken.get()) {
                            future.complete(null);
                        }
                    } catch (IOException e) {
                        future.completeExceptionally(e);
                    }
                }

                @Override
                public void onFailure(Call call, IOException e) {
                    future.completeExceptionally(e);
                }
            });

        } catch (Exception e) {
            future.completeExceptionally(e);
        }

        return future;
    }

    @Override
    public void close() {
        if (client != null) {
            client.dispatcher().executorService().shutdown();
            client.connectionPool().evictAll();
        }
    }
}