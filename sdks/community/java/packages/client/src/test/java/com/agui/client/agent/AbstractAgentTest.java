package com.agui.client.agent;

import com.agui.core.agent.AgentSubscriber;
import com.agui.core.agent.AgentSubscriberParams;
import com.agui.core.agent.RunAgentInput;
import com.agui.core.agent.RunAgentParameters;
import com.agui.core.event.*;
import com.agui.core.message.BaseMessage;
import com.agui.core.message.UserMessage;
import com.agui.core.state.State;
import com.agui.core.stream.IEventStream;
import com.agui.core.type.EventType;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatExceptionOfType;

@DisplayName("AbstractAgent")
class AbstractAgentTest {

    @Test
    void shouldCreateAgent() {
        // Arrange
        var id = UUID.randomUUID().toString();
        var description = "Agent description";
        var threadId = UUID.randomUUID().toString();
        List<BaseMessage> messages = new ArrayList<>();
        var state = new State();
        var debug = true;

        // Act
        var agent = new TestAgent(id, description, threadId, messages, state, debug);

        // Assert
        assertThat(agent.agentId).isEqualTo(id);
        assertThat(agent.messages).isEmpty();
        assertThat(agent.debug).isTrue();
        assertThat(agent.description).isEqualTo(description);
        assertThat(agent.state).isEqualTo(state);
        assertThat(agent.threadId).isEqualTo(threadId);
    }

    @Nested
    @DisplayName("Message Management")
    class MessageManagementTests {

        TestAgent testAgent;

        @BeforeEach
        void setUp() {
            testAgent = new TestAgent(
                "test-agent",
                "Test agent description",
                "test-thread",
                new ArrayList<>(),
                new State(),
                false
            );
        }

        @Test
        void shouldAddSingleMessageWithGeneratedId() {
            TestSubscriber subscriber = new TestSubscriber();
            testAgent.subscribe(subscriber);

            BaseMessage message = new UserMessage();
            message.setContent("Test message");

            testAgent.addMessage(message);

            assertThat(message.getId()).isNotNull();
            assertThat(message.getName()).isEmpty();
            assertThat(testAgent.messages).hasSize(1);
            assertThat(subscriber.getMethodCalls()).contains("onNewMessage");
        }

        @Test
        void shouldAddMessageWithExistingIdAndName() {
            // Arrange
            TestSubscriber subscriber = new TestSubscriber();
            testAgent.subscribe(subscriber);

            BaseMessage message = new UserMessage();
            message.setId("existing-id");
            message.setName("existing-name");
            message.setContent("Test message");

            // Act
            testAgent.addMessage(message);

            // Assert
            assertThat(message.getId()).isEqualTo("existing-id");
            assertThat(message.getName()).isEqualTo("existing-name");
            assertThat(testAgent.messages).hasSize(1);
        }

        @Test
        void shouldAddMultipleMessages() {
            TestSubscriber subscriber = new TestSubscriber();
            testAgent.subscribe(subscriber);

            List<BaseMessage> messages = List.of(
                createMessage("Message 1"),
                createMessage("Message 2"),
                createMessage("Message 3")
            );

            testAgent.addMessages(messages);

            assertThat(testAgent.messages).hasSize(3);
            long newMessageCalls = subscriber.getMethodCalls().stream()
                    .filter(call -> call.equals("onNewMessage"))
                    .count();
            assertThat(newMessageCalls).isEqualTo(3);
        }

        @Test
        void shouldReplaceAllMessagesAndNotifySubscribers() {
            TestSubscriber subscriber = new TestSubscriber();
            testAgent.subscribe(subscriber);

            testAgent.addMessage(createMessage("Old message"));
            subscriber.getMethodCalls().clear(); // Clear previous calls

            List<BaseMessage> newMessages = List.of(
                createMessage("New message 1"),
                createMessage("New message 2")
            );

            testAgent.setMessages(newMessages);

            assertThat(testAgent.messages).hasSize(2);
            assertThat(testAgent.messages.get(0).getContent()).isEqualTo("New message 1");
            assertThat(subscriber.getMethodCalls()).contains("onMessagesChanged");
        }

        @Test
        void shouldHandleSubscriberErrorsWhenAddingMessages() {
            // Arrange
            TestSubscriber faultySubscriber = new TestSubscriber() {
                @Override
                public void onNewMessage(BaseMessage message) {
                    super.onNewMessage(message);
                    throw new RuntimeException("Subscriber error");
                }
            };
            testAgent.subscribe(faultySubscriber);

            BaseMessage message = createMessage("Test message");

            testAgent.addMessage(message);
            assertThat(testAgent.messages).hasSize(1);
        }

