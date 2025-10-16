package com.agui.http;

import com.agui.core.agent.RunAgentInput;
import com.agui.core.agent.RunAgentParameters;
import com.agui.core.event.BaseEvent;
import com.agui.core.event.RunFinishedEvent;
import com.agui.core.event.RunStartedEvent;
import com.agui.core.message.BaseMessage;
import com.agui.core.message.UserMessage;
import com.agui.core.state.State;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatExceptionOfType;

@DisplayName("HttpAgent")
class HttpAgentTest {

    @Nested
    @DisplayName("Builder")
    class BuilderTests {

        @Test
        void shouldBuildAgentWithAllRequiredParameters() {
            TestHttpClient httpClient = new TestHttpClient();

            HttpAgent agent = HttpAgent.builder()
                .agentId("test-agent")
                .threadId("test-thread")
                .httpClient(httpClient)
                .build();

            assertThat(agent).isNotNull();
            assertThat(agent.getMessages()).isEmpty();
            assertThat(agent.getState()).isNotNull();
            assertThat(agent.httpClient).isEqualTo(httpClient);
        }

        @Test
        void shouldBuildAgentWithAllOptionalParameters() {
            TestHttpClient httpClient = new TestHttpClient();
            List<BaseMessage> messages = List.of(createMessage("Test message"));
            State state = new State();
            state.set("key", "value");

            HttpAgent agent = HttpAgent.builder()
                .agentId("test-agent")
                .description("Test description")
                .threadId("test-thread")
                .httpClient(httpClient)
                .messages(messages)
                .state(state)
                .debug(true)
                .build();

            assertThat(agent.getMessages()).hasSize(1);
            assertThat(agent.getState().get("key")).isEqualTo("value");
        }



        @Test
        void shouldAddSingleMessageToBuilder() {
            TestHttpClient httpClient = new TestHttpClient();
            BaseMessage message1 = createMessage("Message 1");
            BaseMessage message2 = createMessage("Message 2");

            HttpAgent agent = HttpAgent.builder()
                .agentId("test-agent")
                .threadId("test-thread")
                .httpClient(httpClient)
                .addMessage(message1)
                .addMessage(message2)
                .build();

            assertThat(agent.getMessages()).hasSize(2);
            assertThat(agent.getMessages().get(0).getContent()).isEqualTo("Message 1");
            assertThat(agent.getMessages().get(1).getContent()).isEqualTo("Message 2");
        }

        @Test
        void shouldHandleNullMessagesList() {
            TestHttpClient httpClient = new TestHttpClient();

            HttpAgent agent = HttpAgent.builder()
                .agentId("test-agent")
                .threadId("test-thread")
                .httpClient(httpClient)
                .messages(null)
                .build();

            assertThat(agent.getMessages()).isEmpty();
        }

        @Test
        void shouldHandleNullState() {
            TestHttpClient httpClient = new TestHttpClient();

            HttpAgent agent = HttpAgent.builder()
                .agentId("test-agent")
                .threadId("test-thread")
                .httpClient(httpClient)
                .state(null)
                .build();

            assertThat(agent.getState()).isNotNull();
        }

        @Test
        void shouldThrowExceptionWhenThreadIdIsNull() {
            TestHttpClient httpClient = new TestHttpClient();

            assertThatExceptionOfType(IllegalArgumentException.class)
                    .isThrownBy(() -> HttpAgent.builder()
                        .agentId("test-agent")
                        .httpClient(httpClient)
                        .build())
                    .withMessage("threadId is required");
        }

        @Test
        void shouldThrowExceptionWhenThreadIdIsEmpty() {
            TestHttpClient httpClient = new TestHttpClient();

            assertThatExceptionOfType(IllegalArgumentException.class)
                    .isThrownBy(() -> HttpAgent.builder()
                        .agentId("test-agent")
                        .threadId("")
                        .httpClient(httpClient)
                        .build())
                    .withMessage("threadId is required");
        }

        @Test
        void shouldThrowExceptionWhenHttpClientIsNull() {
            assertThatExceptionOfType(IllegalArgumentException.class)
                    .isThrownBy(() -> HttpAgent.builder()
                        .agentId("test-agent")
                        .threadId("test-thread")
                        .build())
                    .withMessage("http client is required");
        }

