package com.agui.okhttp;


import com.agui.core.agent.RunAgentInput;
import com.agui.core.context.Context;
import com.agui.core.event.BaseEvent;
import com.agui.core.message.BaseMessage;
import com.agui.core.state.State;
import com.agui.core.tool.Tool;
import com.agui.core.type.EventType;
import okhttp3.mockwebserver.MockResponse;
import okhttp3.mockwebserver.MockWebServer;
import okhttp3.mockwebserver.RecordedRequest;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.Charset;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.assertj.core.api.Assertions.*;

@DisplayName("HttpClient")
class HttpClientTest {

    @Test
    void shouldCallEndpoint() throws IOException, InterruptedException, ExecutionException, TimeoutException {
        var server = new MockWebServer();
        var response = new MockResponse();
        var threadId = UUID.randomUUID().toString();
        var runId = UUID.randomUUID().toString();

        var sseResponse = """
            data: {"type":"RUN_STARTED","threadId":"%s","runId": "%s"}
        
            data: {"type":"RUN_FINISHED","threadId":"%s","runId": "%s"}
        
        """.formatted(threadId, runId, threadId, runId);

        response.setBody(sseResponse);
        response.addHeader("Content-Type", "text/event-stream");
        server.enqueue(response);

        server.start();

        var url = server.url("/").toString();

        var client = new HttpClient(url);

        var state = new State();
        List<BaseMessage> messages = new ArrayList<>();
        List<Context> context = new ArrayList<>();
        List<Tool> tools = new ArrayList<>();
        String forwardedProps = "props";

        var input = new RunAgentInput(threadId, runId, state, messages, tools, context, forwardedProps);
        var cancellationToken = new AtomicBoolean(false);
        List<BaseEvent> receivedEvents = new ArrayList<>();

        var future = client.streamEvents(
            input,
            receivedEvents::add,
            cancellationToken
        );
        future.get(5, TimeUnit.SECONDS);

        RecordedRequest recordedRequest = server.takeRequest();

        assertThat(recordedRequest.getMethod()).isEqualTo("POST");

        var body = recordedRequest.getBody().readString(Charset.defaultCharset());

        assertThat(body).contains("\"threadId\":\"" + threadId + "\"");
        assertThat(body).contains("\"runId\":\"" + runId + "\"");

        assertThat(receivedEvents).hasSize(2);
        assertThat(receivedEvents.get(0).getType()).isEqualTo(EventType.RUN_STARTED);
        assertThat(receivedEvents.get(1).getType()).isEqualTo(EventType.RUN_FINISHED);

        server.shutdown();
    }

    @Test
    void shouldTestCancellation() throws IOException, InterruptedException, ExecutionException, TimeoutException {
        var server = new MockWebServer();
        var response = new MockResponse();
        var threadId = UUID.randomUUID().toString();
        var runId = UUID.randomUUID().toString();

        var sseResponse = """
            data: {"type":"RUN_STARTED","threadId":"%s","runId": "%s"}
        
            data: {"type":"RUN_FINISHED","threadId":"%s","runId": "%s"}
        
        """.formatted(threadId, runId, threadId, runId);

        response.setBody(sseResponse);
        response.addHeader("Content-Type", "text/event-stream");
        server.enqueue(response);

        server.start();

        var url = server.url("/").toString();

        var client = new HttpClient(url);

        var state = new State();
        List<BaseMessage> messages = new ArrayList<>();
        List<Context> context = new ArrayList<>();
        List<Tool> tools = new ArrayList<>();
        String forwardedProps = "props";

        var input = new RunAgentInput(threadId, runId, state, messages, tools, context, forwardedProps);
        var cancellationToken = new AtomicBoolean(false);
        List<BaseEvent> receivedEvents = new ArrayList<>();

        var future = client.streamEvents(
            input,
            receivedEvents::add,
            cancellationToken
        );

        CompletableFuture.delayedExecutor(100, TimeUnit.MILLISECONDS)
            .execute(() -> cancellationToken.set(true));

        // Should complete due to cancellation
        assertThatCode(() -> future.get(2, TimeUnit.SECONDS))
            .doesNotThrowAnyException();

        server.shutdown();
    }

    @Test
    @DisplayName("Should handle HTTP errors gracefully")
    void shouldHandleHttpErrorsGracefully() throws IOException, ExecutionException, InterruptedException, TimeoutException {
        var threadId = UUID.randomUUID().toString();
        var runId = UUID.randomUUID().toString();
        var state = new State();
        List<BaseMessage> messages = new ArrayList<>();
        List<Context> context = new ArrayList<>();
        List<Tool> tools = new ArrayList<>();
        String forwardedProps = "props";

        var input = new RunAgentInput(threadId, runId, state, messages, tools, context, forwardedProps);

        var server = new MockWebServer();
        server.enqueue(new MockResponse().setResponseCode(500));
        server.start();

        var client = new HttpClient(server.url("/").toString());
        var cancellationToken = new AtomicBoolean(false);

        CompletableFuture<Void> future = client.streamEvents(
            input,
            event -> {},
            cancellationToken
        );

        assertThatExceptionOfType(ExecutionException.class)
            .isThrownBy(() -> future.get(5, TimeUnit.SECONDS))
            .withMessage("java.lang.RuntimeException: Server Error");

        assertThat(future.isCompletedExceptionally()).isTrue();
        server.shutdown();
        client.close();
    }


}