        private BaseMessage createMessage(String content) {
            BaseMessage message = new UserMessage();
            message.setContent(content);
            return message;
        }
    }

    @Nested
    @DisplayName("State Management")
    class StateManagementTests {

        TestAgent testAgent;

        @BeforeEach
        void setUp() {
            testAgent = new TestAgent(
                "test-agent",
                "Test agent description",
                "test-thread",
                new ArrayList<>(),
                new State(),
                false
            );
        }

        @Test
        void shouldUpdateState() {
            State newState = new State();
            newState.set("key", "value");

            testAgent.setState(newState);

            assertThat(testAgent.getState()).isEqualTo(newState);
            assertThat(testAgent.getState().get("key")).isEqualTo("value");
        }

        @Test
        void shouldHandleNullState() {
            testAgent.setState(null);

            assertThat(testAgent.getState()).isNull();
        }
    }

    @Nested
    @DisplayName("Subscription Management")
    class SubscriptionManagementTests {

        TestAgent testAgent;

        @BeforeEach
        void setUp() {
            testAgent = new TestAgent(
                "test-agent",
                "Test agent description",
                "test-thread",
                new ArrayList<>(),
                new State(),
                false
            );
        }

        @Test
        void shouldHandleMultipleUnsubscriptionsSafely() {
            TestSubscriber subscriber = new TestSubscriber();
            var subscription = testAgent.subscribe(subscriber);

            subscription.unsubscribe();
            subscription.unsubscribe();
            subscription.unsubscribe();

            TestSubscriber testSubscriber = new TestSubscriber();
            try {
                testAgent.runAgent(RunAgentParameters.empty(), testSubscriber).get(5, TimeUnit.SECONDS);
                assertThat(testSubscriber.wasOnRunInitializedCalled()).isTrue();
            } catch (Exception e) {
                // Should not happen
                throw new RuntimeException(e);
            }
        }
    }

    @Nested
    @DisplayName("Edge Cases and Error Handling")
    class EdgeCasesTests {

        TestAgent testAgent;
        RunAgentParameters parameters;

        @BeforeEach
        void setUp() {
            testAgent = new TestAgent(
                "test-agent",
                "Test agent description",
                "test-thread",
                new ArrayList<>(),
                new State(),
                true // Enable debug mode
            );

            parameters = RunAgentParameters.empty();
        }

        @Test
        void shouldHandleInterruptedThreadDuringDelay() {
            TestSubscriber subscriber = new TestSubscriber();
            testAgent.setDelay(5000);

            CompletableFuture<Void> future = testAgent.runAgent(parameters, subscriber);

            CompletableFuture.runAsync(() -> {
                try {
                    Thread.sleep(100);
                    future.cancel(true);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            });

            assertThatExceptionOfType(Exception.class)
                    .isThrownBy(() -> future.get(2, TimeUnit.SECONDS));
        }

        @Test
        void shouldCompleteWithoutEvents() throws Exception {
            // Arrange
            TestSubscriber subscriber = new TestSubscriber();
            testAgent.setEventsToEmit(List.of()); // No events

            // Act
            CompletableFuture<Void> future = testAgent.runAgent(parameters, subscriber);
            future.get(5, TimeUnit.SECONDS);

            // Assert
            assertThat(future).isDone();
            assertThat(subscriber.getEventCount()).isEqualTo(1); // Only the finish event
            assertThat(subscriber.getMethodCalls()).contains("onRunFinishedEvent");
        }

        @Test
        void shouldWorkWithDebugModeEnabled() throws Exception {
            TestAgent debugAgent = new TestAgent(
                "debug-agent",
                "Debug agent",
                "debug-thread",
                new ArrayList<>(),
                new State(),
                true // debug enabled
            );

            TestSubscriber subscriber = new TestSubscriber();

            BaseEvent unknownEvent = new BaseEvent(EventType.CUSTOM) {
            };

            debugAgent.setEventsToEmit(List.of(unknownEvent));

            CompletableFuture<Void> future = debugAgent.runAgent(parameters, subscriber);
            future.get(5, TimeUnit.SECONDS);

            assertThat(future).isDone();
            assertThat(debugAgent.debug).isTrue();
        }
    }

