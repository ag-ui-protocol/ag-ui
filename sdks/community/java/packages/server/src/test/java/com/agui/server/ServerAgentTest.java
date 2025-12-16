package com.agui.server;

import com.agui.core.agent.AgentSubscriber;
import com.agui.core.event.RunFinishedEvent;
import com.agui.core.event.RunStartedEvent;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import static org.mockito.Mockito.*;

/**
 * Unit test for the abstract ServerAgent base class.
 * This test focuses on the concrete logic implemented in ServerAgent, which is the emitEvent method.
 */
class ServerAgentTest {

    // We need a concrete implementation of the abstract ServerAgent to test it.
    private static class TestableServerAgent extends ServerAgent {
        // The methods from the Agent interface are not relevant for this test.
        @Override
        public java.util.List<com.agui.core.message.BaseMessage> getMessages() { return null; }
        @Override
        public java.util.concurrent.CompletableFuture<Void> runAgent(com.agui.core.agent.RunAgentParameters parameters, AgentSubscriber subscriber) { return null; }
    }

    private ServerAgent serverAgent;
    private AgentSubscriber mockSubscriber;

    @BeforeEach
    void setUp() {
        serverAgent = new TestableServerAgent();
        mockSubscriber = mock(AgentSubscriber.class);
    }

    @Test
    void emitEvent_shouldCallGenericOnEvent_andSpecificTypedHandler() {
        // 1. --- Setup ---
        RunStartedEvent runStartedEvent = new RunStartedEvent();

        // 2. --- Execution ---
        serverAgent.emitEvent(runStartedEvent, mockSubscriber);

        // 3. --- Verification ---
        // Verify the generic onEvent was called
        verify(mockSubscriber, times(1)).onEvent(runStartedEvent);

        // Verify the specific, typed handler was also called
        verify(mockSubscriber, times(1)).onRunStartedEvent(runStartedEvent);

        // Verify no other specific handlers were called
        verify(mockSubscriber, never()).onRunFinishedEvent(any());
        verify(mockSubscriber, never()).onTextMessageStartEvent(any());
    }

    @Test
    void emitEvent_dispatchesToCorrectHandler_forDifferentEventType() {
        // 1. --- Setup ---
        RunFinishedEvent runFinishedEvent = new RunFinishedEvent();

        // 2. --- Execution ---
        serverAgent.emitEvent(runFinishedEvent, mockSubscriber);

        // 3. --- Verification ---
        // Verify the generic onEvent was called
        verify(mockSubscriber, times(1)).onEvent(runFinishedEvent);

        // Verify the correct specific handler was called this time
        verify(mockSubscriber, times(1)).onRunFinishedEvent(runFinishedEvent);

        // Verify the other specific handler was not called
        verify(mockSubscriber, never()).onRunStartedEvent(any());
    }
}