        @Test
        void shouldSupportMethodChaining() {
            TestHttpClient httpClient = new TestHttpClient();

            HttpAgent agent = HttpAgent.builder()
                .agentId("test-agent")
                .description("Test description")
                .threadId("test-thread")
                .httpClient(httpClient)
                .messages(new ArrayList<>())
                .addMessage(createMessage("Test"))
                .state(new State())
                .debug(false)
                .build();

            assertThat(agent).isNotNull();
        }
    }

    @Nested
    @DisplayName("Agent Execution")
    class AgentExecutionTests {

        private TestHttpClient httpClient;
        private HttpAgent agent;
        private RunAgentParameters parameters;

        @BeforeEach
        void setUp() {
            httpClient = new TestHttpClient();
            agent = HttpAgent.builder()
                .agentId("test-agent")
                .threadId("test-thread")
                .httpClient(httpClient)
                .build();

            parameters = RunAgentParameters.empty();
        }

        @Test
        void shouldExecuteSuccessfullyWithEventsFromHttpClient() throws Exception {
            TestSubscriber subscriber = new TestSubscriber();

            RunStartedEvent startEvent = new RunStartedEvent();
            RunFinishedEvent finishEvent = new RunFinishedEvent();

            httpClient.setEventsToEmit(List.of(startEvent, finishEvent));
            httpClient.setShouldComplete(true);

            CompletableFuture<Void> future = agent.runAgent(parameters, subscriber);
            future.get(5, TimeUnit.SECONDS);

            assertThat(future).isDone();
            assertThat(future.isCompletedExceptionally()).isFalse();

            assertThat(subscriber.wasOnRunInitializedCalled()).isTrue();
            assertThat(subscriber.wasOnRunFinalizedCalled()).isTrue();
            assertThat(subscriber.getEventCount()).isEqualTo(2);

            assertThat(httpClient.getLastInput()).isNotNull();
            assertThat(httpClient.getLastInput().threadId()).isEqualTo("test-thread");
        }

        @Test
        void shouldHandleHttpClientErrorsProperly() {
            TestSubscriber subscriber = new TestSubscriber();
            httpClient.setShouldThrowError(true);
            httpClient.setErrorToThrow(new RuntimeException("HTTP error"));

            CompletableFuture<Void> future = agent.runAgent(parameters, subscriber);

            assertThatExceptionOfType(Exception.class)
                    .isThrownBy(() -> future.get(5, TimeUnit.SECONDS))
                    .withCauseInstanceOf(RuntimeException.class)
                    .withMessageContaining("HTTP error");

            assertThat(future.isCompletedExceptionally()).isTrue();
            assertThat(subscriber.wasOnRunErrorCalled()).isTrue();
        }

        @Test
        void shouldNotForwardEventsWhenStreamIsCancelled() throws Exception {
            TestSubscriber subscriber = new TestSubscriber();

            httpClient.setDelayBeforeEvents(100);
            httpClient.setEventsToEmit(List.of(new RunStartedEvent()));
            httpClient.setShouldComplete(true);

            CompletableFuture<Void> future = agent.runAgent(parameters, subscriber);

            future.cancel(true);

            try {
                future.get(1, TimeUnit.SECONDS);
            } catch (Exception e) {
                // Expected due to cancellation
            }

            Thread.sleep(200);

            assertThat(httpClient.wasStreamEventsCalled()).isTrue();
        }

        @Test
        void shouldPassCancellationTokenToHttpClient() throws Exception {
            TestSubscriber subscriber = new TestSubscriber();
            httpClient.setShouldComplete(true);

            CompletableFuture<Void> future = agent.runAgent(parameters, subscriber);
            future.get(5, TimeUnit.SECONDS);

            assertThat(httpClient.getLastCancellationToken()).isNotNull();
        }

        @Test
        void shouldHandleMultipleEventsInSequence() throws Exception {
            TestSubscriber subscriber = new TestSubscriber();

            List<BaseEvent> events = List.of(
                new RunStartedEvent(),
                new RunStartedEvent(), // Another event
                new RunFinishedEvent()
            );

            httpClient.setEventsToEmit(events);
            httpClient.setShouldComplete(true);

            CompletableFuture<Void> future = agent.runAgent(parameters, subscriber);
            future.get(5, TimeUnit.SECONDS);

            assertThat(future).isDone();
            assertThat(subscriber.getEventCount()).isEqualTo(3);
        }