    @Test
    void shouldCreateAgentWithDefaults() {
        var agent = new TestAgent(null, null, null, null, null, false);

        assertThat(agent.agentId).isNull(); // Will be generated in runAgent
        assertThat(agent.description).isEmpty();
        assertThat(agent.threadId).isNotNull(); // UUID generated
        assertThat(agent.messages).isEmpty();
        assertThat(agent.state).isNotNull();
        assertThat(agent.debug).isFalse();
    }

    @Nested
    @DisplayName("runAgent method")
    class RunAgentTests {

        TestAgent testAgent;
        RunAgentParameters parameters;

        @BeforeEach
        void setUp() {
            testAgent = new TestAgent(
                "test-agent",
                "Test agent description",
                "test-thread",
                new ArrayList<>(),
                new State(),
                false
            );

            parameters = RunAgentParameters.builder()
                .runId("test-run-id")
                .tools(new ArrayList<>())
                .context(new ArrayList<>())
                .build();
        }

        @Test
        void shouldCompleteSuccessfullyWithEvents() throws Exception {
            TestSubscriber subscriber = new TestSubscriber();
            RunStartedEvent startEvent = new RunStartedEvent();

            testAgent.setEventsToEmit(List.of(startEvent));

            CompletableFuture<Void> future = testAgent.runAgent(parameters, subscriber);
            future.get(5, TimeUnit.SECONDS);

            assertThat(future).isDone();
            assertThat(future.isCompletedExceptionally()).isFalse();

            assertThat(subscriber.wasOnRunInitializedCalled()).isTrue();
            assertThat(subscriber.wasOnRunFinalizedCalled()).isTrue();
            assertThat(subscriber.wasOnRunErrorCalled()).isFalse();

            assertThat(subscriber.getEventCount()).isEqualTo(2);
            assertThat(subscriber.getMethodCalls())
                .contains("onRunInitialized", "onRunFinalized", "onRunStartedEvent", "onRunFinishedEvent");
        }

        @Test
        void shouldHandleExceptionsProperly() {
            TestSubscriber subscriber = new TestSubscriber();
            testAgent.setShouldThrowException(true);

            CompletableFuture<Void> future = testAgent.runAgent(parameters, subscriber);

            assertThatExceptionOfType(ExecutionException.class)
                .isThrownBy(() -> future.get(5, TimeUnit.SECONDS))
                .withCauseInstanceOf(RuntimeException.class)
                .withMessageContaining("Test exception");

            assertThat(future.isCompletedExceptionally()).isTrue();

            assertThat(subscriber.wasOnRunInitializedCalled()).isTrue();
            assertThat(subscriber.wasOnRunErrorCalled()).isTrue();
            assertThat(subscriber.wasOnRunFinalizedCalled()).isFalse();
            assertThat(subscriber.getMethodCalls()).contains("onRunErrorEvent");
        }

        @Test
        void shouldWorkWithNullSubscriber() throws Exception {
            RunStartedEvent startEvent = new RunStartedEvent();
            testAgent.setEventsToEmit(List.of(startEvent));

            CompletableFuture<Void> future = testAgent.runAgent(parameters, null);
            future.get(5, TimeUnit.SECONDS);

            assertThat(future).isDone();
            assertThat(future.isCompletedExceptionally()).isFalse();
        }

        @Test
        void shouldNotifyBothPersistentAndRunSpecificSubscribers() throws Exception {
            TestSubscriber persistentSubscriber = new TestSubscriber();
            TestSubscriber runSubscriber = new TestSubscriber();

            testAgent.subscribe(persistentSubscriber);

            RunStartedEvent startEvent = new RunStartedEvent();
            testAgent.setEventsToEmit(List.of(startEvent));

            CompletableFuture<Void> future = testAgent.runAgent(parameters, runSubscriber);
            future.get(5, TimeUnit.SECONDS);

            assertThat(future).isDone();

            assertThat(persistentSubscriber.wasOnRunInitializedCalled()).isTrue();
            assertThat(persistentSubscriber.wasOnRunFinalizedCalled()).isTrue();
            assertThat(persistentSubscriber.getEventCount()).isEqualTo(2); // start + finish events

            assertThat(runSubscriber.wasOnRunInitializedCalled()).isTrue();
            assertThat(runSubscriber.wasOnRunFinalizedCalled()).isTrue();
            assertThat(runSubscriber.getEventCount()).isEqualTo(2); // start + finish events
        }

