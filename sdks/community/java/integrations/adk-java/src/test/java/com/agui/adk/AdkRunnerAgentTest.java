package com.agui.adk;

import com.agui.core.agent.AgentSubscriber;
import com.agui.core.agent.RunAgentParameters;
import com.agui.core.event.RawEvent;
import com.agui.core.event.RunErrorEvent;
import com.google.adk.agents.RunConfig;
import com.google.adk.events.Event;
import com.google.adk.runner.Runner;
import com.google.genai.types.Content;
import io.reactivex.rxjava3.core.Flowable;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.mockito.Mockito;
import com.agui.core.exception.AGUIException;

import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

class AdkRunnerAgentTest {

    private AdkRunnerAgent adkRunnerAgent;
    private Runner runner;
    private AgentSubscriber subscriber;

    @BeforeEach
    void setUp() throws AGUIException{
        runner = mock(Runner.class);
        subscriber = mock(AgentSubscriber.class);
        adkRunnerAgent = new AdkRunnerAgent(runner, "testUser", "testSession", mock(Content.class), mock(RunConfig.class));
    }

    @Test
    void testSuccessfulExecutionWithEvents() throws ExecutionException, InterruptedException {
        Event event1 = mock(Event.class);
        Event event2 = mock(Event.class);
        when(runner.runAsync(anyString(), anyString(), any(Content.class), any(RunConfig.class)))
            .thenReturn(Flowable.just(event1, event2));

        CompletableFuture<Void> future = adkRunnerAgent.runAgent(mock(RunAgentParameters.class), subscriber);

        future.get(); // Wait for completion

        assertFalse(future.isCompletedExceptionally());
        ArgumentCaptor<RawEvent> captor = ArgumentCaptor.forClass(RawEvent.class);
        verify(subscriber, times(2)).onRawEvent(captor.capture());

        assertEquals(event1, captor.getAllValues().get(0).getRawEvent());
        assertEquals(event2, captor.getAllValues().get(1).getRawEvent());
    }

    @Test
    void testExecutionFailure() {
        // --- Setup ---
        RuntimeException exception = new RuntimeException("Test Exception");
        when(runner.runAsync(anyString(), anyString(), any(Content.class), any(RunConfig.class)))
            .thenReturn(Flowable.error(exception));

        // --- Execution ---
        CompletableFuture<Void> future = adkRunnerAgent.runAgent(mock(RunAgentParameters.class), subscriber);

        // --- Verification ---
        ExecutionException thrown = assertThrows(ExecutionException.class, future::get);
        assertEquals(exception, thrown.getCause());

        // Verify that the subscriber was notified of the failure.
        verify(subscriber, times(1)).onRunFailed(any(), any(Throwable.class));
        verify(subscriber, times(1)).onRunErrorEvent(any(RunErrorEvent.class));
        // Verify no content events were sent.
        verify(subscriber, never()).onTextMessageContentEvent(any());
    }

//    @Test
//    void testSuccessfulExecutionWithNoEvents() throws ExecutionException, InterruptedException {
//        when(runner.runAsync(anyString(), anyString(), any(Content.class), any(RunConfig.class)))
//            .thenReturn(Flowable.empty());
//
//        CompletableFuture<Void> future = adkRunnerAgent.runAgent(mock(RunAgentParameters.class), subscriber);
//
//        future.get();
//
//        assertFalse(future.isCompletedExceptionally());
//        verify(subscriber, never()).onEvent(any());
//    }

    @Test
    void getMessages() {
        assertTrue(adkRunnerAgent.getMessages().isEmpty());
    }
}