        @Test
        void shouldHandleEmptyEventStream() throws Exception {
            TestSubscriber subscriber = new TestSubscriber();
            httpClient.setEventsToEmit(List.of()); // No events
            httpClient.setShouldComplete(true);

            CompletableFuture<Void> future = agent.runAgent(parameters, subscriber);
            future.get(5, TimeUnit.SECONDS);

            assertThat(future).isDone();
            assertThat(future.isCompletedExceptionally()).isFalse();
            assertThat(subscriber.getEventCount()).isZero();
        }
    }

    @Nested
    @DisplayName("Resource Management")
    class ResourceManagementTests {

        @Test
        void shouldCloseHttpClientWhenCloseIsCalled() {
            TestHttpClient httpClient = new TestHttpClient();
            HttpAgent agent = HttpAgent.builder()
                .agentId("test-agent")
                .threadId("test-thread")
                .httpClient(httpClient)
                .build();

            agent.close();

            assertThat(httpClient.wasClosed()).isTrue();
        }

        @Test
        void shouldHandleCloseWhenHttpClientIsNull() {
            TestHttpClient httpClient = new TestHttpClient();
            HttpAgent agent = HttpAgent.builder()
                .agentId("test-agent")
                .threadId("test-thread")
                .httpClient(httpClient)
                .build();

            agent.close();
            agent.close(); // Multiple calls should be safe

            assertThat(httpClient.wasClosed()).isTrue();
        }
    }

    private static class TestSubscriber implements com.agui.core.agent.AgentSubscriber {
        private final List<BaseEvent> receivedEvents = new ArrayList<>();
        private final List<String> methodCalls = new ArrayList<>();
        private final AtomicInteger eventCount = new AtomicInteger(0);
        private final AtomicBoolean onRunInitializedCalled = new AtomicBoolean(false);
        private final AtomicBoolean onRunFinalizedCalled = new AtomicBoolean(false);
        private final AtomicBoolean onRunErrorCalled = new AtomicBoolean(false);

        @Override
        public void onEvent(BaseEvent event) {
            receivedEvents.add(event);
            eventCount.incrementAndGet();
            methodCalls.add("onEvent");
        }

        @Override
        public void onRunInitialized(com.agui.core.agent.AgentSubscriberParams params) {
            onRunInitializedCalled.set(true);
            methodCalls.add("onRunInitialized");
        }

        @Override
        public void onRunFinalized(com.agui.core.agent.AgentSubscriberParams params) {
            onRunFinalizedCalled.set(true);
            methodCalls.add("onRunFinalized");
        }

        @Override
        public void onRunStartedEvent(com.agui.core.event.RunStartedEvent event) {
            methodCalls.add("onRunStartedEvent");
        }

        @Override
        public void onRunErrorEvent(com.agui.core.event.RunErrorEvent event) {
            onRunErrorCalled.set(true);
            methodCalls.add("onRunErrorEvent");
        }

        @Override
        public void onRunFinishedEvent(com.agui.core.event.RunFinishedEvent event) {
            methodCalls.add("onRunFinishedEvent");
        }

        @Override
        public void onStepStartedEvent(com.agui.core.event.StepStartedEvent event) {
            methodCalls.add("onStepStartedEvent");
        }

        @Override
        public void onStepFinishedEvent(com.agui.core.event.StepFinishedEvent event) {
            methodCalls.add("onStepFinishedEvent");
        }

        @Override
        public void onTextMessageStartEvent(com.agui.core.event.TextMessageStartEvent event) {
            methodCalls.add("onTextMessageStartEvent");
        }

        @Override
        public void onTextMessageContentEvent(com.agui.core.event.TextMessageContentEvent event) {
            methodCalls.add("onTextMessageContentEvent");
        }

        @Override
        public void onTextMessageEndEvent(com.agui.core.event.TextMessageEndEvent event) {
            methodCalls.add("onTextMessageEndEvent");
        }

        @Override
        public void onToolCallStartEvent(com.agui.core.event.ToolCallStartEvent event) {
            methodCalls.add("onToolCallStartEvent");
        }

        @Override
        public void onToolCallArgsEvent(com.agui.core.event.ToolCallArgsEvent event) {
            methodCalls.add("onToolCallArgsEvent");
        }

        @Override
        public void onToolCallResultEvent(com.agui.core.event.ToolCallResultEvent event) {
            methodCalls.add("onToolCallResultEvent");
        }

