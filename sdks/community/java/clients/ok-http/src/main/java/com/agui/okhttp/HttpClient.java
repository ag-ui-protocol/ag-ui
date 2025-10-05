package com.agui.okhttp;

import com.agui.core.agent.RunAgentInput;
import com.agui.core.event.BaseEvent;
import com.agui.json.ObjectMapperFactory;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.agui.http.BaseHttpClient;
import okhttp3.*;

import java.io.BufferedReader;
import java.io.IOException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;
import java.util.logging.Logger;

/**
 * OkHttp-based implementation of BaseHttpClient for streaming agent communication.
 * <p>
 * HttpClient provides a concrete implementation of the BaseHttpClient using OkHttp
 * for HTTP communication and Server-Sent Events (SSE) for real-time event streaming.
 * This implementation is designed for communicating with remote agent services that
 * support streaming responses.
 * <p>
 * Key features:
 * <ul>
 * <li>Server-Sent Events (SSE) support for real-time event streaming</li>
 * <li>JSON serialization/deserialization using Jackson with agui mixins</li>
 * <li>Cancellation support through both CompletableFuture and AtomicBoolean tokens</li>
 * <li>Infinite read timeout for long-lived streaming connections</li>
 * <li>Automatic HTTP connection management and cleanup</li>
 * <li>Error handling with proper exception propagation</li>
 * </ul>
 * <p>
 * The client expects the remote service to respond with Server-Sent Events format,
 * where each event line starts with "data: " followed by JSON-serialized BaseEvent
 * objects. This format is commonly used for real-time web applications and streaming APIs.
 * <p>
 * Connection lifecycle:
 * <ul>
 * <li>Serializes RunAgentInput to JSON and sends as POST request</li>
 * <li>Maintains persistent connection for streaming response</li>
 * <li>Parses each SSE data line as a BaseEvent</li>
 * <li>Forwards events to the provided event handler</li>
 * <li>Handles cancellation and connection cleanup</li>
 * </ul>
 * <p>
 * Example usage:
 * <pre>{@code
 * HttpClient client = new HttpClient("https://api.example.com/agent/stream");
 *
 * client.streamEvents(
 *     input,
 *     event -> handleEvent(event),
 *     cancellationToken
 * ).thenRun(() -> {
 *     System.out.println("Streaming completed");
 *     client.close();
 * });
 * }</pre>
 *
 * @author Pascal Wilbrink
 */
public class HttpClient implements BaseHttpClient {

    private final OkHttpClient client;

    private final String url;

    private final ObjectMapper objectMapper;

    private final Logger logger = Logger.getLogger(HttpClient.class.getName());

    /**
     * Constructs a new HttpClient with the specified endpoint URL.
     * <p>
     * This constructor initializes the OkHttp client with optimized settings
     * for streaming connections and configures Jackson ObjectMapper with
     * agui-specific mixins for proper event serialization.
     * <p>
     * The OkHttp client is configured with:
     * <ul>
     * <li>Infinite read timeout (0 milliseconds) for long-lived streams</li>
     * <li>Default connection and write timeouts</li>
     * <li>Automatic connection pooling and management</li>
     * </ul>
     *
     * @param url the endpoint URL for the remote agent service that supports
     *           streaming responses in Server-Sent Events format
     */
    public HttpClient(final String url) {
        this.url = url;

        this.client = new OkHttpClient.Builder()
                .readTimeout(0, TimeUnit.MILLISECONDS)
                .build();

        this.objectMapper = new ObjectMapper();
        ObjectMapperFactory.addMixins(this.objectMapper);
    }


    /**
     * Executes an agent request and streams events back to the provided handler.
     * <p>
     * This method establishes an HTTP POST connection to the configured endpoint,
     * sends the agent input as JSON, and processes the streaming Server-Sent Events
     * response. Each event is parsed and forwarded to the event handler in real-time.
     * <p>
     * The streaming process:
     * <ul>
     * <li>Serializes the RunAgentInput to JSON and sends as POST body</li>
     * <li>Maintains a persistent HTTP connection for the streaming response</li>
     * <li>Reads response lines and parses SSE format ("data: " prefix)</li>
     * <li>Deserializes each JSON event line to a BaseEvent object</li>
     * <li>Forwards events to the handler while monitoring for cancellation</li>
     * </ul>
     * <p>
     * Cancellation handling:
     * <ul>
     * <li>Monitors both the CompletableFuture cancellation state</li>
     * <li>Checks the provided AtomicBoolean cancellation token</li>
     * <li>Immediately stops processing and cancels the HTTP call when requested</li>
     * </ul>
     * <p>
     * Error handling:
     * <ul>
     * <li>JSON parsing errors are logged but don't stop the stream</li>
     * <li>IO exceptions complete the future exceptionally</li>
     * <li>HTTP failures are propagated through the returned CompletableFuture</li>
     * </ul>
     *
     * @param input             the agent input parameters to send to the remote service
     * @param eventHandler      consumer function that processes each received event
     * @param cancellationToken atomic boolean flag for requesting stream cancellation
     * @return a CompletableFuture that completes when the streaming operation finishes,
     *         either successfully, through cancellation, or with an error
     */
    @Override
    public CompletableFuture<Void> streamEvents(
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
                    extracted(response);
                }

                private void extracted(Response response) {
                    if (response.isSuccessful()) {
                        try (BufferedReader reader = new BufferedReader(response.body().charStream())) {
                            String line;
                            while (
                                    (line = reader.readLine()) != null &&
                                            !future.isCancelled() &&
                                            !cancellationToken.get()
                            ) {
                                handleEvent(line.trim());
                            }

                            if (!future.isCancelled() && !cancellationToken.get()) {
                                future.complete(null);
                            }
                        } catch (IOException e) {
                            future.completeExceptionally(e);
                        }
                    } else {
                        future.completeExceptionally(new RuntimeException(response.message()));
                    }
                }

                private void handleEvent(String line) {
                    if (line.trim().startsWith("data: ")) {
                        try {
                            String jsonData = line.trim().substring(6).trim();
                            BaseEvent event = objectMapper.readValue(jsonData, BaseEvent.class);

                            if (eventHandler != null) {
                                eventHandler.accept(event);
                            }
                        } catch (Exception  e) {
                            logger.info("Error parsing event: " + e.getMessage());
                        }
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

    /**
     * Closes the underlying OkHttp client and releases all associated resources.
     * <p>
     * This method performs complete cleanup of the HTTP client, including:
     * <ul>
     * <li>Shutting down the dispatcher's executor service</li>
     * <li>Evicting all connections from the connection pool</li>
     * <li>Canceling any pending or active HTTP calls</li>
     * </ul>
     * <p>
     * After calling this method, the HttpClient should not be used for any
     * further operations. The cleanup is essential for preventing resource
     * leaks, especially in long-running applications or when creating
     * multiple HttpClient instances.
     * <p>
     * This method is idempotent and safe to call multiple times.
     */
    @Override
    public void close() {
        if (client != null) {
            client.dispatcher().executorService().shutdown();
            client.connectionPool().evictAll();
        }
    }
}