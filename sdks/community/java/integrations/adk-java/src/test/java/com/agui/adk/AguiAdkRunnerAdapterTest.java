package com.agui.adk;

import com.agui.core.agent.AgentSubscriber;
import com.agui.core.agent.RunAgentParameters;
import com.agui.core.context.Context;
import com.agui.core.event.RunFinishedEvent;
import com.agui.core.event.RunStartedEvent;
import com.agui.core.exception.AGUIException;
import com.agui.core.message.UserMessage;
import com.google.adk.agents.RunConfig;
import com.google.adk.events.Event;
import com.google.adk.runner.Runner;
import com.google.adk.sessions.BaseSessionService;
import com.google.adk.sessions.Session;
import io.reactivex.rxjava3.core.Flowable;
import io.reactivex.rxjava3.core.Maybe;
import io.reactivex.rxjava3.core.Single;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.*;

class AguiAdkRunnerAdapterTest {

    private AguiAdkRunnerAdapter aguiAdkRunnerAdapter;
    private Runner runner; // CHANGED: Removed RunnerFactory
    private EventTranslator eventTranslator;
    private EventTranslatorFactory eventTranslatorFactory;

    @BeforeEach
    void setUp() throws AGUIException {
        // Mock services and factories
        BaseSessionService sessionService = mock(BaseSessionService.class);
        runner = mock(Runner.class);
        eventTranslator = mock(EventTranslator.class);
        eventTranslatorFactory = mock(EventTranslatorFactory.class);

        Session mockSession = mock(Session.class);
        when(sessionService.getSession(anyString(), anyString(), anyString(), any()))
                .thenReturn(Maybe.just(mockSession));
        when(sessionService.createSession(anyString(), anyString(), any(), anyString()))
                .thenReturn(Single.just(mockSession));

        // When runner.appName() is called within the adapter, it should return this.
        when(runner.appName()).thenReturn("test-app"); // CHANGED: getAppName instead of appName()

        // Create a real SessionManager with the mocked service
        SessionManager sessionManager = new SessionManager(
                sessionService,
                null,
                Duration.ofMinutes(20),
                Duration.ofMinutes(5)
        );

        RunConfig runConfig = RunConfig.builder().build();

        when(eventTranslator.translate(any())).thenReturn(Flowable.empty());
        when(eventTranslator.forceCloseStreamingMessage()).thenReturn(Flowable.empty());
        when(eventTranslatorFactory.create()).thenReturn(eventTranslator);

        // Create the real agent instance to be tested, injecting the mocks
        aguiAdkRunnerAdapter = new AguiAdkRunnerAdapter(
                runner, // CHANGED: pass runner directly
                sessionManager,
                runConfig,
                params -> "test-user", // userIdExtractor remains
                eventTranslatorFactory
        );
    }

    @Test
    void runAgent_shouldCompleteSuccessfully_andCallSubscriberEvents() {
        // 1. --- Setup ---
        Event adkEvent = mock(Event.class);
        when(adkEvent.content()).thenReturn(Optional.empty());
        Flowable<Event> adkFlowable = Flowable.just(adkEvent);
        when(runner.runAsync(anyString(), anyString(), any(), any())).thenReturn(adkFlowable);

        AgentSubscriber subscriber = mock(AgentSubscriber.class);

        UserMessage userMessage = new UserMessage();
        userMessage.setId("1");
        userMessage.setContent("Hello");

        RunAgentParameters params = RunAgentParameters.builder()
                .threadId(UUID.randomUUID().toString()).messages(List.of(userMessage))
                .context(List.of(new Context("appName", "test-app")))
                .build();

        // 2. --- Execution ---
        CompletableFuture<Void> future = aguiAdkRunnerAdapter.runAgent(params, subscriber);
        future.join();

        // 3. --- Verification ---
        // Verify that the subscriber received the correct lifecycle events.
        verify(subscriber, times(1)).onRunStartedEvent(any(RunStartedEvent.class));
        verify(subscriber, times(1)).onRunFinishedEvent(any(RunFinishedEvent.class));

        // Verify our factory was asked to create a translator
        verify(eventTranslatorFactory, times(1)).create();

        // CHANGED: No longer verifying runnerFactory.getRunner
        // verify(runnerFactory).getRunner("test-app");

        // Verify the ADK runner was executed with the correct user and session IDs
        verify(runner).runAsync(eq("test-user"), eq(params.getThreadId()), any(), any());

        // Verify that the translator was called
        verify(eventTranslator, times(1)).translate(any());
    }
}