        @Test
        void shouldProcessMultipleEventsInSequence() throws Exception {
            TestSubscriber subscriber = new TestSubscriber();

            RunStartedEvent startEvent = new RunStartedEvent();
            StepStartedEvent stepEvent = new StepStartedEvent();
            StepFinishedEvent stepFinishedEvent = new StepFinishedEvent();

            testAgent.setEventsToEmit(List.of(startEvent, stepEvent, stepFinishedEvent));

            CompletableFuture<Void> future = testAgent.runAgent(parameters, subscriber);
            future.get(5, TimeUnit.SECONDS);

            assertThat(future).isDone();
            assertThat(future.isCompletedExceptionally()).isFalse();

            assertThat(subscriber.getEventCount()).isEqualTo(4);
            assertThat(subscriber.getMethodCalls()).contains(
                "onRunStartedEvent",
                "onStepStartedEvent",
                "onStepFinishedEvent",
                "onRunFinishedEvent"
            );
        }

        @Test
        void shouldWorkWithEmptyParameters() throws Exception {
            TestSubscriber subscriber = new TestSubscriber();
            RunAgentParameters emptyParams = RunAgentParameters.empty();

            CompletableFuture<Void> future = testAgent.runAgent(emptyParams, subscriber);
            future.get(5, TimeUnit.SECONDS);

            assertThat(future).isDone();
            assertThat(future.isCompletedExceptionally()).isFalse();
            assertThat(subscriber.wasOnRunInitializedCalled()).isTrue();
            assertThat(subscriber.wasOnRunFinalizedCalled()).isTrue();
        }

        @Test
        void shouldGenerateAgentIdWhenNull() throws Exception {
            TestAgent agentWithNullId = new TestAgent(
                null, // null agentId
                "Test description",
                "test-thread",
                new ArrayList<>(),
                new State(),
                false
            );
            TestSubscriber subscriber = new TestSubscriber();

            CompletableFuture<Void> future = agentWithNullId.runAgent(parameters, subscriber);
            future.get(5, TimeUnit.SECONDS);

            assertThat(future).isDone();
            assertThat(agentWithNullId.agentId).isNotNull();
            assertThat(subscriber.wasOnRunInitializedCalled()).isTrue();
        }

        @Test
        void shouldTimeoutForLongRunningOperations() {
            TestSubscriber subscriber = new TestSubscriber();
            testAgent.setDelay(10000); // 10 second delay

            CompletableFuture<Void> future = testAgent.runAgent(parameters, subscriber);

            assertThatExceptionOfType(TimeoutException.class)
                .isThrownBy(() -> future.get(1, TimeUnit.SECONDS));

            assertThat(future).isNotDone();
        }

        @Test
        void shouldHandleTextMessageEventsProperly() throws Exception {
            TestSubscriber subscriber = new TestSubscriber();

            TextMessageStartEvent startEvent = new TextMessageStartEvent();
            startEvent.setMessageId("msg-123");

            TextMessageContentEvent contentEvent = new TextMessageContentEvent();
            contentEvent.setMessageId("msg-123");
            contentEvent.setDelta("Hello ");

            TextMessageEndEvent endEvent = new TextMessageEndEvent();
            endEvent.setMessageId("msg-123");

            testAgent.setEventsToEmit(List.of(startEvent, contentEvent, endEvent));

            CompletableFuture<Void> future = testAgent.runAgent(parameters, subscriber);
            future.get(5, TimeUnit.SECONDS);

            assertThat(future).isDone();
            assertThat(subscriber.getMethodCalls()).contains(
                "onTextMessageStartEvent",
                "onTextMessageContentEvent",
                "onTextMessageEndEvent"
            );
        }

        @Test
        void shouldHandleToolCallEventsProperly() throws Exception {
            TestSubscriber subscriber = new TestSubscriber();

            ToolCallStartEvent startEvent = new ToolCallStartEvent();
            ToolCallArgsEvent argsEvent = new ToolCallArgsEvent();
            ToolCallResultEvent resultEvent = new ToolCallResultEvent();
            ToolCallEndEvent endEvent = new ToolCallEndEvent();

            testAgent.setEventsToEmit(List.of(startEvent, argsEvent, resultEvent, endEvent));

            CompletableFuture<Void> future = testAgent.runAgent(parameters, subscriber);
            future.get(5, TimeUnit.SECONDS);

            assertThat(future).isDone();
            assertThat(subscriber.getMethodCalls()).contains(
                "onToolCallStartEvent",
                "onToolCallArgsEvent",
                "onToolCallResultEvent",
                "onToolCallEndEvent"
            );
        }
    }