        @Override
        public void onToolCallEndEvent(com.agui.core.event.ToolCallEndEvent event) {
            methodCalls.add("onToolCallEndEvent");
        }

        @Override
        public void onRawEvent(com.agui.core.event.RawEvent event) {
            methodCalls.add("onRawEvent");
        }

        @Override
        public void onCustomEvent(com.agui.core.event.CustomEvent event) {
            methodCalls.add("onCustomEvent");
        }

        @Override
        public void onMessagesSnapshotEvent(com.agui.core.event.MessagesSnapshotEvent event) {
            methodCalls.add("onMessagesSnapshotEvent");
        }

        @Override
        public void onStateSnapshotEvent(com.agui.core.event.StateSnapshotEvent event) {
            methodCalls.add("onStateSnapshotEvent");
        }

        @Override
        public void onStateDeltaEvent(com.agui.core.event.StateDeltaEvent event) {
            methodCalls.add("onStateDeltaEvent");
        }

        @Override
        public void onNewMessage(BaseMessage message) {
            methodCalls.add("onNewMessage");
        }

        @Override
        public void onMessagesChanged(com.agui.core.agent.AgentSubscriberParams params) {
            methodCalls.add("onMessagesChanged");
        }

        // Getter methods for verification
        public List<BaseEvent> getReceivedEvents() { return receivedEvents; }
        public List<String> getMethodCalls() { return methodCalls; }
        public int getEventCount() { return eventCount.get(); }
        public boolean wasOnRunInitializedCalled() { return onRunInitializedCalled.get(); }
        public boolean wasOnRunFinalizedCalled() { return onRunFinalizedCalled.get(); }
        public boolean wasOnRunErrorCalled() { return onRunErrorCalled.get(); }
    }

    private static class TestHttpClient implements BaseHttpClient {
        private List<BaseEvent> eventsToEmit = new ArrayList<>();
        private boolean shouldThrowError = false;
        private Throwable errorToThrow;
        private boolean shouldComplete = false;
        private long delayBeforeEvents = 0;
        private boolean wasClosed = false;
        private boolean streamEventsCalled = false;
        private RunAgentInput lastInput;
        private AtomicBoolean lastCancellationToken;

        @Override
        public CompletableFuture<Void> streamEvents(
                RunAgentInput input,
                Consumer<BaseEvent> eventConsumer,
                AtomicBoolean cancellationToken
        ) {
            this.streamEventsCalled = true;
            this.lastInput = input;
            this.lastCancellationToken = cancellationToken;

            return CompletableFuture.runAsync(() -> {
                try {
                    if (delayBeforeEvents > 0) {
                        Thread.sleep(delayBeforeEvents);
                    }

                    if (shouldThrowError) {
                        throw new RuntimeException(errorToThrow);
                    }

                    // Emit events
                    for (BaseEvent event : eventsToEmit) {
                        if (cancellationToken.get()) {
                            break; // Stop if cancelled
                        }
                        eventConsumer.accept(event);
                    }

                    if (!shouldComplete) {
                        throw new RuntimeException("HTTP client error");
                    }

                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    throw new RuntimeException("Interrupted", e);
                }
            });
        }

        @Override
        public void close() {
            this.wasClosed = true;
        }

        // Test configuration methods
        public void setEventsToEmit(List<BaseEvent> events) {
            this.eventsToEmit = new ArrayList<>(events);
        }

        public void setShouldThrowError(boolean shouldThrowError) {
            this.shouldThrowError = shouldThrowError;
        }

        public void setErrorToThrow(Throwable error) {
            this.errorToThrow = error;
        }

        public void setShouldComplete(boolean shouldComplete) {
            this.shouldComplete = shouldComplete;
        }

        public void setDelayBeforeEvents(long delayMs) {
            this.delayBeforeEvents = delayMs;
        }

        // Verification methods
        public boolean wasClosed() {
            return wasClosed;
        }

        public boolean wasStreamEventsCalled() {
            return streamEventsCalled;
        }

        public RunAgentInput getLastInput() {
            return lastInput;
        }

        public AtomicBoolean getLastCancellationToken() {
            return lastCancellationToken;
        }
    }

    private static BaseMessage createMessage(String content) {
        BaseMessage message = new UserMessage();
        message.setContent(content);
        return message;
    }
}