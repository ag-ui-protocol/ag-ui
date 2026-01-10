import com.agui.core.event.RunErrorEvent;
import com.agui.core.event.RunFinishedEvent;
import com.agui.core.event.RunStartedEvent;
import com.agui.core.message.UserMessage;
import com.google.adk.agents.RunConfig;
import com.google.adk.events.Event;
import com.google.adk.runner.Runner;
import com.google.adk.sessions.Session;
import io.reactivex.rxjava3.core.Flowable;
import io.reactivex.rxjava3.core.Single;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mock;
import org.mockito.MockitoAnnotations;

import java.util.List;
import java.util.Set;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

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

    @BeforeEach
    void setUp() {
        MockitoAnnotations.openMocks(this);

        // When runner.appName() is called, return a test app name
        when(runner.appName()).thenReturn("test-app");

        // Mock the event translator factory to return our mock translator
        when(eventTranslatorFactory.create(anyString(), anyString())).thenReturn(eventTranslator);
        when(eventTranslator.apply(any())).thenAnswer(invocation -> invocation.getArgument(0)); // Pass through events

        // Create the real adapter instance to be tested, injecting the mocks
        aguiAdkRunnerAdapter = new AguiAdkRunnerAdapter(
                runner,
                sessionManager,
                RunConfig.builder().build(),
                params -> "test-user", // userIdExtractor remains
                eventTranslatorFactory
        );
    }

    @Test
    void shouldCompleteSuccessfully_whenRunAgentIsCalled() {
        // Arrange
        Session mockSession = mock(Session.class);
        SessionManager.SessionWithProcessedIds sessionData = new SessionManager.SessionWithProcessedIds(mockSession, Set.of());
        when(sessionManager.getSessionAndProcessedMessageIds(any(RunContext.class)))
                .thenReturn(Single.just(sessionData));

        Event adkEvent = mock(Event.class);
        when(runner.runAsync(anyString(), anyString(), any(), any())).thenReturn(Flowable.just(adkEvent));

        UserMessage userMessage = new UserMessage();
        userMessage.setId("1");
        userMessage.setContent("Hello");

        RunAgentParameters params = RunAgentParameters.builder()
                .threadId(UUID.randomUUID().toString())
                .messages(List.of(userMessage))
                .context(List.of(new Context("appName", "test-app")))
                .build();

        // Act
        List<BaseEvent> results = aguiAdkRunnerAdapter.runAgent(params).toList().blockingGet();

        // Assert
        // Verify that the stream contains the correct lifecycle events.
        assertThat(results).anyMatch(e -> e instanceof RunStartedEvent);
        assertThat(results).anyMatch(e -> e instanceof RunFinishedEvent);

        // Verify our factory was asked to create a translator
        verify(eventTranslatorFactory, times(1)).create(anyString(), anyString());

        // Verify the ADK runner was executed with the correct user and session IDs
        verify(runner).runAsync(eq("test-user"), eq(params.getThreadId()), any(), any());

        // Verify that the translator was applied
        verify(eventTranslator, times(1)).apply(any());
    }

    @Test
    void shouldReturnErrorEvent_whenSessionManagerFails() {
        // Arrange
        when(sessionManager.getSessionAndProcessedMessageIds(any(RunContext.class)))
                .thenReturn(Single.error(new RuntimeException("Session service down")));

        RunAgentParameters params = RunAgentParameters.builder()
                .threadId(UUID.randomUUID().toString())
                .messages(List.of(new UserMessage()))
                .context(List.of(new Context("appName", "test-app")))
                .build();
        
        // Act
        List<BaseEvent> results = aguiAdkRunnerAdapter.runAgent(params).toList().blockingGet();

        // Assert
        // Should have Start, then Error (no Finish)
        assertThat(results).hasSize(2);
        assertThat(results.get(0)).isInstanceOf(RunStartedEvent.class);
        assertThat(results.get(1)).isInstanceOf(RunErrorEvent.class);
        assertEquals("Session service down", ((RunErrorEvent) results.get(1)).getMessage());
    @Test
    void shouldOnlyEmitStartAndFinish_whenNoUnseenMessages() {
        // Arrange
        String messageId = "msg-already-processed";
        UserMessage userMessage = new UserMessage();
        userMessage.setId(messageId);
        userMessage.setContent("Hello");

        Session mockSession = mock(Session.class);
        // Mock the SessionManager to return a set containing the message ID
        SessionManager.SessionWithProcessedIds sessionData = new SessionManager.SessionWithProcessedIds(mockSession, Set.of(messageId));
        when(sessionManager.getSessionAndProcessedMessageIds(any(RunContext.class)))
                .thenReturn(Single.just(sessionData));

        RunAgentParameters params = RunAgentParameters.builder()
                .threadId(UUID.randomUUID().toString())
                .messages(List.of(userMessage))
                .context(List.of(new Context("appName", "test-app")))
                .build();

        // Act
        List<BaseEvent> results = aguiAdkRunnerAdapter.runAgent(params).toList().blockingGet();

        // Assert
        // Should have only Start and Finish events
        assertThat(results).hasSize(2);
        assertThat(results.get(0)).isInstanceOf(RunStartedEvent.class);
        assertThat(results.get(1)).isInstanceOf(RunFinishedEvent.class);

        // Verify the runner was never called
        verify(runner, never()).runAsync(anyString(), anyString(), any(), any());
    }
}