    private static class TestSubscriber implements AgentSubscriber {
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
        public void onRunInitialized(AgentSubscriberParams params) {
            onRunInitializedCalled.set(true);
            methodCalls.add("onRunInitialized");
        }

        @Override
        public void onRunFinalized(AgentSubscriberParams params) {
            onRunFinalizedCalled.set(true);
            methodCalls.add("onRunFinalized");
        }

        @Override
        public void onRunStartedEvent(RunStartedEvent event) {
            methodCalls.add("onRunStartedEvent");
        }

        @Override
        public void onRunErrorEvent(RunErrorEvent event) {
            onRunErrorCalled.set(true);
            methodCalls.add("onRunErrorEvent");
        }

        @Override
        public void onRunFinishedEvent(RunFinishedEvent event) {
            methodCalls.add("onRunFinishedEvent");
        }

        @Override
        public void onStepStartedEvent(StepStartedEvent event) {
            methodCalls.add("onStepStartedEvent");
        }

        @Override
        public void onStepFinishedEvent(StepFinishedEvent event) {
            methodCalls.add("onStepFinishedEvent");
        }

        @Override
        public void onTextMessageStartEvent(TextMessageStartEvent event) {
            methodCalls.add("onTextMessageStartEvent");
        }

        @Override
        public void onTextMessageContentEvent(TextMessageContentEvent event) {
            methodCalls.add("onTextMessageContentEvent");
        }

        @Override
        public void onTextMessageEndEvent(TextMessageEndEvent event) {
            methodCalls.add("onTextMessageEndEvent");
        }

        @Override
        public void onToolCallStartEvent(ToolCallStartEvent event) {
            methodCalls.add("onToolCallStartEvent");
        }

        @Override
        public void onToolCallArgsEvent(ToolCallArgsEvent event) {
            methodCalls.add("onToolCallArgsEvent");
        }

        @Override
        public void onToolCallResultEvent(ToolCallResultEvent event) {
            methodCalls.add("onToolCallResultEvent");
        }

        @Override
        public void onToolCallEndEvent(ToolCallEndEvent event) {
            methodCalls.add("onToolCallEndEvent");
        }

        @Override
        public void onRawEvent(RawEvent event) {
            methodCalls.add("onRawEvent");
        }

        @Override
        public void onCustomEvent(CustomEvent event) {
            methodCalls.add("onCustomEvent");
        }

        @Override
        public void onMessagesSnapshotEvent(MessagesSnapshotEvent event) {
            methodCalls.add("onMessagesSnapshotEvent");
        }

        @Override
        public void onStateSnapshotEvent(StateSnapshotEvent event) {
            methodCalls.add("onStateSnapshotEvent");
        }

        @Override
        public void onStateDeltaEvent(StateDeltaEvent event) {
            methodCalls.add("onStateDeltaEvent");
        }

        @Override
        public void onNewMessage(BaseMessage message) {
            methodCalls.add("onNewMessage");
        }

        @Override
        public void onMessagesChanged(AgentSubscriberParams params) {
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

    class TestAgent extends AbstractAgent {
        private boolean shouldThrowException = false;
        private List<BaseEvent> eventsToEmit = new ArrayList<>();
        private long delayMs = 0;

        public TestAgent(String agentId, String description, String threadId,
                         List<BaseMessage> initialMessages, State state, boolean debug) {
            super(agentId, description, threadId, initialMessages, state, debug);
        }

        public void setShouldThrowException(boolean shouldThrowException) {
            this.shouldThrowException = shouldThrowException;
        }

        public void setEventsToEmit(List<BaseEvent> events) {
            this.eventsToEmit = new ArrayList<>(events);
        }

        public void setDelay(long delayMs) {
            this.delayMs = delayMs;
        }

        @Override
        protected void run(RunAgentInput input, IEventStream<BaseEvent> stream) {
            if (delayMs > 0) {
                try {
                    Thread.sleep(delayMs);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    throw new RuntimeException("Interrupted", e);
                }
            }

            if (shouldThrowException) {
                throw new RuntimeException("Test exception");
            }

            // Emit test events
            for (BaseEvent event : eventsToEmit) {
                stream.next(event);
            }

            // Always emit run finished to complete the execution
            RunFinishedEvent finishedEvent = new RunFinishedEvent();
            stream.next(finishedEvent);
        }
    }
}