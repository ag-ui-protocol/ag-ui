package com.agui.adk.translator;

import com.agui.adk.translator.step.EventTranslationStep;
import com.agui.core.event.BaseEvent;
import com.agui.core.event.RunFinishedEvent;
import com.agui.core.event.RunStartedEvent;
import com.google.adk.events.Event;
import io.reactivex.rxjava3.core.Flowable;
import io.reactivex.rxjava3.subscribers.TestSubscriber;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mock;
import org.mockito.MockitoAnnotations;

import java.util.List;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

class EventTranslatorTest {

    private EventTranslator eventTranslator;

    @Mock
    private TranslationContext context;
    @Mock
    private EventTranslationStep step1;
    @Mock
    private EventTranslationStep step2;

    private String threadId = "thread-123";
    private String runId = "run-456";

    @BeforeEach
    void setUp() {
        MockitoAnnotations.openMocks(this);
        // Create the translator with a list of mock steps
        eventTranslator = new EventTranslator(context, List.of(step1, step2));
        
        // Mock the context to return the IDs
        when(context.getThreadId()).thenReturn(threadId);
        when(context.getRunId()).thenReturn(runId);
    }

    @Test
    void shouldWrapStreamWithStartAndFinishEvents_whenApplied() {
        // Arrange
        Event inputEvent = mock(Event.class);
        BaseEvent translatedEvent = mock(BaseEvent.class);

        // When the mock steps translate the event, return a mock translated event
        when(step1.translate(any(Event.class), any(TranslationContext.class))).thenReturn(Flowable.just(translatedEvent));
        when(step2.translate(any(Event.class), any(TranslationContext.class))).thenReturn(Flowable.empty());

        // The upstream flow of ADK events
        Flowable<Event> upstream = Flowable.just(inputEvent);

        // Act
        TestSubscriber<BaseEvent> testSubscriber = eventTranslator.apply(upstream).test();

        // Assert
        testSubscriber.assertValueCount(3); // Start + Translated Event + Finish
        testSubscriber.assertComplete();
        
        // Check that the first event is RunStartedEvent with correct IDs
        testSubscriber.assertValueAt(0, e -> 
            e instanceof RunStartedEvent 
            && ((RunStartedEvent) e).getThreadId().equals(threadId) 
            && ((RunStartedEvent) e).getRunId().equals(runId)
        );

        // Check that the last event is RunFinishedEvent with correct IDs
        testSubscriber.assertValueAt(2, e -> 
            e instanceof RunFinishedEvent 
            && ((RunFinishedEvent) e).getThreadId().equals(threadId) 
            && ((RunFinishedEvent) e).getRunId().equals(runId)
        );
    }
    @Test
    void shouldDelegateToAllSteps_whenTranslateIsCalled() {
        // Arrange
        Event inputEvent = mock(Event.class);
        // Ensure the inner steps don't emit anything to simplify verification
        when(step1.translate(any(Event.class), any(TranslationContext.class))).thenReturn(Flowable.empty());
        when(step2.translate(any(Event.class), any(TranslationContext.class))).thenReturn(Flowable.empty());

        // Act
        // We need to subscribe for the concatMap to execute
        eventTranslator.translate(inputEvent).test().assertComplete();

        // Assert
        // Verify that translate was called on each step
        verify(step1, times(1)).translate(inputEvent, context);
        verify(step2, times(1)).translate(inputEvent, context);
    }
    @Test
    void shouldDelegateToContext_whenDeferredEventsAreCleared() {
        // Arrange
        // We can have the mock context return a dummy list to make the test more complete
        when(context.getAndClearDeferredConfirmEvents()).thenReturn(List.of(mock(BaseEvent.class)));

        // Act
        List<BaseEvent> result = eventTranslator.getAndClearDeferredConfirmEvents();

        // Assert
        // Verify the call was delegated to the context
        verify(context, times(1)).getAndClearDeferredConfirmEvents();
        // Verify the result is what the context returned
        assertEquals(1, result.size());
    }

    // More tests will be added
}
