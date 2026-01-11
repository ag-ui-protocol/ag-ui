package com.agui.adk;

import com.agui.adk.processor.MessageChunk;
import com.agui.adk.processor.MessageProcessor;
import com.agui.adk.translator.EventTranslator;
import com.agui.adk.translator.EventTranslatorFactory;
import com.agui.core.agent.RunAgentParameters;
import com.agui.core.context.Context;
import com.agui.core.event.BaseEvent;
import com.agui.core.event.RunErrorEvent;
import com.agui.core.event.RunFinishedEvent;
import com.agui.core.event.RunStartedEvent;
import com.agui.core.message.UserMessage;
import com.google.adk.agents.RunConfig;
import com.google.adk.events.Event;
import com.google.adk.runner.Runner;
import com.google.adk.sessions.Session;
import com.google.genai.types.Content;
import io.reactivex.rxjava3.core.Completable;
import io.reactivex.rxjava3.core.Flowable;
import io.reactivex.rxjava3.core.Single;
import io.reactivex.rxjava3.subscribers.TestSubscriber;
import org.jetbrains.annotations.NotNull;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

@ExtendWith(MockitoExtension.class)
class AguiAdkRunnerAdapterTest {

    private AguiAdkRunnerAdapter aguiAdkRunnerAdapter;

    @Mock
    private Runner runner;
    @Mock
    private SessionManager sessionManager;
    @Mock
    private EventTranslatorFactory eventTranslatorFactory;
    @Mock
    private EventTranslator eventTranslator;
    @Mock
    private MessageProcessor messageProcessor;

    @BeforeEach
    void setUp() {
        when(runner.appName()).thenReturn("test-app");

        // Mock the event translator factory to return our mock translator
        lenient().when(eventTranslatorFactory.create(anyString(), anyString())).thenReturn(eventTranslator);
        lenient().when(eventTranslator.apply(any())).thenAnswer(invocation -> invocation.getArgument(0)); // Pass through events

        aguiAdkRunnerAdapter = new AguiAdkRunnerAdapter(
                runner,
                sessionManager,
                RunConfig.builder().build(),
                params -> "test-user",
                eventTranslatorFactory,
                messageProcessor
        );
    }

    void shouldCompleteSuccessfully_whenRunAgentIsCalled() throws InterruptedException {
        // Arrange
        UserMessage userMessage = createUserMessage("1");
        RunAgentParameters params = createAgentParameters(userMessage);

        Session mockSession = mock(Session.class);
        SessionManager.SessionWithProcessedIds sessionData = new SessionManager.SessionWithProcessedIds(mockSession, Set.of());
        when(sessionManager.getSessionAndProcessedMessageIds(any(RunContext.class)))
                .thenReturn(Single.just(sessionData));
        when(sessionManager.markMessagesProcessed(any(), anyList())).thenReturn(Completable.complete());

        // Mock the message processor to return a chunk, ensuring startNewExecution is called
        MessageChunk chunk = MessageChunk.fromUserSystemChunk(List.of(userMessage));
        when(messageProcessor.groupMessagesIntoChunks(anyList())).thenReturn(List.of(chunk));
        
        // Mock the message processor to return some content, ensuring the runner is called
        Content mockContent = mock(Content.class);
        when(messageProcessor.constructMessageToSend(anyList(), anyList())).thenReturn(Optional.of(mockContent));

        Event adkEvent = mock(Event.class);
        when(runner.runAsync(anyString(), anyString(), any(), any())).thenReturn(Flowable.just(adkEvent));

        // This mock is specific to this test, where the stream is passed to the translator
        when(eventTranslator.apply(any())).thenReturn(Flowable.empty());

        // Act
        TestSubscriber<BaseEvent> testSubscriber = new TestSubscriber<>();
        aguiAdkRunnerAdapter.runAgent(params).subscribe(testSubscriber);
        
        testSubscriber.await();

        // Assert
        testSubscriber.assertComplete();
        testSubscriber.assertNoErrors();
        
        List<BaseEvent> results = testSubscriber.values();
        assertThat(results).anyMatch(e -> e instanceof RunStartedEvent);
        assertThat(results).anyMatch(e -> e instanceof RunFinishedEvent);

        verify(eventTranslatorFactory, times(1)).create(anyString(), anyString());
        verify(runner).runAsync(eq("test-user"), eq(params.getThreadId()), eq(mockContent), any());
        verify(eventTranslator, times(1)).apply(any());
    }

    @Test
    void shouldReturnErrorEvent_whenSessionManagerFails() throws InterruptedException {
        // Arrange
        when(sessionManager.getSessionAndProcessedMessageIds(any(RunContext.class)))
                .thenReturn(Single.error(new RuntimeException("Session service down")));

        RunAgentParameters params = createAgentParameters(new UserMessage());

        // Act
        TestSubscriber<BaseEvent> testSubscriber = new TestSubscriber<>();
        aguiAdkRunnerAdapter.runAgent(params).subscribe(testSubscriber);

        testSubscriber.await();
        
        // Assert
        testSubscriber.assertComplete(); // onErrorResumeNext completes the stream
        testSubscriber.assertNoErrors(); // The error is caught and emitted as a value
        
        List<BaseEvent> results = testSubscriber.values();
        assertThat(results).hasSize(2);
        assertThat(results.get(0)).isInstanceOf(RunStartedEvent.class);
        assertThat(results.get(1)).isInstanceOf(RunErrorEvent.class);
        // Cannot assert on message content as it is not exposed by RunErrorEvent in a known way
    }

    @Test
    void shouldOnlyEmitStartAndFinish_whenNoUnseenMessages() throws InterruptedException {
        // Arrange
        String messageId = "msg-already-processed";
        UserMessage userMessage = createUserMessage(messageId);

        Session mockSession = mock(Session.class);
        SessionManager.SessionWithProcessedIds sessionData = new SessionManager.SessionWithProcessedIds(mockSession, Set.of(messageId));
        when(sessionManager.getSessionAndProcessedMessageIds(any(RunContext.class)))
                .thenReturn(Single.just(sessionData));

        RunAgentParameters params = createAgentParameters(userMessage);

        // Act
        TestSubscriber<BaseEvent> testSubscriber = new TestSubscriber<>();
        aguiAdkRunnerAdapter.runAgent(params).subscribe(testSubscriber);

        testSubscriber.await();

        // Assert
        testSubscriber.assertComplete();
        testSubscriber.assertNoErrors();
        
        List<BaseEvent> results = testSubscriber.values();
        assertThat(results).hasSize(2);
        assertThat(results.get(0)).isInstanceOf(RunStartedEvent.class);
        assertThat(results.get(1)).isInstanceOf(RunFinishedEvent.class);
        verify(runner, never()).runAsync(anyString(), anyString(), any(), any());
    }

    @NotNull
    private static UserMessage createUserMessage(String messageId) {
        UserMessage userMessage = new UserMessage();
        userMessage.setId(messageId);
        userMessage.setContent("Hello");
        return userMessage;
    }

    private static RunAgentParameters createAgentParameters(UserMessage userMessage) {
        return RunAgentParameters.builder()
                .threadId(UUID.randomUUID().toString())
                .messages(List.of(userMessage))
                .context(List.of(new Context("appName", "test-app")))
                .build();
    }
}